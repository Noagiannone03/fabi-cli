// Constantes du swarm Fabi.
//
// Ces valeurs représentent la prod Aircarto. Surchargeables par :
//   - flags CLI (--scheduler, --scheduler-peer, --no-parallax)
//   - env (FABI_SCHEDULER, FABI_SCHEDULER_PEER, FABI_NO_PARALLAX, etc.)
//   - config user (~/.config/opencode/opencode.json clé "fabi.swarm")
//
// À terme : auto-discovery via GET /swarm.json sur le scheduler.

export const SWARM_DEFAULTS = {
  /** URL HTTP du scheduler (OpenAI-compatible API + healthcheck). Sans trailing slash. */
  scheduler: "http://37.59.98.16:3001",

  /** PeerID Lattica/libp2p à passer à `parallax join -s`. "auto" = découverte LAN. */
  schedulerPeer: "12D3KooWKLCTHRAhMEafQfaGZTAEx8kJjeMqpXDDeyhBGVotuSfR",

  /** Modèle servi par le swarm. Doit matcher ce que le scheduler annonce. */
  model: "Qwen/Qwen3-Coder-30B-A3B-Instruct",

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

/** Identifiant du provider tel que vu par OpenCode/AI SDK. */
export const SWARM_PROVIDER_ID = "fabi"
