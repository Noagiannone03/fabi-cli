// Pont TUI → lifecycle pour le hot-swap de swarm (changement de modèle à chaud).
//
// Pourquoi un module séparé : la TUI (dialog-model) doit pouvoir DÉCLENCHER un
// changement de swarm sans importer `lifecycle.ts` (qui tire node:child_process,
// l'installer, etc. — cf. le même découpage que `state.ts`). Le lifecycle
// enregistre un handler ici au boot ; la TUI appelle `requestSwarmSwitch`.
//
// La décision (quel swarm viser / no-op / abandon) est une fonction PURE,
// testable sans hardware.

import type { DiscoverResult, RegistrySwarm } from "./registry"
import type { SwarmActiveState } from "./state"

export interface SwarmSwitchResult {
  ok: boolean
  /** Motif d'échec / cas particulier. */
  reason?:
    | "no-runtime" // aucun swarm runtime actif (boot pas fait / commande sans worker)
    | "no-parallax" // mode dev --no-parallax : pas de worker local à déplacer
    | "not-found" // aucun swarm du registry ne sert ce modèle
    | "registry-error" // registry injoignable
    | "same" // déjà branché sur ce swarm (no-op)
    | "missing-binary" // binaire parallax absent
    | "spawn-failed" // worker pas démarré
  /** Modèle effectivement ciblé. */
  model?: string
  /** Id registry du swarm ciblé. */
  swarmId?: string
  /** Détail lisible. */
  message?: string
}

export type SwarmSwitchPlan =
  | { action: "switch"; swarm: RegistrySwarm }
  | { action: "same"; swarm: RegistrySwarm }
  | { action: "abort"; reason: "not-found" | "registry-error"; message: string }

/**
 * Décide quoi faire à partir du résultat de discovery + l'état courant.
 * Pure (aucun effet de bord). On ne re-join PAS si on est déjà branché sur ce
 * swarm ET que le worker est vivant (starting/running) — sinon on (re)join,
 * ce qui couvre aussi la reprise après un crash sur le même modèle.
 */
export function planSwarmSwitch(
  current: SwarmActiveState,
  result: DiscoverResult,
): SwarmSwitchPlan {
  if (result.kind === "registry-error") {
    return { action: "abort", reason: "registry-error", message: result.error.message }
  }
  if (result.kind === "no-match") {
    return { action: "abort", reason: "not-found", message: result.reason }
  }
  const swarm = result.swarm
  const alive = current.phase === "starting" || current.phase === "running"
  if (current.swarmId && current.swarmId === swarm.id && alive) {
    return { action: "same", swarm }
  }
  return { action: "switch", swarm }
}

// --- bridge ----------------------------------------------------------------
type SwitchHandler = (model: string) => Promise<SwarmSwitchResult>
let handler: SwitchHandler | null = null

/** Le lifecycle enregistre (ou retire avec null) le handler de switch au boot. */
export function registerSwarmSwitchHandler(h: SwitchHandler | null): void {
  handler = h
}

/** Déclenché par la TUI quand l'utilisateur choisit un modèle swarm différent. */
export async function requestSwarmSwitch(model: string): Promise<SwarmSwitchResult> {
  if (!handler) return { ok: false, reason: "no-runtime" }
  try {
    return await handler(model)
  } catch (e) {
    return { ok: false, reason: "spawn-failed", message: (e as Error).message }
  }
}
