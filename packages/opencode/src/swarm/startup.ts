// Résolution du swarm au lancement (phase boot, avant la TUI).
//
// Branché depuis le middleware swarm de `index.ts`. On décide AVANT de rejoindre
// si on connecte direct (dernier modèle sain → zéro friction) ou si on défère le
// choix à un picker DANS la GUI (DialogSwarm). Plus de prompt texte pré-GUI :
// quand il faut choisir, on passe en phase "unselected" et la TUI ouvre le picker.
//
// 100% best-effort : pas de TTY, registry injoignable, ou la moindre erreur →
// on demande à rejoindre normalement (startSwarm fera sa résolution + fallback).
// Ne doit JAMAIS bloquer le boot.

import { SWARM_DEFAULTS } from "./defaults"
import { armSwarmRuntime, type SwarmRuntime } from "./lifecycle"
import { writeSwarmPreference } from "./preference"
import { fetchRegistrySwarms, type RegistrySwarm } from "./registry"
import { setSwarmActiveState } from "./state"
import { planSwarmStartup } from "./startup-picker"

export interface ResolveStartupOptions {
  /** L'utilisateur a forcé le modèle via --swarm-model / FABI_SWARM_MODEL. */
  explicit: boolean
}

export interface StartupDecision {
  /** true → l'appelant doit appeler `startSwarm` (on rejoint un swarm). */
  join: boolean
}

/**
 * Décide quoi faire au lancement et prépare le `runtime` en conséquence.
 *
 * - swarm du dernier modèle (ou défaut) sain → `{join:true}` après avoir fixé
 *   `runtime.preferredSwarmId/Model` (connexion directe).
 * - sinon, en TTY → on **défère à la GUI** : arme le runtime pour le hot-swap,
 *   passe l'état en "unselected" (la TUI ouvre DialogSwarm) et renvoie `{join:false}`.
 * - en non-interactif (run/serve) ou registry KO → `{join:true}` (fallback).
 */
export async function resolveStartupSwarm(
  runtime: SwarmRuntime,
  opts: ResolveStartupOptions,
): Promise<StartupDecision> {
  // Choix explicite, registry désactivé, ou pas de registry → on rejoint
  // directement (startSwarm résout + fallback).
  if (opts.explicit || runtime.skipRegistry || !runtime.registryUrl) {
    return { join: true }
  }

  let swarms: RegistrySwarm[]
  try {
    swarms = await fetchRegistrySwarms(runtime.registryUrl, {
      timeoutMs: SWARM_DEFAULTS.registryTimeoutMs,
    })
  } catch {
    return { join: true } // registry KO → startSwarm gérera le fallback
  }

  const plan = planSwarmStartup({ swarms, rememberedModel: runtime.preferredModel })

  if (plan.action === "auto") {
    runtime.preferredSwarmId = plan.swarm.id
    runtime.preferredModel = plan.swarm.model
    writeSwarmPreference({ swarmModel: plan.swarm.model, swarmId: plan.swarm.id })
    return { join: true }
  }

  if (plan.action === "none") {
    return { join: true } // rien d'exploitable → laisse le fallback existant
  }

  // plan.action === "prompt"
  if (!process.stdin.isTTY) {
    // Non-interactif : pas de picker → on prend le plus sain (tête de liste triée).
    const best = plan.choices[0]!
    runtime.preferredSwarmId = best.id
    runtime.preferredModel = best.model
    return { join: true }
  }

  // Interactif → on défère le choix au picker in-GUI (DialogSwarm).
  armSwarmRuntime(runtime)
  setSwarmActiveState({ phase: "unselected" })
  return { join: false }
}
