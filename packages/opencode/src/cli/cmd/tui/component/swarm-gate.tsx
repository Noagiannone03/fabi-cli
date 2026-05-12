// Overlay non-dismissible affiché tant que le swarm n'est pas prêt à inférer.
//
// Pourquoi un overlay custom plutôt qu'un Dialog standard :
//   - Le Dialog stack du TUI est dismissible (ESC / Ctrl+C → clear). On ne
//     veut PAS que l'utilisateur puisse fermer ce popup à la main : tant que
//     le swarm n'est pas prêt, envoyer un chat finit en 503.
//   - Le zIndex 4000 le pose au-dessus du Dialog stack (3000) ET du prompt
//     input : impossible de cliquer dessous ou de taper dans le prompt
//     pendant que ce gate est visible.
//
// **Exception "need-more-peers" :** si la SEULE raison bloquante est qu'il
// faut plus de peers, on n'affiche PAS de popup. Le prompt input remplace
// son textarea par un message inline ("Waiting for more peers…"). C'est
// moins agressif visuellement, plus adapté à un état qui peut durer (on
// attend que des amis rejoignent le swarm).
//
// Le gate se ferme TOUT SEUL dès que `useSwarmState().ready` passe à true.

import { For, Show, createMemo } from "solid-js"
import { RGBA, TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "@tui/context/theme"
import { Spinner } from "./spinner"
import { useSwarmState, type SwarmBlockingReason } from "./use-swarm-state"
import { useAnimatedDots, useCyclingWord } from "./cycling-text"

/**
 * Mots de chargement qui cyclent toutes les ~2.5s sous le headline.
 * Ordre choisi pour suggérer une progression (download → load → init →
 * boot) sans jamais mentir : ces 4 verbes décrivent réellement ce qui se
 * passe au worker pendant la phase de refit.
 */
const LOADING_WORDS = [
  "Downloading model",
  "Loading layers",
  "Initializing pipeline",
  "Booting swarm",
] as const

/**
 * Décide si le gate doit s'afficher en plein écran (popup). On masque le
 * popup quand la seule raison est "need-more-peers" — dans ce cas l'input
 * affiche un message inline et le gate est inutile.
 */
function shouldShowPopup(reasons: SwarmBlockingReason[]): boolean {
  if (reasons.length === 0) return false
  // Toutes les raisons sont "need-more-peers" → cas géré inline, pas de popup.
  return !reasons.every((r) => r.kind === "need-more-peers")
}

/**
 * Headline court selon la raison principale. Le headline est COURT (1-3
 * mots), le détail vient juste en dessous via les mots qui cyclent.
 */
function pickHeadline(reasons: SwarmBlockingReason[]): string {
  if (reasons.length === 0) return "Ready"

  // Priorité : missing-binary > crashed > scheduler-unreachable > worker-not-started
  if (reasons.some((r) => r.kind === "worker-missing-binary")) return "Parallax not installed"
  if (reasons.some((r) => r.kind === "worker-crashed")) return "Restarting worker"
  if (reasons.some((r) => r.kind === "scheduler-unreachable")) return "Connecting"
  if (reasons.some((r) => r.kind === "worker-not-started")) return "Starting"

  // Cas nominal : on charge / on initialise.
  return "Setting up your model"
}

/**
 * Pour un état critique (binaire manquant, worker crash), on affiche le
 * détail au lieu des mots qui cyclent — l'utilisateur a besoin de l'info
 * précise (ex: "auto-restart in 30s"), pas d'animation rassurante.
 */
function pickCriticalDetail(reasons: SwarmBlockingReason[]): string | null {
  const crashed = reasons.find((r) => r.kind === "worker-crashed")
  if (crashed && crashed.kind === "worker-crashed") {
    return crashed.lastError ?? "worker crashed, auto-restart in 30s"
  }
  if (reasons.some((r) => r.kind === "worker-missing-binary")) {
    return "Run the install script to add Parallax to this machine."
  }
  return null
}

export function SwarmGate() {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const state = useSwarmState()

  const visible = createMemo(() => shouldShowPopup(state().reasons))
  const headline = createMemo(() => pickHeadline(state().reasons))
  const criticalDetail = createMemo(() => pickCriticalDetail(state().reasons))
  const cyclingWord = useCyclingWord(LOADING_WORDS)
  const dots = useAnimatedDots()

  return (
    <Show when={visible()}>
      <box
        width={dimensions().width}
        height={dimensions().height}
        position="absolute"
        zIndex={4000}
        top={0}
        left={0}
        alignItems="center"
        justifyContent="center"
        backgroundColor={RGBA.fromInts(0, 0, 0, 180)}
      >
        <box
          width={Math.min(64, dimensions().width - 4)}
          backgroundColor={theme.backgroundPanel}
          border
          borderColor={theme.primary}
          customBorderChars={{
            topLeft: "╭",
            topRight: "╮",
            bottomLeft: "╰",
            bottomRight: "╯",
            horizontal: "─",
            vertical: "│",
            bottomT: "─",
            topT: "─",
            cross: "┼",
            leftT: "│",
            rightT: "│",
          }}
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={3}
          paddingRight={3}
        >
          {/* Headline + spinner */}
          <box flexDirection="row" gap={1} alignItems="center">
            <text fg={theme.primary} attributes={TextAttributes.BOLD}>
              ▍
            </text>
            <text fg={theme.text} attributes={TextAttributes.BOLD}>
              {headline()}
            </text>
            <Spinner color={theme.primary} />
          </box>

          {/* Détail critique OU mot qui cycle */}
          <text> </text>
          <Show
            when={criticalDetail()}
            fallback={
              <text fg={theme.textMuted}>
                {cyclingWord()}
                {dots()}
              </text>
            }
          >
            <text fg={theme.error}>{criticalDetail()}</text>
          </Show>

          {/* Métadonnées discrètes : modèle + peers */}
          <Show when={state().model || state().nodesTotal > 0}>
            <text> </text>
            <Show when={state().model}>
              <box flexDirection="row" gap={1}>
                <text fg={theme.textMuted}>Model</text>
                <text fg={theme.text}>{state().model}</text>
              </box>
            </Show>
            <Show when={state().nodesTotal > 0}>
              <box flexDirection="row" gap={1}>
                <text fg={theme.textMuted}>Peers</text>
                <text fg={theme.text}>
                  {state().nodesAvailable}/{state().nodesTotal}
                </text>
                <Show when={state().nodesWaiting > 0}>
                  <text fg={theme.textMuted}>({state().nodesWaiting} loading)</text>
                </Show>
              </box>
            </Show>
          </Show>
        </box>
      </box>
    </Show>
  )
}
