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
 * Sémantique alignée sur le fork swarm-engine (cf swarm-engine/src/scheduling) :
 *
 *   NodeState.ACTIVE  ⇔  node alloué à un pipeline (porte des layers)
 *   NodeState.STANDBY ⇔  node connecté mais en réserve (rien à servir)
 *
 *   node.is_active === True   ⇔  node a fini son refit → prêt à servir
 *   node.is_active === False  ⇔  jamais alloué OU en train de refit
 *
 *   cluster.status === "available"  ⇔  has_full_pipeline() : il existe au
 *                                       moins UNE chaîne de nodes ACTIVE
 *                                       couvrant tous les layers (même si
 *                                       ces nodes sont encore en refit)
 *   cluster.status === "waiting"    ⇔  aucune chaîne complète allocable
 *
 * **Signal solide pour distinguer les cas en `status="waiting"`** :
 *   le fork Fabi expose `last_bootstrap_result` qui dit EXPLICITEMENT
 *   pourquoi le scheduler attend :
 *     - "deferred_not_enough_nodes" → sous le seuil min_nodes_bootstrapping
 *     - "failed_capacity"           → assez de nodes mais l'alloc des layers
 *                                     n'a pas tenu (capacité GPU insuffisante)
 *     - "pending" / null            → round en cours (transitoire)
 *     - "success"                   → pipeline formé (status devrait être
 *                                     "available", sauf re-bootstrap en cours)
 *   Plus de timer arbitraire — on lit le verdict du scheduler directement.
 *
 * **Signal solide pour distinguer "downloading" vs "ready"** :
 *   le fork Fabi expose `loading_phase` par node (joining / initializing /
 *   ready / offline / error) — propagé depuis la `ServerState` du worker
 *   Parallax. Un node en "initializing" télécharge/charge ses layers.
 *
 * `need_more_nodes` exposé par /cluster/status_json est volontairement
 * IGNORÉ : il flippe à False dès le premier bootstrap (même raté), donc
 * il ment dans le cas typique "j'ai pas assez de capacité pour ce modèle".
 * On utilise `last_bootstrap_result` à la place.
 */
