// Worker Parallax : détection du binaire, spawn, surveillance, arrêt propre.
//
// Le worker est lancé dans un process group dédié (POSIX) pour qu'on puisse
// tuer toute sa descendance d'un coup — Parallax fork des sous-process GPU
// (vLLM, SGLang, MLX) qui doivent mourir avec lui.

import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { homedir, totalmem } from "node:os"
import { join } from "node:path"
import * as Log from "@opencode-ai/core/util/log"
import { getAccountToken } from "./account-token"
import { SWARM_DEFAULTS } from "./defaults"
import { FabiEventStream } from "./events"
import { inspectManagedSource } from "./installer"

const log = Log.create({ service: "swarm.worker" })
const RESTART_DELAY_MS = 30_000

/**
 * Limites worker à passer explicitement à `parallax join`. Marche avec
 * upstream Parallax ET notre fork — `parallax/cli.py` utilise
 * `parser.parse_known_args()` puis cherche les flags via `_flag_present`
 * avant d'injecter ses propres defaults. Donc tout flag passé ici prend
 * précédence sur les hardcodes upstream (4096 / 7168 / 8 / 32).
 *
 * Pourquoi côté CLI plutôt que via env var : le fork lit
 * `PARALLAX_MAX_*` depuis `cli.py`, mais si l'user a un binaire `parallax`
 * d'upstream (PyPI, brew, ancien venv), il NE lit PAS ces env vars et
 * retombe sur les defaults rachitiques d'upstream. Passer en CLI args
 * neutralise cette ambiguïté : peu importe le binaire installé, il
 * accepte les flags de la même manière (argparse standard).
 */
interface WorkerLimits {
  maxBatchSize: string
  maxSequenceLength: string
  maxNumTokensPerBatch: string
  kvBlockSize: string
}

/**
 * Accélérateur effectif du nœud. On dérive les limites worker de ça :
 *  - `apple-silicon` : mémoire unifiée partagée (Metal sur la RAM OS).
 *  - `cuda` : VRAM dédiée NVIDIA (natif Linux OU Windows via WSL — dans les
 *    deux cas `process.platform === "linux"` et `nvidia-smi` est présent).
 *  - `generic` : CPU / GPU non détecté → defaults prudents Fabi.
 */
export type Accelerator = "apple-silicon" | "cuda" | "generic"

export interface HardwareProfile {
  accelerator: Accelerator
  /** RAM système en GB (Apple Silicon : mémoire unifiée). */
  ramGb: number
  /** VRAM totale du plus petit GPU CUDA détecté, en GB (undefined si non-CUDA). */
  vramGb?: number
}

/**
 * Minimum host RAM kept for the OS and foreground applications.
 *
 * This is a floor, not the worker allocation: the engine also samples live
 * `available` memory before loading anything.  Keeping the policy pure here
 * makes packaged workers and tests agree across macOS, Windows and Linux while
 * still allowing an explicit env override. The engine combines this policy
 * with psutil's live `available` counter; this value is never treated as the
 * amount a worker should allocate.
 */
export function resolveHostSystemReserveGb(ramGb: number): number {
  return Math.min(12, Math.max(6, Math.ceil(Math.max(0, ramGb) * 0.25)))
}

/** Dedicated VRAM kept for the display driver and other GPU applications. */
export function resolveCudaSystemReserveGb(vramGb: number): number {
  return Math.round(Math.max(0, vramGb)) <= 12 ? 2 : 1.5
}

/** Pure cross-platform policy applied only when the user did not override it. */
export function resolveMemoryReserveEnv(hw: HardwareProfile): Record<string, string> {
  const result = {
    PARALLAX_SYSTEM_RESERVE_GB: String(resolveHostSystemReserveGb(hw.ramGb)),
  }
  if (hw.accelerator === "cuda" && hw.vramGb !== undefined) {
    return {
      ...result,
      PARALLAX_CUDA_SYSTEM_RESERVE_GB: String(resolveCudaSystemReserveGb(hw.vramGb)),
    }
  }
  return result
}

// Defaults Fabi (validés dans le fork patch 545a902). Conviennent à un agentic
// CLI : prompts >4k tokens fréquents, peu de concurrence parallèle.
const FABI_DEFAULT_LIMITS: WorkerLimits = {
  maxBatchSize: "2",
  maxSequenceLength: "32768",
  maxNumTokensPerBatch: "8192",
  kvBlockSize: "32",
}

