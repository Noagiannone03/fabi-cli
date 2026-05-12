// Hook polling du scheduler Parallax courant (/cluster/status_json).
//
// Sert au SwarmGate à savoir en temps réel :
//   - Si le scheduler répond (sinon → réseau down, swarm offline)
//   - Le statut cluster ("waiting" tant que pas prêt, "available" sinon)
//   - L'état de chaque node (waiting = en train de charger le modèle,
//     available = prêt à servir)
//   - Le flag need_more_nodes (le swarm a besoin de plus de peers)
//
// Design : un seul poller module-level, identique à `use-swarm-registry`.
// L'URL du scheduler vient du singleton `swarm/state` — donc si on switch
// de swarm plus tard (multi-model), il suffit que `patchSwarmActiveState`
// soit appelé avec la nouvelle URL et on re-poll automatiquement.

import { createSignal, onCleanup } from "solid-js"
import { getSwarmActiveState, subscribeSwarmActiveState } from "@/swarm/state"

// 4s : plus court que le poll registry (15s) parce qu'on l'utilise pour
// fermer le gate dès qu'on est prêt. Au pire on tape 15 req/min sur le
// scheduler, négligeable.
const POLL_INTERVAL_MS = 4_000
const FETCH_TIMEOUT_MS = 2_500

export interface SchedulerNode {
  node_id: string
  status: string
  gpu_name?: string
  gpu_memory?: number
}

export interface SchedulerStatusDetail {
  /** True si la dernière requête a réussi (200 + JSON parsable). */
  reachable: boolean
  /** Statut cluster ("available" | "waiting" | ...). */
  status?: string
  /** Modèle servi (annoncé par le scheduler — peut différer du registry). */
  model?: string
  /** Liste complète des nodes (peers) connectés. */
  nodes: SchedulerNode[]
  /**
   * Seuil de bootstrap configuré par l'opérateur (`min_nodes_bootstrapping`
   * côté Parallax). Le scheduler tente une allocation dès que
   * `nodes.length >= initNodesNum`. Tant qu'on est en-dessous, c'est un
   * "besoin de plus de peers" SOLIDE (pas une question de timing).
   */
  initNodesNum?: number
  /** Si true, le swarm a besoin de plus de peers pour former un pipeline. */
  needMoreNodes?: boolean
  /** Nombre de requêtes simultanées que le pipeline peut traiter (0 = pas prêt). */
  maxRunningRequest?: number
}

const [status, setStatus] = createSignal<SchedulerStatusDetail>({ reachable: false, nodes: [] })
const [loading, setLoading] = createSignal(true)

let started = false
let tickTimer: ReturnType<typeof setTimeout> | null = null

function scheduleNext(): void {
  if (tickTimer) clearTimeout(tickTimer)
  tickTimer = setTimeout(tick, POLL_INTERVAL_MS)
}

async function tick(): Promise<void> {
  const active = getSwarmActiveState()
  const url = active.schedulerUrl

  // Pas d'URL → soit on n'a pas encore boot, soit mode --no-parallax sans
  // swarm. On garde reachable=false et on re-poll plus tard au cas où.
  if (!url) {
    setStatus({ reachable: false, nodes: [] })
    setLoading(false)
    scheduleNext()
    return
  }

  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
    const res = await fetch(`${url.replace(/\/+$/, "")}/cluster/status_json`, {
      method: "GET",
      signal: ctrl.signal,
    })
    clearTimeout(timer)

    if (!res.ok) {
      setStatus({ reachable: false, nodes: [] })
    } else {
      const json = (await res.json()) as {
        data?: {
          status?: string
          model_name?: string
          node_list?: SchedulerNode[]
          init_nodes_num?: number
          need_more_nodes?: boolean
          max_running_request?: number
        }
      }
      const data = json?.data ?? {}
      setStatus({
        reachable: true,
        status: data.status,
        model: data.model_name,
        nodes: Array.isArray(data.node_list) ? data.node_list : [],
        initNodesNum: typeof data.init_nodes_num === "number" ? data.init_nodes_num : undefined,
        needMoreNodes: Boolean(data.need_more_nodes),
        maxRunningRequest: data.max_running_request,
      })
    }
  } catch {
    // Timeout, DNS, TLS, … : on marque unreachable mais on re-tente plus tard.
    setStatus({ reachable: false, nodes: [] })
  } finally {
    setLoading(false)
    scheduleNext()
  }
}

function start(): void {
  if (started) return
  started = true

  // Premier fetch immédiat, puis intervalle régulier.
  void tick()

  // Si l'URL du scheduler change (switch de swarm futur), on re-fetch tout
  // de suite plutôt que d'attendre la fin de l'intervalle courant.
  subscribeSwarmActiveState(() => {
    void tick()
  })
}

export interface SchedulerStatusHook {
  status: () => SchedulerStatusDetail
  loading: () => boolean
}

export function useSchedulerStatus(): SchedulerStatusHook {
  start()
  // Pas besoin d'onCleanup : le poll est singleton, il vit jusqu'à exit.
  // Si jamais on veut le couper (test, switch agressif), on ajoutera une
  // API d'arrêt explicite plus tard.
  onCleanup(() => {})
  return { status, loading }
}
