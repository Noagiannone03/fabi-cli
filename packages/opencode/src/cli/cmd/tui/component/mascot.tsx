import { RGBA } from "@opentui/core"
import { For } from "solid-js"
import { mascot, mascotPalette } from "@/cli/mascot"

// Précompute les couleurs RGBA depuis la palette hex.
// `null` = transparent (sera rendu comme un espace sans bg).
const palette: Record<string, RGBA | null> = Object.fromEntries(
  Object.entries(mascotPalette).map(([k, v]) => [k, v ? RGBA.fromHex(v) : null]),
)

// Groupe les lignes pixel par paires (top + bottom). Chaque paire devient
// une ligne terminal rendue en `▀` (fg = pixel haut, bg = pixel bas).
function pair(rows: readonly string[]): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (let i = 0; i < rows.length; i += 2) {
    const top = rows[i] ?? ""
    const bot = rows[i + 1] ?? top
    out.push([top, bot])
  }
  return out
}

const ROWS = pair(mascot)

export function Mascot() {
  return (
    <box flexDirection="column" flexShrink={0}>
      <For each={ROWS}>
        {([top, bot]) => (
          <box flexDirection="row">
            {Array.from({ length: top.length }).map((_, x) => {
              const t = palette[top[x] ?? "."] ?? null
              const b = palette[bot[x] ?? "."] ?? null

              if (!t && !b) return <text> </text>
              if (t && b) return <text fg={t} bg={b}>▀</text>
              if (t) return <text fg={t}>▀</text>
              return <text fg={b!}>▄</text>
            })}
          </box>
        )}
      </For>
    </box>
  )
}