/**
 * Calcule les limites worker à partir d'un profil matériel — **fonction pure**
 * (testable sans hardware). La taille du KV cache scale en `batch × sequence`,
 * c'est l'équivalent du `attn_cache_tokens` de Petals : sur une machine de
 * travail (desktop + browser actifs), des limites trop hautes saturent la
 * mémoire de l'accélérateur dès le premier prefill et freezent le poste.
 *
 * Tiers Apple Silicon = sur la RAM unifiée (Metal partage la RAM OS).
 * Tiers CUDA = sur la VRAM dédiée (le KV cache vit dans la VRAM, en plus des
 * poids ; `cuda_memory.py` côté moteur borne déjà la *fraction* allouable façon
 * `gpu_memory_utilization` vLLM, mais ne réduit pas le besoin batch × seq).
 */
export function resolveWorkerLimits(hw: HardwareProfile): WorkerLimits {
  if (hw.accelerator === "apple-silicon" && hw.ramGb < 64) {
    // Mémoire unifiée : à batch=8 / seq=32768 on flingue 16 GB unifiés au
    // premier prefill (RAM OS + browser sur le même pool).
    if (hw.ramGb <= 24) {
      return { maxBatchSize: "1", maxSequenceLength: "32768", maxNumTokensPerBatch: "4096", kvBlockSize: "32" }
    }
    return { maxBatchSize: "1", maxSequenceLength: "32768", maxNumTokensPerBatch: "8192", kvBlockSize: "32" }
  }

  if (hw.accelerator === "cuda" && hw.vramGb !== undefined) {
    // Tiers VRAM consumer/workstation NVIDIA. En dessous de 24 GB on borne
    // batch × seq pour garder de la VRAM au desktop/affichage et éviter l'OOM
    // CUDA sous charge. ≥24 GB (3090/4090/A6000…) → defaults pleins.
    // On arrondit au GB : nvidia-smi reporte la VRAM "utile" (ex. 24564 MiB ≈
    // 23.99 GB pour une 4090), un seuil strict la ferait chuter d'un tier.
    const vram = Math.round(hw.vramGb)
    if (vram <= 8) {
      // 3050/4050 laptop, 3060 8 GB : le strict minimum jouable.
      return { maxBatchSize: "1", maxSequenceLength: "32768", maxNumTokensPerBatch: "4096", kvBlockSize: "16" }
    }
    if (vram <= 12) {
      // 3060 12 GB, 4070.
      return { maxBatchSize: "1", maxSequenceLength: "32768", maxNumTokensPerBatch: "4096", kvBlockSize: "32" }
    }
    if (vram <= 16) {
      // 4060 Ti 16 GB, 4070 Ti SUPER.
      return { maxBatchSize: "1", maxSequenceLength: "32768", maxNumTokensPerBatch: "8192", kvBlockSize: "32" }
    }
    if (vram < 24) {
      // 3080 20 GB / cartes 20-23 GB.
      return { maxBatchSize: "1", maxSequenceLength: "32768", maxNumTokensPerBatch: "8192", kvBlockSize: "32" }
    }
  }

  return { ...FABI_DEFAULT_LIMITS }
}

/**
 * VRAM totale (GB) du plus petit GPU NVIDIA visible, via `nvidia-smi`.
 * On prend le min en multi-GPU pour rester conservateur (Parallax peut
 * pipeliner sur la plus petite carte). Renvoie undefined si nvidia-smi est
 * absent ou n'a rien retourné d'exploitable.
 */
