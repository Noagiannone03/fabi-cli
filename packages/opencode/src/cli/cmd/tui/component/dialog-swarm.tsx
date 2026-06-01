// Picker de swarm/modèle Fabi — vue graphique et lisible (peers, VRAM, statut).
//
// C'est l'entrée principale pour CHOISIR ou CHANGER de modèle : on liste les
// swarms du registry (live), triés par santé, et choisir un modèle déclenche le
// hot-swap (`requestSwarmSwitch`) — on rejoint le swarm qui sert ce modèle et on
// y contribue. Ouvert : au boot quand aucun swarm n'est choisi (phase
// "unselected"), via le hint footer du prompt, depuis le SwarmGate, et par la
// commande "Switch model". Pour la liste complète des providers (avancé) :
// `<leader>p` → DialogModel.

import { createMemo } from "solid-js"
import { useDialog } from "@tui/ui/dialog"
import { useToast } from "@tui/ui/toast"
import { useLocal } from "@tui/context/local"
import { useKeybind } from "@tui/context/keybind"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useSwarmRegistry } from "./use-swarm-registry"
import { DialogModel } from "./dialog-model"
import { getSwarmActiveState } from "@/swarm/state"
import { requestSwarmSwitch } from "@/swarm/control"
import { isSwarmHealthy, sortByHealth } from "@/swarm/startup-picker"
import { SWARM_PROVIDER_ID } from "@/swarm/defaults"
import type { RegistrySwarm } from "@/swarm/registry"

function shortName(model: string): string {
  return model.split("/").pop() ?? model
}

/** Footer d'une entrée : `● 4 peers · 96 GB · ready`. Le glyphe porte le statut. */
function swarmLine(s: RegistrySwarm): string {
  const dot = s.status === "online" ? (isSwarmHealthy(s) ? "●" : "◌") : "○"
  const peers = `${s.peers} peer${s.peers === 1 ? "" : "s"}`
  const vram = s.totalVramGb > 0 ? ` · ${s.totalVramGb} GB` : ""
  const status = isSwarmHealthy(s) ? "ready" : s.peers === 0 ? "no peers yet" : s.status
  return `${dot} ${peers}${vram} · ${status}`
}

export function DialogSwarm() {
  const dialog = useDialog()
  const toast = useToast()
  const local = useLocal()
  const keybind = useKeybind()
  const registry = useSwarmRegistry()

  const currentModel = createMemo(() => getSwarmActiveState().swarmModel)
  const currentId = createMemo(() => {
    const m = currentModel()
    return m ? (registry.swarms().find((s) => s.model === m)?.id ?? undefined) : undefined
  })

  function choose(swarm: RegistrySwarm) {
    // L'inférence suit le modèle (endpoint par-modèle) ; le hot-swap déplace la
    // contribution (worker) vers le swarm de ce modèle.
    local.model.set({ providerID: SWARM_PROVIDER_ID, modelID: swarm.model }, { recent: true })
    dialog.clear()
    if (swarm.model === getSwarmActiveState().swarmModel) return
    const short = shortName(swarm.model)
    void requestSwarmSwitch(swarm.model).then((r) => {
      if (r.ok && r.reason !== "same" && r.reason !== "no-parallax") {
        toast.show({ variant: "info", message: `Joining the ${short} swarm…` })
      } else if (!r.ok) {
        const why =
          r.reason === "not-found"
            ? `no swarm is running ${short} right now`
            : (r.message ?? r.reason ?? "unknown error")
        toast.show({ variant: "error", message: `Could not switch swarm: ${why}` })
      }
    })
  }

  const options = createMemo(() => {
    const swarms = sortByHealth(registry.swarms())
    if (swarms.length === 0) {
      return [
        {
          value: "__none__",
          title: registry.loading() ? "Discovering swarms…" : "No swarms available right now",
          disabled: true,
        },
      ]
    }
    return swarms.map((s) => ({
      value: s.id,
      title: shortName(s.model),
      // Regroupe visuellement les swarms prêts vs ceux qui attendent des peers.
      category: isSwarmHealthy(s) ? "Ready" : "Waiting for peers",
      footer: swarmLine(s),
      onSelect: () => choose(s),
    }))
  })

  return (
    <DialogSelect<string>
      title="Choose your model · you join its swarm and help run it"
      options={options()}
      current={currentId()}
      keybind={[
        {
          keybind: keybind.all.model_provider_list?.[0],
          title: "All providers",
          onTrigger: () => dialog.replace(() => <DialogModel />),
        },
      ]}
    />
  )
}
