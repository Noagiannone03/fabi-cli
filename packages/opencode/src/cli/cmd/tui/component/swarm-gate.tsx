// Overlay non-dismissible affiché tant que le swarm n'est pas prêt à inférer.
//
// Pourquoi un overlay custom plutôt qu'un Dialog standard :
//   - Le Dialog stack du TUI est dismissible (ESC / Ctrl+C → clear). On ne
//     veut PAS que l'utilisateur puisse fermer ce popup à la main : tant
//     que le worker n'a pas fini de charger ses layers, envoyer un chat
//     finit en 503 (cf. logs scheduler "POST /v1/chat/completions 503").
//   - Le zIndex 4000 le pose au-dessus du Dialog stack (3000) ET du prompt
//     input : impossible de cliquer dessous ou de taper dans le prompt
//     pendant que ce gate est visible.
//
// Le gate se ferme TOUT SEUL dès que `useSwarmState().ready` passe à true.
// Aucune action utilisateur n'est nécessaire (et possible). C'est une
// "feature" plutôt qu'un "alert" — on protège l'UX, pas on informe.

import { For, Show, createMemo } from "solid-js"
import { RGBA, TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "@tui/context/theme"
import { Spinner } from "./spinner"
import { useSwarmState, type SwarmBlockingReason } from "./use-swarm-state"

/**
 * Décrit une raison bloquante en une ligne lisible. Pas de jargon Parallax
 * ici : "loading model", "waiting for peers", … L'objectif c'est que
 * l'utilisateur comprenne ce qui se passe.
 */
function describeReason(r: SwarmBlockingReason): string {
  switch (r.kind) {
    case "worker-not-started":
      if (r.phase === "starting") return "Starting your local worker…"
      if (r.phase === "stopped") return "Local worker is stopped — restarting…"
      return "Preparing your local worker…"
    case "worker-crashed":
      return r.lastError
        ? `Local worker crashed: ${r.lastError} (auto-restart in 30s)`
        : "Local worker crashed (auto-restart in 30s)"
    case "worker-missing-binary":
      return "Parallax binary not installed on this machine."
    case "scheduler-unreachable":
      return "Cannot reach swarm scheduler — checking your connection…"
    case "need-more-peers":
      return `Waiting for more peers (only ${r.nodesTotal} connected, pipeline incomplete)…`
    case "loading-model":
      return `Downloading and loading model on ${r.nodesWaiting}/${r.nodesTotal} peer${r.nodesTotal > 1 ? "s" : ""}…`
    case "pipeline-not-ready":
      return `Pipeline not ready (cluster status: ${r.clusterStatus})…`
  }
}

/**
 * Headline conditionnel selon la raison principale. On veut que l'utilisateur
 * sache immédiatement où en est le boot.
 */
function pickHeadline(reasons: SwarmBlockingReason[]): string {
  if (reasons.length === 0) return "Swarm ready"
  // Priorité : missing-binary > worker-crashed > worker-not-started >
  // scheduler-unreachable > need-more-peers > loading-model > pipeline-not-ready
  const priority: SwarmBlockingReason["kind"][] = [
    "worker-missing-binary",
    "worker-crashed",
    "worker-not-started",
    "scheduler-unreachable",
    "need-more-peers",
    "loading-model",
    "pipeline-not-ready",
  ]
  for (const kind of priority) {
    if (reasons.some((r) => r.kind === kind)) {
      switch (kind) {
        case "worker-missing-binary":
          return "Parallax not installed"
        case "worker-crashed":
          return "Worker restarting"
        case "worker-not-started":
          return "Starting up"
        case "scheduler-unreachable":
          return "Connecting to swarm"
        case "need-more-peers":
          return "Waiting for peers"
        case "loading-model":
          return "Loading model"
        case "pipeline-not-ready":
          return "Pipeline initializing"
      }
    }
  }
  return "Swarm initializing"
}

export function SwarmGate() {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const state = useSwarmState()

  const headline = createMemo(() => pickHeadline(state().reasons))

  return (
    <Show when={!state().ready}>
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
          width={Math.min(76, dimensions().width - 4)}
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
          {/* Header — marqueur brand + headline + spinner */}
          <box flexDirection="row" gap={1} alignItems="center">
            <text fg={theme.primary} attributes={TextAttributes.BOLD}>
              ▍
            </text>
            <text fg={theme.text} attributes={TextAttributes.BOLD}>
              {headline()}
            </text>
            <Spinner color={theme.primary} />
          </box>

          {/* Métadonnées : modèle + peers */}
          <Show when={state().model || state().nodesTotal > 0}>
            <text> </text>
            <Show when={state().model}>
              <box flexDirection="row" gap={1}>
                <text fg={theme.textMuted}>Model</text>
                <text fg={theme.text}>{state().model}</text>
              </box>
            </Show>
            <box flexDirection="row" gap={1}>
              <text fg={theme.textMuted}>Peers</text>
              <text fg={theme.text}>
                {state().nodesAvailable}/{state().nodesTotal} ready
              </text>
              <Show when={state().nodesWaiting > 0}>
                <text fg={theme.textMuted}>
                  ({state().nodesWaiting} still loading)
                </text>
              </Show>
            </box>
          </Show>

          {/* Liste des raisons bloquantes */}
          <text> </text>
          <For each={state().reasons}>
            {(r) => (
              <box flexDirection="row" gap={1}>
                <text fg={theme.primary}>─</text>
                <text fg={theme.text}>{describeReason(r)}</text>
              </box>
            )}
          </For>

          {/* Footer instructionnel */}
          <text> </text>
          <text fg={theme.textMuted}>
            This dialog closes automatically when the swarm is ready to chat.
          </text>
        </box>
      </box>
    </Show>
  )
}