function detectCudaVramGb(): number | undefined {
  const r = spawnSync("nvidia-smi", ["--query-gpu=memory.total", "--format=csv,noheader,nounits"], {
    encoding: "utf8",
    timeout: 5000,
  })
  if (r.status !== 0 || !r.stdout) return undefined
  const mibValues = r.stdout
    .split(/\r?\n/)
    .map((l) => parseInt(l.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0)
  if (mibValues.length === 0) return undefined
  return Math.min(...mibValues) / 1024
}

/** Détecte le profil matériel effectif (avec appel hardware pour CUDA). */
function detectHardware(): HardwareProfile {
  const ramGb = Math.round(totalmem() / 2 ** 30)
  if (process.platform === "darwin" && process.arch === "arm64") {
    return { accelerator: "apple-silicon", ramGb }
  }
  // Natif Linux+NVIDIA ET Windows→WSL CUDA exposent tous deux nvidia-smi.
  const vramGb = detectCudaVramGb()
  if (vramGb !== undefined) return { accelerator: "cuda", ramGb, vramGb }
  return { accelerator: "generic", ramGb }
}

// Le profil matériel ne change pas pendant la session — on mémoïse pour ne pas
// re-shell nvidia-smi à chaque (re)spawn du worker.
let cachedHardware: HardwareProfile | null = null
function getHardware(): HardwareProfile {
  if (!cachedHardware) cachedHardware = detectHardware()
  return cachedHardware
}

function pickWorkerLimits(): WorkerLimits {
  const hw = getHardware()
  const limits = resolveWorkerLimits(hw)
  log.info("worker hardware profile", { ...hw })

  // L'user peut tout overrider via env (la TUI ou un script wrapper).
  return {
    maxBatchSize: process.env.PARALLAX_MAX_BATCH_SIZE?.trim() || limits.maxBatchSize,
    maxSequenceLength: process.env.PARALLAX_MAX_SEQUENCE_LENGTH?.trim() || limits.maxSequenceLength,
    maxNumTokensPerBatch: process.env.PARALLAX_MAX_NUM_TOKENS_PER_BATCH?.trim() || limits.maxNumTokensPerBatch,
    kvBlockSize: process.env.PARALLAX_KV_BLOCK_SIZE?.trim() || limits.kvBlockSize,
  }
}

/**
 * Env supplémentaire pour le worker (réserve mémoire système etc.). Les
 * limites de batch/sequence sont passées en CLI args (cf. `pickWorkerLimits`).
 */
function buildWorkerEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  const hw = getHardware()
  const setIfUnset = (key: string, value: string) => {
    if (!env[key]?.trim()) env[key] = value
  }

  // Jeton de compte pour la porte de contribution : contribuer avec ce compte
  // débloque la consommation (« tu contribues = tu consommes »). Même fichier
  // que l'apiKey du provider → un seul compte CLI+IDE.
  setIfUnset("FABI_ACCOUNT_TOKEN", getAccountToken())
  setIfUnset(
    "PARALLAX_KEY_PATH",
    join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "fabi", "identity"),
  )
  // A stable peer id restores the shard; this per-process epoch fences stale RPCs.
  env.FABI_WORKER_SESSION_ID = randomUUID()

  // The engine samples host RAM on every OS and VRAM on every CUDA device.
  // Keep the product policy in one pure function, while preserving explicit
  // user/admin overrides from the process environment.
  for (const [key, value] of Object.entries(resolveMemoryReserveEnv(hw))) {
    setIfUnset(key, value)
  }
  return env
}

/**
 * Active le prefix cache (réutilisation du KV cache pour les préfixes communs,
 * le `BlockRadixCache` du fork — équivalent RadixAttention sglang). Le moteur
 * l'implémente sur tous les backends (MLX/sglang/vLLM) mais le laisse OFF par
 * défaut. Pour un CLI agentique c'est LE gros gain : le system prompt + tout
 * l'historique de conversation sont identiques d'un tour à l'autre, donc le
 * prefill est quasi gratuit après le premier message (first-token latency qui
 * s'effondre, 50-99% de hit selon la charge). On l'active par défaut et on
 * laisse un opt-out env pour les nœuds très contraints en mémoire.
 */
export function prefixCacheEnabled(): boolean {
  const raw = process.env.FABI_PREFIX_CACHE?.trim().toLowerCase()
  if (raw === undefined || raw === "") return true
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "no")
}

/** Parallax enables prefix caching by default; only pass its explicit opt-out. */
export function prefixCacheArgs(enabled = prefixCacheEnabled()): string[] {
  return enabled ? [] : ["--disable-prefix-cache"]
}

