// Worker Parallax : détection du binaire, spawn, surveillance, arrêt propre.
//
// Le worker est lancé dans un process group dédié (POSIX) pour qu'on puisse
// tuer toute sa descendance d'un coup — Parallax fork des sous-process GPU
// (vLLM, SGLang, MLX) qui doivent mourir avec lui.

import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir, totalmem } from "node:os"
import { join } from "node:path"
import * as Log from "@opencode-ai/core/util/log"
import { SWARM_DEFAULTS } from "./defaults"

const log = Log.create({ service: "swarm.worker" })
const RESTART_DELAY_MS = 30_000

/**
 * Construit l'environnement pour le worker Parallax avec des defaults
 * adaptés à l'hôte. Sur Apple silicon avec mémoire unifiée partagée
 * (Mac mini / MacBook 16-32 GB), les defaults Parallax (max-batch-size=8,
 * max-sequence-length=32768) provoquent un OOM Metal au premier prompt
 * lourd : Metal alloue les buffers GPU à hauteur de batch × seq, ce qui
 * sur 16 GB de RAM unifiée dépasse ce que le driver accepte. On force
 * des limites conservatrices pour le single-user perso. Les valeurs déjà
 * définies par l'utilisateur sont respectées (FABI_* ou PARALLAX_*).
 */
function buildWorkerEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  const isAppleSilicon =
    process.platform === "darwin" && process.arch === "arm64"
  if (!isAppleSilicon) return env

  const ramGb = Math.round(totalmem() / 2 ** 30)
  // À 64 GB+ on suppose une station/serveur dédié, on garde les defaults Parallax.
  if (ramGb >= 64) return env

  const setIfUnset = (key: string, value: string) => {
    if (!env[key]?.trim()) env[key] = value
  }
  // Valeurs validées sur M4 16 GB. Pour 32 GB Apple silicon on relâche un peu.
  if (ramGb <= 24) {
    setIfUnset("PARALLAX_MAX_BATCH_SIZE", "1")
    setIfUnset("PARALLAX_MAX_SEQUENCE_LENGTH", "16384")
    setIfUnset("PARALLAX_MAX_NUM_TOKENS_PER_BATCH", "8192")
    setIfUnset("PARALLAX_SYSTEM_RESERVE_GB", "4")
  } else {
    setIfUnset("PARALLAX_MAX_BATCH_SIZE", "2")
    setIfUnset("PARALLAX_MAX_SEQUENCE_LENGTH", "32768")
    setIfUnset("PARALLAX_MAX_NUM_TOKENS_PER_BATCH", "16384")
    setIfUnset("PARALLAX_SYSTEM_RESERVE_GB", "6")
  }
  return env
}

/**
 * Tue les workers Parallax orphelins qui pourraient avoir survécu à un
 * crash précédent de fabi (TUI freeze, kill -9 du parent sans cleanup).
 * Le `detached: true` du spawn rend ces processus indépendants ; sans
 * cleanup pré-spawn on se retrouve avec deux workers en parallèle qui
 * se partagent la RAM et provoquent un OOM Metal sur Apple silicon.
 */
