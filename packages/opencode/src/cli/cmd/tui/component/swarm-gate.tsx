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
// **Exceptions inline (pas de popup, message dans le prompt) :**
//   - "need-more-peers" : sous le seuil opérateur, on attend que des amis
//     rejoignent. État qui peut durer → inline plutôt que popup agressif.
//   - "insufficient-capacity" : assez de peers en nombre, mais leurs GPUs
//     combinés ne suffisent pas. Même décision UX : inline, on attend des
//     peers plus costauds (ou plus de peers pour split).
//
// Le gate se ferme TOUT SEUL dès que `useSwarmState().ready` passe à true.

import { For, Show, createMemo } from "solid-js"
import { RGBA, TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "@tui/context/theme"
import { Spinner } from "./spinner"
import { useSwarmState, type SwarmBlockingReason } from "./use-swarm-state"
import { formatElapsed, useAnimatedDots, useElapsedSeconds } from "./cycling-text"
import type { SwarmStateDetail } from "./use-swarm-state"

/**
 * Renvoie UNE phrase qui décrit ce que le worker fait VRAIMENT en ce moment,
 * dérivée des signaux observés (events worker, status scheduler). Pas de
 * carrousel de mots décoratifs — si le texte change, c'est parce que l'état
 * réel a changé. La liveness visuelle est portée par les dots animés.
 *
 * Priorité (la première vraie info gagne) :
 *   1. workerStage : events `[FABI] ...` reçus du worker (le plus précis)
 *   2. reasons : raisons bloquantes dérivées (worker pas démarré, scheduler
 *      injoignable, etc.)
 *   3. nodesInitializing côté scheduler : on charge mais pas via NOUS
 */
function describeRealActivity(state: SwarmStateDetail): string {
  // 1. Signaux directs du worker — préférence absolue
  switch (state.workerStage) {
    case "handshake":
      return "Building peer-to-peer connection"
    case "joining":
      return "Requesting layer assignment from scheduler"
    case "loading-weights": {
      const done = state.weightsFilesDone
      const total = state.weightsFilesTotal
      if (total && total > 0 && done !== undefined) {
        const human = state.weightsCurrentFile
          ? `Loading ${state.weightsCurrentFile}`
          : `Loading weights file ${done + 1} of ${total}`
        return human
      }
      return "Loading model weights into GPU"
    }
    case "alloc-timeout":
      return "Scheduler did not assign any layers"
    case "ready":
      return "Worker ready"
  }

  // 2. Raisons bloquantes — décrit ce qu'on attend, pas un état worker
  for (const r of state.reasons) {
    switch (r.kind) {
      case "worker-not-started":
        if (r.phase === "starting") return "Starting Parallax process"
        if (r.phase === "idle") return "Preparing worker"
        return `Worker is ${r.phase}`
      case "worker-crashed":
        return r.lastError ?? "Worker exited unexpectedly"
      case "worker-missing-binary":
        return "Parallax binary missing"
      case "scheduler-unreachable":
        return "Scheduler is not responding"
      case "connecting-to-swarm":
        // Worker démarré mais pas encore d'event peer_id : il est dans le
        // build_lattica (DHT bootstrap, NAT detection, relay negotiation).
        return "Discovering scheduler over Lattica DHT"
      case "loading-model":
        // Vue scheduler uniquement (pas nos events) : c'est UN AUTRE peer qui
        // charge, pas nous. Honnête : on attend qu'ils finissent.
        return r.nodesInitializing === 1
          ? "Waiting for peer to finish loading the model"
          : `Waiting for ${r.nodesInitializing} peers to finish loading`
    }
  }

  // 3. Fallback : seul cas restant = ready (filtré ailleurs).
  return "Ready"
}

/**
 * Décide si le gate doit s'afficher en plein écran (popup). On masque le
 * popup quand toutes les raisons sont "attente de peers" — états gérés
 * inline dans le prompt (need-more-peers, insufficient-capacity).
 */
function shouldShowPopup(reasons: SwarmBlockingReason[]): boolean {
  if (reasons.length === 0) return false
  return !reasons.every(
    (r) => r.kind === "need-more-peers" || r.kind === "insufficient-capacity",
  )
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
  if (reasons.some((r) => r.kind === "alloc-timeout")) return "Allocation timed out"
  if (reasons.some((r) => r.kind === "scheduler-unreachable")) return "Connecting to swarm"
  if (reasons.some((r) => r.kind === "worker-not-started")) return "Starting your worker"
  if (reasons.some((r) => r.kind === "connecting-to-swarm")) return "Joining the swarm"
  if (reasons.some((r) => r.kind === "loading-model")) return "Loading model"
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
  if (reasons.some((r) => r.kind === "alloc-timeout")) {
    return "The scheduler did not assign layers within 300s. Worker is restarting; check that peers are joining."
  }
  return null
}

/**
 * Sous-titre informatif sous le headline pour les états non critiques. Sert
 * à donner à l'utilisateur une vraie info (nb de layers, nb de peers en
 * initialisation, …) plutôt que juste des mots qui cyclent.
 */
function pickInfoSubline(reasons: SwarmBlockingReason[]): string | null {
  const loading = reasons.find((r) => r.kind === "loading-model")
  if (loading && loading.kind === "loading-model") {
    const parts: string[] = []
    // Vrai progress depuis les events worker — gagne sur tout le reste.
    if (
      loading.filesTotal !== undefined &&
      loading.filesTotal > 0 &&
      loading.filesDone !== undefined
    ) {
      const pct = Math.min(
        100,
        Math.floor((loading.filesDone / loading.filesTotal) * 100),
      )
      parts.push(`${loading.filesDone}/${loading.filesTotal} files · ${pct}%`)
    }
    if (loading.layersAssigned !== undefined && loading.layersAssigned > 0) {
      parts.push(`${loading.layersAssigned} layers assigned`)
    }
    if (loading.nodesInitializing > 0 && loading.nodesTotal > 1) {
      parts.push(`${loading.nodesInitializing}/${loading.nodesTotal} peers initializing`)
    }
    return parts.length > 0 ? parts.join(" · ") : null
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
  const infoSubline = createMemo(() => pickInfoSubline(state().reasons))
  // Texte décrivant CE qui se passe réellement, calculé depuis l'état
  // observé du worker et du scheduler. Pas un carrousel de mots — il change
  // QUAND l'état change. Les dots animés portent la liveness visuelle.
  const realActivity = createMemo(() => describeRealActivity(state()))
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

          {/* Détail critique OU description honnête de l'activité courante.
              Les dots animés portent la liveness visuelle (process vivant)
              sans qu'on ait à mentir sur ce qui se passe. */}
          <text> </text>
          <Show
            when={criticalDetail()}
            fallback={
              <text fg={theme.textMuted}>
                {realActivity()}
                {dots()}
              </text>
            }
          >
            <text fg={theme.error}>{criticalDetail()}</text>
          </Show>

          {/* Sous-titre informatif (layers, peers initializing) si dispo */}
          <Show when={infoSubline()}>
            <text fg={theme.textMuted}>{infoSubline()}</text>
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
                  <text fg={theme.textMuted}>({state().nodesWaiting} initializing)</text>
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
