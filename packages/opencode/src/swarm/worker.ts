// Worker Parallax : détection du binaire, spawn, surveillance, arrêt propre.
//
// Le worker est lancé dans un process group dédié (POSIX) pour qu'on puisse
// tuer toute sa descendance d'un coup — Parallax fork des sous-process GPU
// (vLLM, SGLang, MLX) qui doivent mourir avec lui.

import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import * as Log from "@opencode-ai/core/util/log"
import { SWARM_DEFAULTS } from "./defaults"

const log = Log.create({ service: "swarm.worker" })

export type WorkerStatus =
  | { kind: "starting" }
  | { kind: "running"; pid: number }
  | { kind: "missing-binary" }
  | {
      kind: "exited"
      code: number | null
      signal: NodeJS.Signals | null
      runtimeMs: number
      output: string[]
    }
  | { kind: "error"; message: string }

export interface WorkerHandle {
  pid: number
  /** Stoppe proprement (SIGTERM puis SIGKILL après {@link SWARM_DEFAULTS.workerShutdownGraceMs}). Idempotent. */
  stop: () => Promise<void>
  /** Best-effort SIGTERM synchrone — utilisé dans process.on("exit"), où on n'a pas le droit d'await. */
  killSync: () => void
  /** Souscrit à la sortie du process (exit/signal). */
  onExit: (cb: (code: number | null, signal: NodeJS.Signals | null) => void) => void
}

export interface SpawnWorkerOptions {
  /** PeerID Lattica à passer à `parallax join -s`. */
  schedulerPeer: string
  /** Override du chemin vers le binaire parallax. Sinon : PATH + emplacements gérés. */
  binOverride?: string
  /** Si true, forward stdout/stderr du worker vers stderr (préfixé). */
  verbose?: boolean
  /** Callback de status (pour la TUI / logs au boot). */
  onStatus?: (s: WorkerStatus) => void
}

/**
 * Cherche le binaire parallax. Ordre :
 *   1. override explicite (si le fichier existe)
 *   2. emplacements gérés (~/.local/share/fabi/runtime/parallax)
 *   3. PATH (which/where)
 */
async function findParallaxBin(override?: string): Promise<string | null> {
  if (override) return existsSync(override) ? override : null

  const managed = findManagedBin()
  if (managed) return managed

  return await new Promise<string | null>((resolve) => {
    const which = process.platform === "win32" ? "where" : "which"
    const child = spawn(which, ["parallax"], { stdio: ["ignore", "pipe", "ignore"] })
    let out = ""
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString()
    })
    child.on("close", (code) => {
      if (code === 0) {
        const first = out
          .split(/\r?\n/)
          .map((s) => s.trim())
          .find(Boolean)
        resolve(first ?? null)
      } else resolve(null)
    })
    child.on("error", () => resolve(null))
  })
}

