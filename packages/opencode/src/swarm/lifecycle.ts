// Lifecycle du swarm : orchestration boot → worker → shutdown.
//
// Ce module est appelé depuis `src/index.ts` quand la commande lancée fait
// effectivement de l'inférence (TUI, run, serve). Pour les commandes
// utilitaires (models, auth, providers, ...) on n'a pas besoin du worker.
//
// Trois rôles :
//   1. Décider si le swarm doit démarrer (selon commande + flags + env)
//   2. Healthcheck scheduler + spawn worker (non bloquant en cas de pépin)
//   3. Garantir la cleanup à l'exit (signaux + finally)

import * as Log from "@opencode-ai/core/util/log"
import { SWARM_DEFAULTS } from "./defaults"
import { checkScheduler, type SchedulerInfo } from "./scheduler"
import { spawnWorker, type WorkerHandle, type WorkerStatus } from "./worker"
import { tryInstallParallax, type InstallResult } from "./installer"
import { discoverSwarm, type DiscoverResult, type RegistrySwarm } from "./registry"

const log = Log.create({ service: "swarm.lifecycle" })

// ---------------------------------------------------------------------------
// Configuration runtime
// ---------------------------------------------------------------------------

export interface SwarmRuntime {
  /** URL du registry pour l'auto-discovery (peut être vide pour skip). */
  registryUrl: string
  /** URL HTTP du scheduler — utilisée pour healthcheck ET pour le provider. */
  schedulerUrl: string
  /** PeerID Lattica — passée à `parallax join -s`. */
  schedulerPeer: string
  /** ID du swarm préféré (si fourni explicitement, skip auto-pick). */
  preferredSwarmId?: string
  /** Modèle préféré (filtre si plusieurs swarms). */
  preferredModel?: string
  /** Si true : pas de spawn worker (mode consumer-only, dev / debug). */
  noParallax: boolean
  /** Forward stdout/stderr du worker vers stderr. */
  verbose: boolean
  /** Override du chemin parallax. */
  parallaxBin?: string
  /** Si true : on n'essaie pas le registry, on prend les défauts/env directement. */
  skipRegistry: boolean
}

/**
 * Résout la config runtime depuis l'environnement (et plus tard depuis la config user).
 *
 * Précédence : env > défauts. Les flags CLI sont injectés par le code appelant
 * via `overrides`.
 */
export function resolveSwarmRuntime(overrides: Partial<SwarmRuntime> = {}): SwarmRuntime {
  const fromEnv = (key: string) => process.env[key]?.trim() || undefined
  const env = {
    registryUrl: fromEnv("FABI_REGISTRY"),
    schedulerUrl: fromEnv("FABI_SCHEDULER"),
    schedulerPeer: fromEnv("FABI_SCHEDULER_PEER"),
    preferredSwarmId: fromEnv("FABI_SWARM"),
    preferredModel: fromEnv("FABI_SWARM_MODEL"),
    parallaxBin: fromEnv("FABI_PARALLAX_BIN"),
    noParallax: fromEnv("FABI_NO_PARALLAX") === "1",
    verbose: fromEnv("FABI_VERBOSE") === "1",
    skipRegistry: fromEnv("FABI_NO_REGISTRY") === "1",
  }
  return {
    registryUrl: overrides.registryUrl ?? env.registryUrl ?? SWARM_DEFAULTS.registry,
    schedulerUrl: overrides.schedulerUrl ?? env.schedulerUrl ?? SWARM_DEFAULTS.scheduler,
    schedulerPeer: overrides.schedulerPeer ?? env.schedulerPeer ?? SWARM_DEFAULTS.schedulerPeer,
    preferredSwarmId: overrides.preferredSwarmId ?? env.preferredSwarmId,
    preferredModel: overrides.preferredModel ?? env.preferredModel,
    noParallax: overrides.noParallax ?? env.noParallax,
    verbose: overrides.verbose ?? env.verbose,
    parallaxBin: overrides.parallaxBin ?? env.parallaxBin,
    // Si l'utilisateur fournit un peer ID en dur (flag/env) on respecte ce choix
    // et on skip le registry. Idem si flag --no-registry / FABI_NO_REGISTRY=1.
    skipRegistry:
      overrides.skipRegistry ??
      env.skipRegistry ??
      Boolean(env.schedulerPeer),
  }
}

// ---------------------------------------------------------------------------
// Décision : faut-il démarrer le swarm pour cette commande ?
// ---------------------------------------------------------------------------

/**
 * Liste des commandes yargs (top-level) pour lesquelles on démarre le swarm.
 *
 * `undefined` représente la commande par défaut (`$0` = TUI principale).
 * Les autres commandes (models, auth, providers, upgrade, ...) sont utilitaires
 * et ne déclenchent pas l'inférence : on les ignore pour économiser les
 * ressources et accélérer leur démarrage.
 */