export type SwarmBlockingReason =
  | { kind: "worker-not-started"; phase: SwarmWorkerPhase }
  | { kind: "worker-crashed"; lastError?: string }
  | { kind: "worker-missing-binary" }
  | { kind: "scheduler-unreachable" }
  | { kind: "connecting-to-swarm" }
  /** Sous le seuil opérateur (`min_nodes_bootstrapping`). Le scheduler ne tentera même pas l'alloc. */
  | { kind: "need-more-peers"; nodesTotal: number }
  /** bootstrap a échoué : capacité insuffisante. Plus de peers répartiraient les layers. */
  | { kind: "insufficient-capacity"; nodesTotal: number }
  /**
   * Pipeline alloué côté scheduler, le worker télécharge/charge le modèle.
   * Quand notre worker a émis un event `weights_load_*`, on a les compteurs
   * (filesDone/filesTotal) — vrai progress, pas une approximation.
   */
  | {
      kind: "loading-model"
      nodesTotal: number
      nodesInitializing: number
      /** Si on connaît l'allocation : nombre de layers à charger pour ce node. */
      layersAssigned?: number
      /** Progress concret depuis les events worker. */
      filesDone?: number
      filesTotal?: number
    }
  /**
   * Worker a reçu un timeout d'allocation du scheduler (300s sans layers).
   * Event `alloc_timeout` du worker — pas une heuristique : le worker LE DIT.
   */
  | { kind: "alloc-timeout" }

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

  // Signaux directs du worker, rebalancés pour l'UI (forwarder pour ne pas
  // forcer chaque consommateur à importer swarm/state).
  workerStage?: SwarmActiveState["workerStage"]
  workerPeerId?: string
  weightsCurrentFile?: string
  weightsFilesDone?: number
  weightsFilesTotal?: number
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
      // Quand le worker n'est pas encore running, le reste n'a pas de
      // sens : on retourne tôt pour ne pas afficher 4 raisons en cascade.
      return reasons
    }
    // Signaux directs depuis les events `[FABI] {...}` du worker. Quand on
    // les a, ils battent toujours les inférences faites depuis le scheduler.
    if (worker.workerStage === "alloc-timeout") {
      reasons.push({ kind: "alloc-timeout" })
      return reasons
    }
    if (worker.workerStage === "loading-weights") {
      // Le worker NOUS a dit qu'il charge des weights — on peut court-
      // circuiter la vue scheduler et afficher le vrai progress local.
      const assigned =
        worker.workerStartLayer !== undefined && worker.workerEndLayer !== undefined
          ? worker.workerEndLayer - worker.workerStartLayer
          : undefined
      reasons.push({
        kind: "loading-model",
        nodesTotal: sched.nodes.length || 1,
        nodesInitializing: 1,
        layersAssigned: assigned,
        filesDone: worker.weightsFilesDone,
        filesTotal: worker.weightsFilesTotal,
      })
      return reasons
    }
    // running mais pas encore d'events worker → on tombe sur la vue scheduler
  }

  // --- Scheduler distant ---
  // Tant que le premier fetch n'a pas répondu, on évite de gueuler
  // "unreachable" — on attend silencieusement.
  if (!sched.reachable) {
    if (!schedLoading) reasons.push({ kind: "scheduler-unreachable" })
    return reasons
  }

  const nodesTotal = sched.nodes.length
  const nodesActive = sched.nodes.filter((n) => n.status === "available").length
  // Nodes en cours de chargement de leur shard de modèle. On préfère le
  // `loading_phase` (exposé par notre fork swarm-engine) au flag binaire
  // `is_active` : un node en "initializing" est explicitement en train de
  // télécharger/charger les layers qu'on lui a alloués.
  const nodesInitializing = sched.nodes.filter(
    (n) => n.loading_phase === "initializing",
  ).length

  // --- Pipeline formé côté scheduler ---
  if (sched.status === "available") {
    // Au moins un node a fini son refit ⇒ le pipeline est servable.
    // Les autres nodes "waiting" peuvent être en STANDBY (réserve, pas de
    // popup nécessaire — on peut chatter via le pipeline actif) ou bien en
    // cours d'init dans un autre pipeline — pas bloquant non plus.
    if (nodesActive > 0) return reasons // → ready, gate ferme

    // Pipeline alloué mais aucun node n'a fini son refit. On affiche le
    // chargement avec, si dispo, le nombre de layers à charger pour notre
    // node (info précieuse pour calibrer l'attente : 4 layers ≠ 30 layers).
    const myNode = sched.nodes.find((n) => n.loading_phase === "initializing") ?? sched.nodes[0]
    const layersAssigned =
      myNode && typeof myNode.start_layer === "number" && typeof myNode.end_layer === "number"
        ? myNode.end_layer - myNode.start_layer
        : undefined
    reasons.push({
      kind: "loading-model",
      nodesTotal,
      nodesInitializing,
      layersAssigned,
    })
    return reasons
  }

  // --- cluster.status === "waiting" : pas de pipeline ---
  if (nodesTotal === 0) {
    // Pas encore de node visible côté scheduler — handshake Lattica/P2P en
    // cours. Si notre worker rapporte "joining", c'est explicitement notre
    // handshake. Sinon (worker pas démarré, swarm vide), même message.
    reasons.push({ kind: "connecting-to-swarm" })
    return reasons
  }

  // On a des nodes mais pas de pipeline. Le scheduler nous DIT pourquoi via
  // last_bootstrap_result (fork Fabi). Plus de timer arbitraire — on lit
  // directement l'état réel du bootstrap.
  const bootstrap = sched.lastBootstrapResult
  const initNodes = sched.initNodesNum ?? 1

  if (bootstrap === "failed_capacity") {
    // Le scheduler a essayé d'allouer les layers et n'a pas réussi à former
    // un pipeline complet avec les peers actuels. Ajouter des peers PEUT
    // débloquer (plus de RAM disponible pour shard le modèle).
    reasons.push({ kind: "insufficient-capacity", nodesTotal })
    return reasons
  }

  if (bootstrap === "deferred_not_enough_nodes" || nodesTotal < initNodes) {
    // Sous le seuil. Le scheduler attend explicitement plus de nodes avant
    // de tenter quoi que ce soit. Pas d'ambiguïté.
    reasons.push({ kind: "need-more-peers", nodesTotal })
    return reasons
  }

  if (bootstrap === "pending" || bootstrap === null) {
    // Round de bootstrap en cours OU pas encore tenté (scheduler vient de
    // démarrer). C'est transitoire : un nouveau join va le déclencher.
    reasons.push({ kind: "connecting-to-swarm" })
    return reasons
  }

  // bootstrap === "success" mais status="waiting" : c'est contradictoire
  // (le scheduler a réussi un bootstrap mais le pipeline est cassé depuis).
  // Cas possible : un node ACTIVE a quitté, on est en re-bootstrap. Conservons
  // un état "connecting" parce que ça va se résoudre dès le prochain join.
  reasons.push({ kind: "connecting-to-swarm" })
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
      workerStage: w.workerStage,
      workerPeerId: w.workerPeerId,
      weightsCurrentFile: w.weightsCurrentFile,
      weightsFilesDone: w.weightsFilesDone,
      weightsFilesTotal: w.weightsFilesTotal,
    }
  })
}