function killOrphanedWorkers(currentPid: number): void {
  if (process.platform === "win32") return
  // pgrep -f matche n'importe quel argument de la ligne de commande, on cible
  // explicitement le launch.py pour ne pas attraper d'autres outils homonymes.
  const r = spawnSync("pgrep", ["-f", "parallax/launch.py"], {
    encoding: "utf8",
  })
  if (r.status !== 0 || !r.stdout) return
  const pids = r.stdout
    .split(/\s+/)
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n !== currentPid && n !== process.pid)
  if (pids.length === 0) return
  log.warn("found orphaned parallax workers, terminating", { pids })
  for (const orphan of pids) {
    try {
      process.kill(-orphan, "SIGTERM")
    } catch {
      try {
        process.kill(orphan, "SIGTERM")
      } catch {
        /* déjà mort */
      }
    }
  }
  // Court délai puis SIGKILL si toujours en vie. spawnSync sleep car on est
  // dans une fonction synchrone appelée juste avant le spawn.
  spawnSync("sh", ["-c", "sleep 2"])
  for (const orphan of pids) {
    try {
      process.kill(-orphan, "SIGKILL")
    } catch {
      /* déjà mort */
    }
  }
}

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

  // Avant de spawn, nettoie d'éventuels workers orphelins d'un précédent
  // crash de fabi. Sans ça, les processes detached survivent et on se
  // retrouve avec deux workers en concurrence sur la même RAM (cas réel
  // observé sur Mac mini M4 → OOM Metal).
  killOrphanedWorkers(process.pid)

  // `parallax join -s` veut une PeerID Lattica/multiaddr (pas une URL HTTP).
  const args = ["join", "-s", schedulerPeer]
  const exitCallbacks: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = []
  let stopped = false
  let child: ChildProcess | null = null
  let pid = 0
  let restartTimer: NodeJS.Timeout | null = null

  const startChild = (): boolean => {
    onStatus?.({ kind: "starting" })
    log.info("spawning parallax worker", { bin, args })

    const next = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env: buildWorkerEnv(),
    })
    next.unref?.()

    const nextPid = next.pid
    if (typeof nextPid !== "number") {
      onStatus?.({ kind: "error", message: "spawn parallax sans PID — échec immédiat" })
      return false
    }

    child = next
    pid = nextPid
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
      next.stdout?.on("data", (d: Buffer) => {
        rememberOutput("", d)
        const text = d.toString().trimEnd()
        if (text) process.stderr.write(`\x1b[2m[parallax] ${text}\x1b[0m\n`)
      })
      next.stderr?.on("data", (d: Buffer) => {
        rememberOutput("stderr: ", d)
        const text = d.toString().trimEnd()
        if (text) process.stderr.write(`\x1b[2m[parallax!] ${text}\x1b[0m\n`)
      })
    } else {
      // On lit les flux pour ne pas remplir le pipe et bloquer Parallax, tout en
      // gardant un petit ring buffer. Parallax peut sortir code=0 même après une
      // exception interne, donc ces lignes sont nécessaires pour diagnostiquer.
      next.stdout?.on("data", (d: Buffer) => rememberOutput("", d))
      next.stderr?.on("data", (d: Buffer) => rememberOutput("stderr: ", d))
    }

    next.on("close", (code, signal) => {
      const runtimeMs = Date.now() - startedAt
      if (stopped) {
        log.info("parallax worker stopped", { pid: nextPid, code, signal, runtimeMs })
        for (const cb of exitCallbacks) cb(code, signal)
        return
      }

      log.warn("parallax worker exited unexpectedly", { pid: nextPid, code, signal, runtimeMs })
      onStatus?.({ kind: "exited", code, signal, runtimeMs, output: lastOutput.slice(-12) })
      for (const cb of exitCallbacks) cb(code, signal)

      restartTimer = setTimeout(() => {
        restartTimer = null
        if (!stopped) startChild()
      }, RESTART_DELAY_MS)
      restartTimer.unref()
    })
    next.on("error", (err) => {
      log.error("parallax worker error", { pid: nextPid, error: err.message })
      onStatus?.({ kind: "error", message: err.message })
    })

    return true
  }

  if (!startChild()) return null

  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    if (restartTimer) clearTimeout(restartTimer)
    const current = child
    const currentPid = pid
    if (!current || !currentPid) return
    log.info("stopping parallax worker", { pid })

    return new Promise<void>((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        resolve()
      }
      current.once("close", finish)

      try {
        if (process.platform !== "win32") {
          // Négatif → tout le process group
          process.kill(-currentPid, "SIGTERM")
        } else {
          current.kill("SIGTERM")
        }
      } catch {
        // déjà mort
        finish()
        return
      }

      const grace = SWARM_DEFAULTS.workerShutdownGraceMs
      setTimeout(() => {
        if (done) return
        log.warn("parallax worker did not exit in time, sending SIGKILL", { pid: currentPid, grace })
        try {
          if (process.platform !== "win32") process.kill(-currentPid, "SIGKILL")
          else current.kill("SIGKILL")
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
    if (restartTimer) clearTimeout(restartTimer)
    const current = child
    const currentPid = pid
    if (!current || !currentPid) return
    try {
      if (process.platform !== "win32") process.kill(-currentPid, "SIGTERM")
      else current.kill("SIGTERM")
    } catch {
      /* déjà mort */
    }
  }

  return {
    get pid() {
      return pid
    },
    stop,
    killSync,
    onExit: (cb) => {
      exitCallbacks.push(cb)
    },
  }
}
