// Hook qui expose en continu l'état du fabi-registry (auto-discovery des
// swarms Parallax). Utilisé par le dialog /model pour afficher le nombre de
// peers connectés à côté de chaque modèle Fabi.
//
// Design:
//   - Singleton module-level — un seul poll quel que soit le nombre de
//     consommateurs. La TUI vit dans un process node, on peut laisser le
//     timer tourner jusqu'à exit.
//   - Premier fetch immédiat, puis poll toutes les `POLL_INTERVAL_MS`.
//   - En cas d'erreur (registry down, timeout), on garde le dernier
//     snapshot et on remplit `error()` ; le dialog affichera "—" plutôt
//     que de planter.

import { createSignal } from "solid-js"
import type { RegistrySwarm } from "@/swarm/registry"
import { fetchRegistrySwarms } from "@/swarm/registry"
import { SWARM_DEFAULTS } from "@/swarm/defaults"

// Le registry rafraîchit toutes les 10s côté serveur ; un poll plus rapide
// que ça côté TUI ne fait que dépenser CPU/wifi/batterie sans information
// neuve. 15s est un compromis : l'indicateur live reste vivant, le Mac ne
// chauffe pas, et on évite de tirer sur le scan Docker du registry.
const POLL_INTERVAL_MS = 15_000
const FETCH_TIMEOUT_MS = 2_500

function resolveRegistryUrl(): string {
  return (process.env["FABI_REGISTRY"]?.trim() || SWARM_DEFAULTS.registry).replace(/\/+$/, "")
}

/**
 * Indexe les swarms par modèle. Si plusieurs swarms servent le même
 * modèle, on garde celui avec le plus de peers (= meilleur choix par défaut).
 */
function indexByModel(swarms: RegistrySwarm[]): Map<string, RegistrySwarm> {
  const out = new Map<string, RegistrySwarm>()
  for (const s of swarms) {
    if (!s.model) continue
    const existing = out.get(s.model)
    if (!existing || s.peers > existing.peers) out.set(s.model, s)
  }
  return out
}

export type SwarmRegistryHook = {
  swarms: () => RegistrySwarm[]
  byModel: () => Map<string, RegistrySwarm>
  loading: () => boolean
  error: () => Error | null
}

const [swarms, setSwarms] = createSignal<RegistrySwarm[]>([])
const [byModel, setByModel] = createSignal<Map<string, RegistrySwarm>>(new Map())
const [loading, setLoading] = createSignal(true)
const [error, setError] = createSignal<Error | null>(null)

let started = false

function startPolling() {
  if (started) return
  started = true

  const tick = async () => {
    try {
      const list = await fetchRegistrySwarms(resolveRegistryUrl(), { timeoutMs: FETCH_TIMEOUT_MS })
      setSwarms(list)
      setByModel(indexByModel(list))
      setError(null)
    } catch (err) {
      setError(err as Error)
    } finally {
      setLoading(false)
      setTimeout(tick, POLL_INTERVAL_MS)
    }
  }

  void tick()
}

export function useSwarmRegistry(): SwarmRegistryHook {
  startPolling()
  return { swarms, byModel, loading, error }
}
