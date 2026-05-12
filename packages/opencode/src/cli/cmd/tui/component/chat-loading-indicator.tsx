// Indicateur "le modèle travaille" affiché AU-DESSUS de l'input pendant
// qu'une réponse assistant est en cours de génération.
//
// On dit la vérité observable : le modèle génère. Pas de carrousel de mots
// décoratifs (Thinking/Composing/Crafting…) qui ne reflètent aucun état
// réel — l'autoregression de tokens est le SEUL processus en cours côté
// modèle. Les 3 points animés portent la liveness visuelle.
//
// Couleur = agent color (passé en prop) pour rester cohérent avec le reste
// du chrome de l'agent courant.

import { RGBA } from "@opentui/core"
import { useAnimatedDots } from "./cycling-text"

export function ChatLoadingIndicator(props: { color: RGBA }) {
  const dots = useAnimatedDots(450)
  return (
    <box paddingLeft={3} paddingBottom={1} flexDirection="row">
      <text fg={props.color}>
        Generating{dots()}
      </text>
    </box>
  )
}
