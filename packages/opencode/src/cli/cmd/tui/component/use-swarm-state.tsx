// Agrégat des sources de vérité pour décider si l'utilisateur peut chatter.
//
//   1. Worker local (Parallax join) → singleton swarm/state.ts
//      Indique si notre process Parallax tourne, est planté, ou pas démarré.
//
//   2. Scheduler /cluster/status_json → use-scheduler-status.tsx
//      Vue agrégée du swarm distant : statut cluster, nodes individuels,
//      besoin de plus de peers.
//
// Le SwarmGate consomme ce hook et reste affiché tant que `ready = false`.

import { createMemo, createSignal, onCleanup } from "solid-js"
import {
  getSwarmActiveState,
  subscribeSwarmActiveState,
  type SwarmActiveState,
  type SwarmWorkerPhase,
} from "@/swarm/state"
import { useSchedulerStatus, type SchedulerStatusDetail } from "./use-scheduler-status"

/**
 * Une raison concrète pour laquelle le swarm n'est pas prêt. Le SwarmGate
 * itère dessus pour afficher des bullets actionnables à l'utilisateur.
 *
 * Ordre conceptuel (du plus "tôt dans le boot" au plus "presque prêt") :
 *   worker-not-started → scheduler-unreachable → need-more-peers →
 *   loading-model → pipeline-not-ready
 */
export type SwarmBlockingReason =
  | { kind: "worker-not-started"; phase: SwarmWorkerPhase }
  | { kind: "worker-crashed"; lastError?: string }
  | { kind: "worker-missing-binary" }
  | { kind: "scheduler-unreachable" }
  | { kind: "need-more-peers"; nodesTotal: number }
  | { kind: "loading-model"; nodesWaiting: number; nodesTotal: number }
  | { kind: "pipeline-not-ready"; clusterStatus: string }

export interface SwarmStateDetail {
  /** True ssi aucune raison bloquante n'est présente. */
  ready: boolean
  /** Liste exhaustive des raisons bloquantes (peut être vide si `ready`). */
  reasons: SwarmBlockingReason[]

  // Métriques exposées pour l'UI (footer du popup, etc.)
  nodesTotal: number
  nodesAvailable: number
  nodesWaiting: number
  clusterStatus?: string
  schedulerReachable: boolean
  workerPhase: SwarmWorkerPhase
  model?: string
  swarmId?: string
}

function deriveReasons(
  worker: SwarmActiveState,
  sched: SchedulerStatusDetail,
  schedLoading: boolean,
): SwarmBlockingReason[] {
  const reasons: SwarmBlockingReason[] = []

  // --- Worker local ---
  // En mode --no-parallax (dev), on skip totalement le check worker — l'user
  // veut explicitement faire de la consommation sans contribuer.
  if (worker.phase !== "no-parallax") {
    if (worker.phase === "missing-binary") {
      reasons.push({ kind: "worker-missing-binary" })
    } else if (worker.phase === "crashed") {
      reasons.push({ kind: "worker-crashed", lastError: worker.lastError })
    } else if (worker.phase === "idle" || worker.phase === "starting" || worker.phase === "stopped") {
      reasons.push({ kind: "worker-not-started", phase: worker.phase })
    }
    // running → on n'ajoute rien, c'est le scheduler qui dira si on est ready
  }

  // --- Scheduler distant ---
  // Tant que le premier fetch n'a pas répondu, on évite de gueuler
  // "unreachable" — on attend silencieusement.
  if (!sched.reachable && !schedLoading) {
    reasons.push({ kind: "scheduler-unreachable" })
  }

  if (sched.reachable) {
    const nodesTotal = sched.nodes.length
    const nodesWaiting = sched.nodes.filter((n) => n.status !== "available").length

    if (sched.needMoreNodes) {
      reasons.push({ kind: "need-more-peers", nodesTotal })
    }
    if (nodesWaiting > 0) {
      reasons.push({ kind: "loading-model", nodesWaiting, nodesTotal })
    }
    // Cluster status n'est pas "available" mais on n'a pas trouvé de raison
    // plus précise (rare cas où pipeline pas formé mais pas de waiting nodes).
    if (
      sched.status &&
      sched.status !== "available" &&
      reasons.length === 0
    ) {
      reasons.push({ kind: "pipeline-not-ready", clusterStatus: sched.status })
    }
  }

  return reasons
}

export function useSwarmState(): () => SwarmStateDetail {
  const sched = useSchedulerStatus()
  const [worker, setWorker] = createSignal<SwarmActiveState>(getSwarmActiveState())
  const unsub = subscribeSwarmActiveState(setWorker)
  onCleanup(unsub)

  return createMemo<SwarmStateDetail>(() => {
    const w = worker()
    const s = sched.status()
    const reasons = deriveReasons(w, s, sched.loading())

    return {
      ready: reasons.length === 0,
      reasons,
      nodesTotal: s.nodes.length,
      nodesAvailable: s.nodes.filter((n) => n.status === "available").length,
      nodesWaiting: s.nodes.filter((n) => n.status !== "available").length,
      clusterStatus: s.status,
      schedulerReachable: s.reachable,
      workerPhase: w.phase,
      model: w.swarmModel ?? s.model,
      swarmId: w.swarmId,
    }
  })
}