/** Select the GPU runtime that is actually bundled for the host platform. */
export function gpuBackendArgs(platform: NodeJS.Platform = process.platform): string[] {
  // The native Windows runtime ships vLLM-Windows; SGLang is not supported by
  // that package. Keep the choice explicit so Parallax never falls back to its
  // Linux-oriented default on Windows.
  return platform === "win32" ? ["--gpu-backend", "vllm"] : []
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

  // Diagnostic explicite : on logge le chemin résolu + la version du clone
  // source du fork. Sans ça, un user qui a un `parallax` upstream dans son
  // PATH ou un clone obsolète tourne avec les anciens defaults
  // (--max-num-tokens-per-batch 4096, --max-sequence-length 7168) et passe
  // des heures à se demander pourquoi il a des bugs déjà corrigés. Le
  // refresh paresseux du clone se fait dans installer.ts ; ici on lit juste
  // l'état pour le rendre visible.
  const fabiRuntimeRoot = join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "fabi", "runtime")
  const isManagedBin = bin.startsWith(fabiRuntimeRoot)
  const sourceState = await inspectManagedSource().catch(() => null)
  log.info("spawning parallax worker", {
    bin,
    isManagedBin,
    sourceCommit: sourceState?.afterSha ?? sourceState?.beforeSha ?? null,
    sourceUpdated: sourceState?.updated ?? false,
  })
  if (!isManagedBin) {
    log.warn(
      "parallax bin is OUTSIDE the fabi-managed runtime — patches Fabi (heartbeat, scheduler cancel-fix) absent. Worker limits are still passed via CLI args, so batch/seq sizing remains correct.",
      { bin, expectedRoot: fabiRuntimeRoot },
    )
  }

  // Avant de spawn, nettoie d'éventuels workers orphelins d'un précédent
  // crash de fabi. Sans ça, les processes detached survivent et on se
  // retrouve avec deux workers en concurrence sur la même RAM (cas réel
  // observé sur Mac mini M4 → OOM Metal).
  killOrphanedWorkers(process.pid)

  // Passer les limites en CLI args APRÈS `-s peer` : elles tombent dans
  // `passthrough_args` côté `parallax/cli.py` (parser.parse_known_args),
  // ce qui shorte les hardcodes upstream (4096 / 7168 / 8 / 32) qui ne
  // s'injectent que si le flag n'est pas déjà présent.
  const limits = pickWorkerLimits()
  const args = [
    "join",
    "-s",
    schedulerPeer,
    "-r",
    "--max-batch-size",
    limits.maxBatchSize,
    "--max-sequence-length",
    limits.maxSequenceLength,
    "--max-num-tokens-per-batch",
    limits.maxNumTokensPerBatch,
    "--kv-block-size",
    limits.kvBlockSize,
  ]
  const prefixCache = prefixCacheEnabled()
  args.push(...prefixCacheArgs(prefixCache))
  args.push(...gpuBackendArgs())
  log.info("worker limits resolved", {
    limits,
    prefixCache,
    gpuBackend: process.platform === "win32" ? "vllm" : "default",
  })
  const exitCallbacks: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = []
  let stopped = false
  let child: ChildProcess | null = null
  let pid = 0
  let restartTimer: NodeJS.Timeout | null = null

  const startChild = (): boolean => {
    onStatus?.({ kind: "starting" })
    log.info("starting parallax worker child", { args })

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
    const rememberOutput = (prefix: string, line: string): void => {
      if (!line) return
      lastOutput.push(`${prefix}${line}`)
      if (lastOutput.length > 40) lastOutput.shift()
    }

    // Parser stdout — les events `[FABI] {...}` sont absorbés et propagés
    // dans le state singleton, le reste est buffer-isé pour le ring + verbose.
    // (Seul stdout porte les events ; stderr garde le ring buffer brut.)
    const stdoutParser = new FabiEventStream((line) => {
      rememberOutput("", line)
      if (verbose) process.stderr.write(`\x1b[2m[parallax] ${line}\x1b[0m\n`)
    })

    next.stdout?.on("data", (d: Buffer) => stdoutParser.ingest(d))
    next.stderr?.on("data", (d: Buffer) => {
      const text = d.toString().trimEnd()
      if (!text) return
      for (const line of text.split(/\r?\n/)) {
        rememberOutput("stderr: ", line)
        if (verbose) process.stderr.write(`\x1b[2m[parallax!] ${line}\x1b[0m\n`)
      }
    })

    next.on("close", (code, signal) => {
      // Vide le buffer du parser pour ne pas perdre un éventuel dernier event
      // (alloc_timeout, weights_load_done) émis juste avant un exit/SIGTERM.
      stdoutParser.flush()
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

  // Filet de sécurité synchrone (utilisé depuis process.on("exit") qui ne peut
  // pas await). On envoie SIGKILL — pas SIGTERM — pour garantir que rien ne
  // survit : SIGKILL ne peut pas être catché ni ignoré, contrairement à
  // SIGTERM que Parallax/MLX/vLLM peuvent retarder (ex: au milieu d'une
  // allocation Metal). Le worker est spawné avec detached:true + unref donc
  // sans SIGKILL forcé, il devient orphelin et continue à pomper le GPU.
  //
  // La perte du shutdown gracieux Parallax (pas de "leaving" envoyé au
  // scheduler) est compensée par le heartbeat timeout côté scheduler
  // (PARALLAX_HEARTBEAT_TIMEOUT, 25s par défaut) : le peer disparaît tout
  // seul de la liste après ce délai. Pas l'idéal, mais acceptable.
  //
  // Le chemin nominal (async, gracieux) passe par `stop()` ci-dessus qui
  // tente SIGTERM puis SIGKILL avec un grace period configurable. killSync
  // n'est appelé que si le chemin async n'a pas été pris (process.exit
  // direct dans un handler).
  const killSync = (): void => {
    if (stopped) return
    stopped = true
    if (restartTimer) clearTimeout(restartTimer)
    const current = child
    const currentPid = pid
    if (!current || !currentPid) return
    try {
      if (process.platform !== "win32") process.kill(-currentPid, "SIGKILL")
      else current.kill("SIGKILL")
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
