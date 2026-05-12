// Indicateur "le modèle travaille" affiché AU-DESSUS de l'input pendant
// qu'une réponse assistant est en cours de génération.
//
// UX choices :
//   - Un seul mot en "-ing" qui cycle (Generating, Composing, Thinking…)
//     pour habiller l'attente. Les utilisateurs aiment voir que ça bouge
//     même si c'est juste de la sucrerie visuelle.
//   - Les 3 petits points animés ("." → ".." → "...") sont la confirmation
//     visuelle continue : si les points bougent, c'est que le process est
//     encore vivant.
//   - Couleur = agent color (passé en prop) pour rester cohérent avec le
//     reste du chrome de l'agent courant.

import { RGBA } from "@opentui/core"
import { useAnimatedDots, useCyclingWord } from "./cycling-text"

/**
 * Verbes en -ing utilisés pour habiller la génération. Tous décrivent
 * l'activité d'un LLM ; pas de promesse précise (on cycle, donc c'est
 * juste sucrerie visuelle, pas un statut machine).
 */
const CHAT_LOADING_WORDS = [
  "Generating",
  "Thinking",
  "Composing",
  "Reasoning",
  "Computing",
  "Crafting",
  "Processing",
] as const

export function ChatLoadingIndicator(props: { color: RGBA }) {
  const word = useCyclingWord(CHAT_LOADING_WORDS, 2200)
  const dots = useAnimatedDots(450)
  return (
    <box paddingLeft={3} paddingBottom={1} flexDirection="row">
      <text fg={props.color}>
        {word()}
        {dots()}
      </text>
    </box>
  )
}
