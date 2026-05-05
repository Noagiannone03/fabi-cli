// Commande `fabi swarms` — liste les swarms disponibles via le fabi-registry.
//
// Sortie par défaut : table lisible avec id, état, modèle, peers, VRAM.
// Avec --json : objet brut pour scripts/automation.

import { cmd } from "./cmd"
import { UI } from "../ui"
import { fetchRegistrySwarms, type RegistrySwarm } from "../../swarm/registry"
import { SWARM_DEFAULTS } from "../../swarm/defaults"

export const SwarmsCommand = cmd({
  command: "swarms",
  describe: "list available Fabi swarms (peers, VRAM, model, peer ID)",
  builder: (yargs) =>
    yargs
      .option("registry", {
        describe: "registry URL (default: built-in or $FABI_REGISTRY)",
        type: "string",
      })
      .option("json", {
        describe: "output as JSON instead of a table",
        type: "boolean",
        default: false,
      })
      .option("timeout", {
        describe: "fetch timeout in ms",
        type: "number",
        default: 5000,
      }),
  handler: async (args) => {
    const registryUrl =
      args.registry ?? process.env["FABI_REGISTRY"] ?? SWARM_DEFAULTS.registry

    let swarms: RegistrySwarm[]
    try {
      swarms = await fetchRegistrySwarms(registryUrl, { timeoutMs: args.timeout })
    } catch (err) {
      process.stderr.write(
        `${UI.Style.TEXT_DANGER_BOLD}error${UI.Style.TEXT_NORMAL} contacting registry at ${registryUrl}: ${(err as Error).message}\n`,
      )
      process.exit(1)
    }

    if (args.json) {
      process.stdout.write(JSON.stringify({ registry: registryUrl, swarms }, null, 2))
      process.stdout.write("\n")
      return
    }

    if (swarms.length === 0) {
      process.stdout.write(`No swarm registered at ${registryUrl}.\n`)
      return
    }

    printSwarmsTable(swarms, registryUrl)
  },
})

function printSwarmsTable(swarms: RegistrySwarm[], registry: string): void {
  const out = process.stdout
  out.write(`${UI.Style.TEXT_INFO_BOLD}Registry${UI.Style.TEXT_NORMAL} ${registry}\n\n`)

  for (const s of swarms) {
    const statusColor =
      s.status === "online"
        ? UI.Style.TEXT_SUCCESS_BOLD
        : s.status === "offline"
          ? UI.Style.TEXT_DANGER_BOLD
          : UI.Style.TEXT_WARNING_BOLD
    const statusBadge = `${statusColor}${s.status.toUpperCase()}${UI.Style.TEXT_NORMAL}`

    out.write(
      `${UI.Style.TEXT_HIGHLIGHT_BOLD}${s.id}${UI.Style.TEXT_NORMAL}` +
        `  ${statusBadge}` +
        (s.schedulerStatus ? ` (${s.schedulerStatus})` : "") +
        "\n",
    )
    out.write(`  name      ${s.name}\n`)
    out.write(`  model     ${s.model}\n`)
    out.write(`  peers     ${s.peers}` + (s.peers > 0 ? ` (${s.totalVramGb} GB total)` : "") + "\n")
    out.write(`  scheduler ${s.schedulerUrl}\n`)
    out.write(`  peer id   ${s.schedulerPeer ?? UI.Style.TEXT_DIM + "(not detected)" + UI.Style.TEXT_NORMAL}\n`)
    out.write(`  last seen ${s.lastSeen}\n\n`)
  }

  out.write(
    `${UI.Style.TEXT_DIM}` +
      `Use \`fabi --swarm <id>\` to join a specific swarm.\n` +
      `Use \`fabi swarms --json\` for machine-readable output.\n` +
      `${UI.Style.TEXT_NORMAL}`,
  )
}
