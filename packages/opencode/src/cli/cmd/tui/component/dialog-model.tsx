import { createMemo, createSignal } from "solid-js"
import { useLocal } from "@tui/context/local"
import { useSync } from "@tui/context/sync"
import { map, pipe, flatMap, entries, filter, sortBy, take } from "remeda"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { createDialogProviderOptions, DialogProvider } from "./dialog-provider"
import { DialogVariant } from "./dialog-variant"
import { useKeybind } from "../context/keybind"
import * as fuzzysort from "fuzzysort"
import { useConnected } from "./use-connected"
import { useSwarmRegistry } from "./use-swarm-registry"
import { useToast } from "@tui/ui/toast"
import { SWARM_PROVIDER_ID } from "@/swarm/defaults"
import type { RegistrySwarm } from "@/swarm/registry"
import { requestSwarmSwitch } from "@/swarm/control"
import { getSwarmActiveState } from "@/swarm/state"

// Affiche un footer compact "● 3 peers · 24GB" pour les modèles Fabi (provider
// fabi). Si le swarm est inconnu du registry on retombe sur "● —" qui signale
// "registry pas encore résolu / injoignable" sans casser la mise en page.
function swarmFooter(entry: RegistrySwarm | undefined): string {
  if (!entry) return "● —"
  const dot = entry.status === "online" ? "●" : entry.status === "offline" ? "○" : "◌"
  if (!entry.peers) return `${dot} 0 peer`
  const vram = entry.totalVramGb > 0 ? ` · ${entry.totalVramGb}GB` : ""
  return `${dot} ${entry.peers} peer${entry.peers > 1 ? "s" : ""}${vram}`
}

export function DialogModel(props: { providerID?: string }) {
  const local = useLocal()
  const sync = useSync()
  const dialog = useDialog()
  const keybind = useKeybind()
  const [query, setQuery] = createSignal("")

  const connected = useConnected()
  const providers = createDialogProviderOptions()
  const swarmRegistry = useSwarmRegistry()
  const toast = useToast()

  const showExtra = createMemo(() => connected() && !props.providerID)

  const options = createMemo(() => {
    const needle = query().trim()
    const showSections = showExtra() && needle.length === 0
    const favorites = connected() ? local.model.favorite() : []
    const recents = local.model.recent()

    function toOptions(items: typeof favorites, category: string) {
      if (!showSections) return []
      return items.flatMap((item) => {
        const provider = sync.data.provider.find((x) => x.id === item.providerID)
        if (!provider) return []
        const model = provider.models[item.modelID]
        if (!model) return []
        const swarmEntry = provider.id === SWARM_PROVIDER_ID ? swarmRegistry.byModel().get(model.id) : undefined
        return [
          {
            key: item,
            value: { providerID: provider.id, modelID: model.id },
            title: model.name ?? item.modelID,
            description: provider.name,
            category,
            disabled: provider.id === "opencode" && model.id.includes("-nano"),
            footer:
              provider.id === SWARM_PROVIDER_ID
                ? swarmFooter(swarmEntry)
                : model.cost?.input === 0 && provider.id === "opencode"
                  ? "Free"
                  : undefined,
            onSelect: () => {
              onSelect(provider.id, model.id)
            },
          },
        ]
      })
    }

    const favoriteOptions = toOptions(favorites, "Favorites")
    const recentOptions = toOptions(
      recents.filter(
        (item) => !favorites.some((fav) => fav.providerID === item.providerID && fav.modelID === item.modelID),
      ),
      "Recent",
    )

    const providerOptions = pipe(
      sync.data.provider,
      sortBy(
        (provider) => provider.id !== "opencode",
        (provider) => provider.name,
      ),
      flatMap((provider) =>
        pipe(
          provider.models,
          entries(),
          filter(([_, info]) => info.status !== "deprecated"),
          filter(([_, info]) => (props.providerID ? info.providerID === props.providerID : true)),
          map(([model, info]) => {
            const swarmEntry =
              provider.id === SWARM_PROVIDER_ID ? swarmRegistry.byModel().get(model) : undefined
            return {
              value: { providerID: provider.id, modelID: model },
              title: info.name ?? model,
              description: favorites.some((item) => item.providerID === provider.id && item.modelID === model)
                ? "(Favorite)"
                : undefined,
              category: connected() ? provider.name : undefined,
              disabled: provider.id === "opencode" && model.includes("-nano"),
              footer:
                provider.id === SWARM_PROVIDER_ID
                  ? swarmFooter(swarmEntry)
                  : info.cost?.input === 0 && provider.id === "opencode"
                    ? "Free"
                    : undefined,
              onSelect() {
                onSelect(provider.id, model)
              },
            }
          }),
          filter((x) => {
            if (!showSections) return true
            if (favorites.some((item) => item.providerID === x.value.providerID && item.modelID === x.value.modelID))
              return false
            if (recents.some((item) => item.providerID === x.value.providerID && item.modelID === x.value.modelID))
              return false
            return true
          }),
          sortBy(
            (x) => x.footer !== "Free",
            (x) => x.title,
          ),
        ),
      ),
    )

    const popularProviders = !connected()
      ? pipe(
          providers(),
          map((option) => ({
            ...option,
            category: "Popular providers",
          })),
          take(6),
        )
      : []

    if (needle) {
      return [
        ...fuzzysort.go(needle, providerOptions, { keys: ["title", "category"] }).map((x) => x.obj),
        ...fuzzysort.go(needle, popularProviders, { keys: ["title"] }).map((x) => x.obj),
      ]
    }

    return [...favoriteOptions, ...recentOptions, ...providerOptions, ...popularProviders]
  })

  const provider = createMemo(() =>
    props.providerID ? sync.data.provider.find((x) => x.id === props.providerID) : null,
  )

  const title = createMemo(() => {
    const value = provider()
    if (!value) return "Select model"
    return value.name
  })

  function onSelect(providerID: string, modelID: string) {
    local.model.set({ providerID, modelID }, { recent: true })
    // Modèle swarm Fabi → on déplace aussi notre worker vers le swarm qui sert
    // ce modèle (on contribue là où on consomme). L'inférence suit déjà le
    // modèle (endpoint par-modèle) ; ici on bascule la CONTRIBUTION. Fire-and-
    // forget : le SwarmGate réaffiche "joining" pendant la reconnexion.
    if (providerID === SWARM_PROVIDER_ID && modelID !== getSwarmActiveState().swarmModel) {
      const short = modelID.split("/").pop() ?? modelID
      void requestSwarmSwitch(modelID).then((r) => {
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
    const list = local.model.variant.list()
    const cur = local.model.variant.selected()
    if (cur === "default" || (cur && list.includes(cur))) {
      dialog.clear()
      return
    }
    if (list.length > 0) {
      dialog.replace(() => <DialogVariant />)
      return
    }
    dialog.clear()
  }

  return (
    <DialogSelect<ReturnType<typeof options>[number]["value"]>
      options={options()}
      keybind={[
        {
          keybind: keybind.all.model_provider_list?.[0],
          title: connected() ? "Connect provider" : "View all providers",
          onTrigger() {
            dialog.replace(() => <DialogProvider />)
          },
        },
        {
          keybind: keybind.all.model_favorite_toggle?.[0],
          title: "Favorite",
          disabled: !connected(),
          onTrigger: (option) => {
            local.model.toggleFavorite(option.value as { providerID: string; modelID: string })
          },
        },
      ]}
      onFilter={setQuery}
      flat={true}
      skipFilter={true}
      title={title()}
      current={local.model.current()}
    />
  )
}
