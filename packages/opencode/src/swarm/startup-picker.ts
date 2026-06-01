// Décision pure : que faire au lancement face aux swarms disponibles ?
//
// Objectif UX (cf. décision "Option A") : ne JAMAIS coincer l'utilisateur
// derrière le SwarmGate sur un swarm mort. On résout le choix AVANT de rejoindre :
//   - dernier swarm choisi encore sain → connexion directe (zéro friction) ;
//   - dernier swarm absent / sans peers → on propose la liste (peers live) ;
//   - rien d'exploitable → on laisse le fallback existant gérer.
//
// Ce module est PUR (aucune I/O) → entièrement testable. L'affichage et la
// lecture stdin vivent dans `startup.ts`.

import type { RegistrySwarm } from "./registry"

/** Exploitable = on peut s'y connecter (peer + url + online). */
export function isSwarmUsable(s: RegistrySwarm): boolean {
  return Boolean(s.schedulerPeer) && Boolean(s.schedulerUrl) && s.status === "online"
}

/** Sain = exploitable ET au moins un peer (sinon blocage garanti à l'arrivée). */
export function isSwarmHealthy(s: RegistrySwarm): boolean {
  return isSwarmUsable(s) && s.peers > 0
}

/** Sains d'abord, puis par nb de peers décroissant, puis par modèle. */
export function sortByHealth(swarms: RegistrySwarm[]): RegistrySwarm[] {
  return [...swarms].sort((a, b) => {
    const ha = isSwarmHealthy(a) ? 1 : 0
    const hb = isSwarmHealthy(b) ? 1 : 0
    if (ha !== hb) return hb - ha
    if (a.peers !== b.peers) return b.peers - a.peers
    return a.model.localeCompare(b.model)
  })
}

function findByModel(swarms: RegistrySwarm[], model?: string): RegistrySwarm | undefined {
  if (!model) return undefined
  const needle = model.toLowerCase()
  return swarms.find((s) => s.model.toLowerCase().includes(needle))
}

export type StartupPlan =
  | { action: "auto"; swarm: RegistrySwarm }
  | { action: "prompt"; choices: RegistrySwarm[]; defaultIndex: number; reason: string }
  | { action: "none" }

export interface PlanInput {
  swarms: RegistrySwarm[]
  /** Dernier modèle retenu (préférence persistée ou flag/env). */
  rememberedModel?: string
  /** L'utilisateur a forcé le modèle via flag/env → on respecte, pas de prompt. */
  explicitPreference?: boolean
  /** Force l'affichage du sélecteur même si un choix sain existe. */
  forcePrompt?: boolean
}

/**
 * Décide de l'action de démarrage. Voir le contrat dans le commentaire du module.
 */
export function planSwarmStartup(input: PlanInput): StartupPlan {
  const usable = input.swarms.filter(isSwarmUsable)
  if (usable.length === 0) return { action: "none" }

  const remembered = findByModel(usable, input.rememberedModel)

  // Choix explicite (flag/env) → on le respecte sans rien demander.
  if (input.explicitPreference && !input.forcePrompt) {
    return remembered ? { action: "auto", swarm: remembered } : { action: "none" }
  }

  // Dernier modèle encore là ET sain → connexion directe, zéro friction.
  if (!input.forcePrompt && remembered && isSwarmHealthy(remembered)) {
    return { action: "auto", swarm: remembered }
  }

  // Un seul swarm exploitable → rien à choisir, on le prend.
  if (!input.forcePrompt && usable.length === 1) {
    return { action: "auto", swarm: usable[0]! }
  }

  // Sinon on demande. Default = le dernier modèle (même sans peers, pour le
  // surligner), sinon le plus sain (premier après tri).
  const choices = sortByHealth(usable)
  let defaultIndex = 0
  if (remembered) {
    const i = choices.findIndex((s) => s.id === remembered.id)
    if (i >= 0) defaultIndex = i
  }
  const reason =
    remembered && !isSwarmHealthy(remembered)
      ? `your last model "${remembered.model}" has no peers right now`
      : "several swarms are available"
  return { action: "prompt", choices, defaultIndex, reason }
}

/** Ligne d'affichage d'un choix dans le sélecteur. */
export function formatSwarmChoice(s: RegistrySwarm): string {
  const peers = `${s.peers} peer${s.peers === 1 ? "" : "s"}`
  const health = isSwarmHealthy(s) ? "ready" : s.peers === 0 ? "no peers yet" : s.status
  return `${s.model} — ${peers}, ${s.totalVramGb} GB VRAM [${health}]`
}
