// Constantes du swarm Fabi.
//
// Source de vérité runtime : le `fabi-registry` (auto-discovery via Docker
// labels côté serveur). Cf `packages/fabi-registry/` dans le meta-projet.
// Les valeurs ci-dessous servent de fallback si le registry est injoignable.
//
// Surchargeables par :
//   - flags CLI (--registry, --swarm, --scheduler, --scheduler-peer, --no-parallax)
//   - env (FABI_REGISTRY, FABI_SCHEDULER, FABI_SCHEDULER_PEER, FABI_NO_PARALLAX, ...)
//   - config user (~/.config/opencode/opencode.json clé "fabi.swarm")

export const SWARM_DEFAULTS = {
  /** URL du fabi-registry (auto-discovery). Sans trailing slash. */
  registry: "http://37.59.98.16:3002",

  /** Fallback : URL HTTP du scheduler si le registry est injoignable. */
  scheduler: "http://37.59.98.16:3001",

  /** Fallback : PeerID Lattica/libp2p si le registry est injoignable. */
  schedulerPeer: "12D3KooWKLCTHRAhMEafQfaGZTAEx8kJjeMqpXDDeyhBGVotuSfR",

  /** Modèle attendu par défaut (override via --swarm-model). */
  model: "Qwen/Qwen3-Coder-30B-A3B-Instruct",

  /** Timeout fetch du registry au boot, en ms. */
  registryTimeoutMs: 3000,

  /** Timeout du healthcheck scheduler au boot, en ms. */
  healthcheckTimeoutMs: 3000,

  /** Délai SIGTERM → SIGKILL lors du shutdown du worker, en ms. */
  workerShutdownGraceMs: 5000,

  /** Timeout total des requêtes inférence (10 min — l'inférence distribuée est lente). */
  inferenceTimeoutMs: 600_000,

  /** Si aucun chunk pendant 60s → annule (peer mort qui bloque la requête). */
  inferenceChunkTimeoutMs: 60_000,
} as const

export type SwarmDefaults = typeof SWARM_DEFAULTS

/** Identifiant du provider tel que vu par le runtime AI SDK. */
export const SWARM_PROVIDER_ID = "fabi"
