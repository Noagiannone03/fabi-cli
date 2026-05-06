import { createMemo } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { useSwarmRegistry } from "./use-swarm-registry"

// Indicateur réutilisable : `◆ N swarms · M peers live`. Bullet en couleur
// primary, texte en muted. Fallback discret si registry offline ou aucun
// swarm en ligne. Utilisé sur la home, dans le footer du chat et la sidebar.
export function SwarmIndicator(props: { compact?: boolean }) {
  const { theme } = useTheme()
  const swarm = useSwarmRegistry()

  const status = createMemo(() => {
    const list = swarm.swarms()
    if (swarm.loading() && list.length === 0) return { kind: "loading" as const, text: "discovering swarm…" }
    if (swarm.error() && list.length === 0) return { kind: "offline" as const, text: "registry offline" }
    const online = list.filter((s) => s.status === "online")
    if (online.length === 0) return { kind: "offline" as const, text: "no swarm online" }
    const peers = online.reduce((acc, s) => acc + s.peers, 0)
    if (props.compact) {
      return { kind: "online" as const, text: `${peers} peer${peers === 1 ? "" : "s"}` }
    }
    return {
      kind: "online" as const,
      text: `${online.length} swarm${online.length > 1 ? "s" : ""} · ${peers} peer${peers === 1 ? "" : "s"} live`,
    }
  })

  return (
    <text fg={theme.textMuted}>
      <span style={{ fg: status().kind === "online" ? theme.primary : theme.textMuted }}>◆ </span>
      {status().text}
    </text>
  )
}