function findManagedBin(): string | null {
  const binary = process.platform === "win32" ? "parallax.exe" : "parallax"
  const dataRoot = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share")
  const venvBinDir = process.platform === "win32" ? "Scripts" : "bin"
  const candidates = [
    // Runtime bundlé dans les tarballs Fabi (priorité prod).
    join(dataRoot, "fabi", "runtime", "parallax-venv", venvBinDir, binary),
    // Install via fabi-installer (venv dans ~/.local/share/fabi/runtime/.venv/)
    join(dataRoot, "fabi", "runtime", ".venv", venvBinDir, binary),
    // Legacy : binaire posé directement dans runtime/ (par un installer custom)
    join(dataRoot, "fabi", "runtime", binary),
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return null
}

/**
 * Spawn le worker parallax. Renvoie null si le binaire n'est pas trouvé —
 * l'appelant doit alors continuer en mode "consumer only" (pas de contribution
 * swarm, mais inférence distante toujours possible).
 */
export async function spawnWorker(opts: SpawnWorkerOptions): Promise<WorkerHandle | null> {
  const { schedulerPeer, binOverride, verbose, onStatus } = opts
  onStatus?.({ kind: "starting" })

  const bin = await findParallaxBin(binOverride)
  if (!bin) {
    log.info("parallax binary not found")
    onStatus?.({ kind: "missing-binary" })
    return null
  }

  // `parallax join -s` veut une PeerID Lattica/multiaddr (pas une URL HTTP).
  const args = ["join", "-s", schedulerPeer]
  log.info("spawning parallax worker", { bin, args })

  const child: ChildProcess = spawn(bin, args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    env: process.env,
  })
  // Détacher du parent pour qu'on puisse tuer tout le process group d'un coup.
  child.unref?.()

  const pid = child.pid
  if (typeof pid !== "number") {
    onStatus?.({ kind: "error", message: "spawn parallax sans PID — échec immédiat" })
    return null
  }

  onStatus?.({ kind: "running", pid })

  const startedAt = Date.now()
  const lastOutput: string[] = []
  const rememberOutput = (prefix: string, chunk: Buffer): void => {
    const text = chunk.toString().trimEnd()
    if (!text) return
    for (const line of text.split(/\r?\n/)) {
      lastOutput.push(`${prefix}${line}`)
      if (lastOutput.length > 40) lastOutput.shift()
    }
  }

  if (verbose) {
    child.stdout?.on("data", (d: Buffer) => {
      rememberOutput("", d)
      const text = d.toString().trimEnd()
      if (text) process.stderr.write(`\x1b[2m[parallax] ${text}\x1b[0m\n`)
    })
    child.stderr?.on("data", (d: Buffer) => {
      rememberOutput("stderr: ", d)
      const text = d.toString().trimEnd()
      if (text) process.stderr.write(`\x1b[2m[parallax!] ${text}\x1b[0m\n`)
    })
  } else {
    // On lit les flux pour ne pas remplir le pipe et bloquer Parallax, tout en
    // gardant un petit ring buffer. Parallax peut sortir code=0 même après une
    // exception interne, donc ces lignes sont nécessaires pour diagnostiquer.
    child.stdout?.on("data", (d: Buffer) => rememberOutput("", d))
    child.stderr?.on("data", (d: Buffer) => rememberOutput("stderr: ", d))
  }

  const exitCallbacks: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = []
  let stopped = false
  child.on("close", (code, signal) => {
    const runtimeMs = Date.now() - startedAt
    if (stopped) {
      log.info("parallax worker stopped", { pid, code, signal, runtimeMs })
      for (const cb of exitCallbacks) cb(code, signal)
      return
    }
    log.warn("parallax worker exited unexpectedly", { pid, code, signal, runtimeMs })
    onStatus?.({ kind: "exited", code, signal, runtimeMs, output: lastOutput.slice(-12) })
    for (const cb of exitCallbacks) cb(code, signal)
  })
  child.on("error", (err) => {
    log.error("parallax worker error", { pid, error: err.message })
    onStatus?.({ kind: "error", message: err.message })
  })

  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    log.info("stopping parallax worker", { pid })

    return new Promise<void>((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        resolve()
      }
      child.once("close", finish)

      try {
        if (process.platform !== "win32") {
          // Négatif → tout le process group
          process.kill(-pid, "SIGTERM")
        } else {
          child.kill("SIGTERM")
        }
      } catch {
        // déjà mort
        finish()
        return
      }

      const grace = SWARM_DEFAULTS.workerShutdownGraceMs
      setTimeout(() => {
        if (done) return
        log.warn("parallax worker did not exit in time, sending SIGKILL", { pid, grace })
        try {
          if (process.platform !== "win32") process.kill(-pid, "SIGKILL")
          else child.kill("SIGKILL")
        } catch {
          /* déjà mort */
        }
        finish()
      }, grace).unref()
    })
  }

  // Best-effort sync kill (utilisé depuis process.on("exit") qui ne peut pas
  // await). On envoie juste SIGTERM, sans timer ni SIGKILL — l'OS finira si
  // Parallax ne réagit pas, et de toute façon le worker est detached/unref'd.
  const killSync = (): void => {
    if (stopped) return
    stopped = true
    try {
      if (process.platform !== "win32") process.kill(-pid, "SIGTERM")
      else child.kill("SIGTERM")
    } catch {
      /* déjà mort */
    }
  }

  return {
    pid,
    stop,
    killSync,
    onExit: (cb) => {
      exitCallbacks.push(cb)
    },
  }
}
