// Sélecteur de swarm au lancement (phase boot, avant la TUI).
//
// Branché depuis le middleware swarm de `index.ts`. Résout le swarm cible AVANT
// le `join`, de sorte que l'utilisateur ne se retrouve jamais coincé derrière le
// SwarmGate sur un swarm sans peers (il choisit en voyant les peers live).
//
// 100% best-effort : pas de TTY, registry injoignable, ou la moindre erreur →
// on ne touche pas au runtime et on laisse `startSwarm` faire sa résolution
// habituelle (avec fallback). Ne doit JAMAIS bloquer le boot.

import * as UI from "../cli/ui"
import { SWARM_DEFAULTS } from "./defaults"
import type { SwarmRuntime } from "./lifecycle"
import { readSwarmPreference, writeSwarmPreference } from "./preference"
import { fetchRegistrySwarms, type RegistrySwarm } from "./registry"
import { formatSwarmChoice, planSwarmStartup } from "./startup-picker"

export interface ResolvePreferredOptions {
  /** L'utilisateur a forcé le modèle via --swarm-model / FABI_SWARM_MODEL. */
  explicit: boolean
  /** Sink d'affichage (mêmes lignes "[fabi swarm]" que le reste du boot). */
  writeLine: (msg: string) => void
}

/**
 * Résout le swarm préféré et l'écrit dans `runtime` (preferredSwarmId +
 * preferredModel), en demandant à l'utilisateur si le dernier choix n'est pas
 * exploitable. Persiste le choix retenu. Mute `runtime` en place.
 */
export async function resolvePreferredSwarm(
  runtime: SwarmRuntime,
  opts: ResolvePreferredOptions,
): Promise<void> {
  // Pas d'interaction possible / pas de registry → on ne fait rien.
  if (!process.stdin.isTTY) return
  if (runtime.skipRegistry || !runtime.registryUrl) return

  let swarms: RegistrySwarm[]
  try {
    swarms = await fetchRegistrySwarms(runtime.registryUrl, {
      timeoutMs: SWARM_DEFAULTS.registryTimeoutMs,
    })
  } catch {
    return // registry KO → startSwarm gérera le fallback
  }

  const plan = planSwarmStartup({
    swarms,
    rememberedModel: runtime.preferredModel,
    explicitPreference: opts.explicit,
  })

  if (plan.action === "none") return

  let chosen: RegistrySwarm
  if (plan.action === "auto") {
    chosen = plan.swarm
  } else {
    chosen = await promptSwarmChoice(plan.choices, plan.defaultIndex, plan.reason, opts.writeLine)
  }

  runtime.preferredSwarmId = chosen.id
  runtime.preferredModel = chosen.model
  writeSwarmPreference({ swarmModel: chosen.model, swarmId: chosen.id })
}

/**
 * Affiche la liste numérotée (peers live) et lit le choix. Entrée vide →
 * `defaultIndex`. Saisie invalide → on redemande (3 essais) puis on prend le
 * défaut. Toute erreur de lecture → défaut.
 */
async function promptSwarmChoice(
  choices: RegistrySwarm[],
  defaultIndex: number,
  reason: string,
  writeLine: (msg: string) => void,
): Promise<RegistrySwarm> {
  const dim = UI.Style.TEXT_DIM
  const reset = UI.Style.TEXT_NORMAL
  const bold = UI.Style.TEXT_INFO_BOLD

  writeLine(`${bold}choose a swarm${reset} — ${reason}`)
  choices.forEach((s, i) => {
    const marker = i === defaultIndex ? "›" : " "
    writeLine(`  ${marker} ${i + 1}. ${formatSwarmChoice(s)}`)
  })
  writeLine(`${dim}press Enter for #${defaultIndex + 1}, or type a number${reset}`)

  for (let attempt = 0; attempt < 3; attempt++) {
    let answer: string
    try {
      answer = (await UI.input("swarm > ")).trim()
    } catch {
      return choices[defaultIndex]!
    }
    if (answer === "") return choices[defaultIndex]!
    const n = Number.parseInt(answer, 10)
    if (Number.isInteger(n) && n >= 1 && n <= choices.length) {
      return choices[n - 1]!
    }
    writeLine(`${dim}invalid choice — enter 1-${choices.length}${reset}`)
  }
  return choices[defaultIndex]!
}