const SWARM_COMMANDS: ReadonlySet<string | undefined> = new Set([
  undefined, // $0 → TUI default
  "run",
  "serve",
])

/** Renvoie true si la commande yargs déclenchée doit allumer le swarm. */
export function shouldStartSwarm(commandName: string | undefined): boolean {
  return SWARM_COMMANDS.has(commandName)
}

// ---------------------------------------------------------------------------
// Démarrage et cleanup
// ---------------------------------------------------------------------------

export interface SwarmHandle {
  scheduler: SchedulerInfo
  worker: WorkerHandle | null
  /** Stoppe proprement le worker (idempotent). */
  shutdown: () => Promise<void>
}

/** État global, utilisé par le finally de index.ts pour kill le worker à l'exit. */
let active: SwarmHandle | null = null
let signalsAttached = false

/**
 * Attache les handlers de signaux pour cleanup le worker.
 *
 * Idempotent : ne s'attache qu'une fois par process. On ne `process.exit()`
 * pas nous-mêmes — on se contente de kill le worker, le code appelant gère
 * la sortie (la TUI a son propre handler signal qui exit le main process).
 */
function attachSignalHandlers(): void {
  if (signalsAttached) return
  signalsAttached = true

  const onSignal = (sig: NodeJS.Signals) => {
    log.info("received signal, shutting swarm worker", { signal: sig })
    // fire-and-forget : la TUI/CLI va exit séparément
    void shutdownActive()
  }
  process.on("SIGINT", () => onSignal("SIGINT"))
  process.on("SIGTERM", () => onSignal("SIGTERM"))
  process.on("SIGHUP", () => onSignal("SIGHUP"))
}

/**
 * Erreur levée quand un worker Parallax est requis pour la commande lancée
 * mais n'a pas pu être démarré (binaire manquant ou crash immédiat).
 *
 * **Philosophie Fabi** : pas de free-riding. Tu utilises le swarm = tu y
 * contribues. Le seul moyen d'utiliser Fabi sans worker est le flag dev
 * `--no-parallax`, réservé aux contributeurs du fork.
 */
export class SwarmWorkerRequiredError extends Error {
  constructor(public readonly reason: "missing-binary" | "spawn-failed") {
    super(`Worker Parallax requis mais ${reason}`)
    this.name = "SwarmWorkerRequiredError"
  }
}

/**
 * Démarre le swarm : healthcheck + spawn worker.
 *
 * - Le healthcheck scheduler est non-bloquant (informatif)
 * - Le spawn worker est **bloquant** : si Parallax n'est pas installé et
 *   que `--no-parallax` n'a pas été passé, on throw {@link SwarmWorkerRequiredError}.
 *   L'appelant (middleware yargs dans `src/index.ts`) doit afficher les
 *   instructions d'install et `process.exit(1)`.
 *
 * @param onStatus callback de status pour affichage live (UI au boot)
 */
export async function startSwarm(
  runtime: SwarmRuntime,
  onStatus: (event: SwarmStartEvent) => void = () => {},
): Promise<SwarmHandle> {
  // 0. Auto-discovery via le registry (sauf si l'utilisateur a forcé un peer
  // ou désactivé le registry). On résout schedulerUrl + schedulerPeer ici ;
  // les défauts hardcodés ne servent plus que de fallback.
  const resolved = await resolveFromRegistry(runtime, onStatus)
  const effectiveUrl = resolved.schedulerUrl
  const effectivePeer = resolved.schedulerPeer

  // 1. Healthcheck scheduler — informatif, jamais bloquant
  const scheduler = await checkScheduler(effectiveUrl, SWARM_DEFAULTS.healthcheckTimeoutMs)
  onStatus({ kind: "scheduler", info: scheduler, url: effectiveUrl })

  // 2. Worker — REQUIS sauf en mode dev (--no-parallax)
  let worker: WorkerHandle | null = null
  if (runtime.noParallax) {
    onStatus({ kind: "worker-disabled" })
  } else {
    const spawn = async (binOverride?: string): Promise<{
      worker: WorkerHandle | null
      lastStatusKind: WorkerStatus["kind"] | null
    }> => {
      let lastStatusKind: WorkerStatus["kind"] | null = null
      const w = await spawnWorker({
        schedulerPeer: effectivePeer,
        binOverride: binOverride ?? runtime.parallaxBin,
        verbose: runtime.verbose,
        onStatus: (s) => {
          lastStatusKind = s.kind
          onStatus({ kind: "worker", status: s })
        },
      })
      return { worker: w, lastStatusKind }
    }

    // Premier essai : binaire dans le PATH ou dans l'install Fabi gérée
    let result = await spawn()

    // Si le binaire est absent, on PROPOSE de l'installer (interactif).
    if (!result.worker && result.lastStatusKind === "missing-binary") {
      onStatus({ kind: "installer-prompt" })
      const installResult = await tryInstallParallax()
      onStatus({ kind: "installer-result", result: installResult })

      if (installResult.ok) {
        // Re-spawn avec le binaire fraîchement installé
        result = await spawn(installResult.binPath)
        if (!result.worker) {
          throw new SwarmWorkerRequiredError("spawn-failed")
        }
        worker = result.worker
      } else {
        // Install refusée ou échouée : pas de mode consumer-only.
        throw new SwarmWorkerRequiredError("missing-binary")
      }
    } else if (!result.worker) {
      throw new SwarmWorkerRequiredError("spawn-failed")
    } else {
      worker = result.worker
    }
  }

  let stopped = false
  const handle: SwarmHandle = {
    scheduler,
    worker,
    shutdown: async () => {
      if (stopped) return
      stopped = true
      if (worker) await worker.stop()
      if (active === handle) active = null
    },
  }

  active = handle
  attachSignalHandlers()
  return handle
}

