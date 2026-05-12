// Source de vérité runtime de l'état du worker swarm spawné par lifecycle.
//
// Pourquoi un module séparé : la TUI doit pouvoir lire cet état pour piloter
// le SwarmGate (popup non-dismissible tant que pas prêt), sans tirer
// `lifecycle.ts` (qui dépend de node:child_process, installer, etc.).
//
// API minimaliste : un getter, un setter, un subscribe. Pas de SolidJS ici
// pour que le module soit utilisable côté node hors TUI (CLI run/serve).

import type { RegistrySwarm } from "./registry"

/**
 * Phase courante du worker local Parallax.
 *
 *   idle           → pas encore démarré (boot en cours, ou commande sans worker)
 *   starting       → spawn en cours, on attend le PID
 *   running        → process Parallax vivant (≠ "modèle chargé" — ça c'est
 *                    le scheduler qui le sait via /cluster/status_json)
 *   stopped        → arrêté volontairement (shutdown)
 *   crashed        → exit inattendu (Parallax mort)
 *   missing-binary → binaire parallax pas trouvé, install refusée
 *   no-parallax    → mode dev --no-parallax (consumer only, pas de worker)
 */
export type SwarmWorkerPhase =
  | "idle"
  | "starting"
  | "running"
  | "stopped"
  | "crashed"
  | "missing-binary"
  | "no-parallax"

/**
 * Sous-phase fine du worker, dérivée des events `[FABI] {...}` que le binaire
 * Parallax (notre fork) émet sur stdout. Vue plus précise que `phase` :
 * `phase=running` couvre tout depuis "process spawné" jusqu'à "ready",
 * `workerStage` raconte CE qu'il fait actuellement.
 *
 *   handshake        — Lattica build / DHT discovery (avant peer_id)
 *   joining          — node_join RPC envoyé, on attend la réponse scheduler
 *   alloc-timeout    — node_join a renvoyé {} après 300s : scheduler n'a pas
 *                      pu nous allouer de layers. Le worker va exit.
 *   loading-weights  — allocation reçue, on charge les safetensors en RAM/GPU
 *   ready            — modèle chargé, MLX prêt à servir
 *
 * Null tant qu'on n'a reçu aucun event (binaire upstream non patché, ou
 * worker pas encore démarré).
 */
export type SwarmWorkerStage =
  | "handshake"
  | "joining"
  | "alloc-timeout"
  | "loading-weights"
  | "ready"

export interface SwarmActiveState {
  /** Phase courante du worker local. */
  phase: SwarmWorkerPhase
  /** PID du worker quand running, sinon undefined. */
  pid?: number
  /** URL du scheduler du swarm sur lequel on est branché. */
  schedulerUrl?: string
  /** PeerID Lattica passé à `parallax join -s`. */
  schedulerPeer?: string
  /** ID du swarm dans le registry (si auto-discovery). */
  swarmId?: string
  /** Modèle annoncé par le swarm (label registry). */
  swarmModel?: string
  /** Dernier message d'erreur si crashed/missing-binary. */
  lastError?: string
  /** Entrée registry choisie (snapshot au moment du start). */
  registryEntry?: RegistrySwarm | null

  // --- Champs dérivés des events `[FABI] {...}` du worker ---
  /** Peer ID Lattica de notre worker, défini après `Lattica.build()`. */
  workerPeerId?: string
  /** Sous-phase fine, plus précise que `phase`. */
  workerStage?: SwarmWorkerStage
  /** Layers alloués à notre worker (inclusif/exclusif). */
  workerStartLayer?: number
  workerEndLayer?: number
  /** Progress de chargement des safetensors (0..total). */
  weightsFilesDone?: number
  weightsFilesTotal?: number
  /** Nom du fichier en cours de chargement (model-00003-of-00005.safetensors…). */
  weightsCurrentFile?: string
}

let state: SwarmActiveState = { phase: "idle" }
const listeners = new Set<(s: SwarmActiveState) => void>()

export function getSwarmActiveState(): SwarmActiveState {
  return state
}

/**
 * Remplace l'état complet. On notifie tous les abonnés (TUI, logs, etc.).
 * Pour les patches partiels passe par `patchSwarmActiveState`.
 */
export function setSwarmActiveState(next: SwarmActiveState): void {
  state = next
  for (const l of listeners) l(next)
}

/** Patch partiel — pratique pour mettre à jour juste la phase ou le pid. */
export function patchSwarmActiveState(patch: Partial<SwarmActiveState>): void {
  state = { ...state, ...patch }
  for (const l of listeners) l(state)
}

/**
 * S'abonne aux changements d'état. Renvoie une fonction de désabonnement.
 * Le callback n'est PAS appelé immédiatement avec l'état courant — utilise
 * `getSwarmActiveState()` séparément si tu veux le snapshot initial.
 */
export function subscribeSwarmActiveState(cb: (s: SwarmActiveState) => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}
