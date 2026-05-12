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
import { formatElapsed, useAnimatedDots, useCyclingWord, useElapsedSeconds } from "./cycling-text"

/**
 * Mots de chargement contextuels — on choisit la liste selon la phase
 * réelle. Ça évite d'afficher "Downloading model" quand en fait notre
 * worker n'a même pas fini son handshake P2P.
 */
const WORDS_LOADING_MODEL = [
  "Downloading model",
  "Loading layers",
  "Refitting weights",
  "Booting workers",
] as const

const WORDS_JOINING = [
  "Connecting to scheduler",
  "Negotiating P2P relay",
  "Announcing on Lattica",
  "Discovering peers",
] as const

const WORDS_STARTING = [
  "Starting your worker",
  "Spawning Parallax",
  "Preparing GPU",
] as const

function pickWordList(reasons: SwarmBlockingReason[]): readonly string[] {
  if (reasons.some((r) => r.kind === "loading-model")) return WORDS_LOADING_MODEL
  if (reasons.some((r) => r.kind === "connecting-to-swarm")) return WORDS_JOINING
  if (reasons.some((r) => r.kind === "worker-not-started")) return WORDS_STARTING
  // Fallback : on garde les mots "loading model" comme défaut générique
  // (cas où une autre raison non-critique a été ajoutée plus tard).
  return WORDS_LOADING_MODEL
}

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

  // Priorité descendante. Le premier match gagne.
  if (reasons.some((r) => r.kind === "worker-missing-binary")) return "Parallax not installed"
  if (reasons.some((r) => r.kind === "worker-crashed")) return "Restarting worker"
  if (reasons.some((r) => r.kind === "scheduler-unreachable")) return "Connecting to swarm"
  if (reasons.some((r) => r.kind === "worker-not-started")) return "Starting your worker"
  if (reasons.some((r) => r.kind === "connecting-to-swarm")) return "Joining the swarm"
  if (reasons.some((r) => r.kind === "loading-model")) return "Downloading model"
  // need-more-peers est géré INLINE (sans popup) ; on n'arrive normalement
  // pas ici. Fallback générique pour ne pas planter sur un état imprévu.
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
  // Liste de mots cyclants choisie réactivement selon la phase — getter
  // passé à useCyclingWord qui relit la liste à chaque tick.
  const cyclingWord = useCyclingWord(() => pickWordList(state().reasons))
  const dots = useAnimatedDots()

  // Timer écoulé depuis l'apparition du gate. Reset automatique quand
  // visible() repasse à false. Sert à :
  //   - rassurer (l'user voit que le temps passe normalement)
  //   - détecter visuellement quand quelque chose traîne plus que prévu
  const elapsed = useElapsedSeconds(visible)
  // Seuils choisis empiriquement :
  //   180s (3 min) : on rappelle gentiment que le 1er download prend du
  //     temps. Sur une fibre c'est fini en <2min ; sur du 4G ou un wifi
  //     saturé ça peut dépasser 3min sans rien d'anormal.
  //   480s (8 min) : à ce stade c'est suspect — un download moyen est
  //     terminé. On bascule en avertissement rouge.
  const showFirstTimeHint = createMemo(() => elapsed() >= 180 && elapsed() < 480)
  const showStuckWarning = createMemo(() => elapsed() >= 480)

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

          {/* Métadonnées discrètes : modèle + peers + temps écoulé */}
          <Show when={state().model || state().nodesTotal > 0 || elapsed() > 0}>
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
            <Show when={elapsed() > 0}>
              <box flexDirection="row" gap={1}>
                <text fg={theme.textMuted}>Elapsed</text>
                <text fg={theme.text}>{formatElapsed(elapsed())}</text>
              </box>
            </Show>
          </Show>

          {/* Hints progressifs selon la durée du chargement */}
          <Show when={showFirstTimeHint()}>
            <text> </text>
            <text fg={theme.textMuted}>
              First-time downloads can take a few minutes on slow connections.
            </text>
          </Show>
          <Show when={showStuckWarning()}>
            <text> </text>
            <text fg={theme.error}>
              This is taking longer than expected. Check your network and that
              your computer hasn't gone to sleep. If it stays stuck, restart
              fabi.
            </text>
          </Show>
        </box>
      </box>
    </Show>
  )
}