/**
 * Arrête le swarm actif, s'il y en a un. À appeler dans le `finally`
 * de l'entry point pour garantir qu'aucun worker n'est laissé en arrière-plan.
 */
export async function shutdownActive(): Promise<void> {
  if (!active) return
  await active.shutdown()
}

/**
 * Filet de sécurité synchrone pour `process.on("exit", ...)` :
 * envoie SIGTERM au worker sans pouvoir await la fin. Utilisé quand un
 * handler de commande appelle `process.exit()` directement et que le
 * `finally` async global ne pourrait pas s'exécuter.
 */
export function shutdownActiveSync(): void {
  if (!active || !active.worker) return
  active.worker.killSync()
  active = null
}

// ---------------------------------------------------------------------------
// Events de status pour affichage UI
// ---------------------------------------------------------------------------

export type SwarmStartEvent =
  | { kind: "discovery"; result: DiscoverResult }
  | { kind: "discovery-skipped"; reason: "no-registry" | "explicit-peer" }
  | { kind: "discovery-fallback"; reason: string }
  | { kind: "scheduler"; info: SchedulerInfo; url: string }
  | { kind: "worker"; status: WorkerStatus }
  | { kind: "worker-disabled" }
  | { kind: "installer-prompt" }
  | { kind: "installer-result"; result: InstallResult }

// ---------------------------------------------------------------------------
// Auto-discovery via le registry
// ---------------------------------------------------------------------------

interface ResolvedSwarm {
  schedulerUrl: string
  schedulerPeer: string
  /** L'entrée registry choisie, si la résolution a abouti via registry. */
  registryEntry: RegistrySwarm | null
}

/**
 * Résout `schedulerUrl` et `schedulerPeer` finaux à utiliser, en privilégiant
 * le registry. Le runtime contient déjà des valeurs résolues depuis env/flags ;
 * le registry permet de les rafraîchir dynamiquement.
 */
async function resolveFromRegistry(
  runtime: SwarmRuntime,
  onStatus: (event: SwarmStartEvent) => void,
): Promise<ResolvedSwarm> {
  if (runtime.skipRegistry || !runtime.registryUrl) {
    onStatus({
      kind: "discovery-skipped",
      reason: runtime.skipRegistry ? "explicit-peer" : "no-registry",
    })
    return {
      schedulerUrl: runtime.schedulerUrl,
      schedulerPeer: runtime.schedulerPeer,
      registryEntry: null,
    }
  }

  const result = await discoverSwarm({
    registryUrl: runtime.registryUrl,
    preferredId: runtime.preferredSwarmId,
    preferredModel: runtime.preferredModel,
    timeoutMs: SWARM_DEFAULTS.registryTimeoutMs,
  })

  onStatus({ kind: "discovery", result })

  if (result.kind === "ok") {
    return {
      schedulerUrl: result.swarm.schedulerUrl,
      schedulerPeer: result.swarm.schedulerPeer ?? runtime.schedulerPeer,
      registryEntry: result.swarm,
    }
  }

  // Fallback : on log le motif et on utilise les valeurs runtime (env/défauts).
  const reason =
    result.kind === "no-match"
      ? `no swarm matched (${result.reason})`
      : `registry error (${result.error.message})`
  log.warn("registry discovery failed, using fallback", { reason })
  onStatus({ kind: "discovery-fallback", reason })
  return {
    schedulerUrl: runtime.schedulerUrl,
    schedulerPeer: runtime.schedulerPeer,
    registryEntry: null,
  }
}
