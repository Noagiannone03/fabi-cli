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

import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
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
 * Sémantique alignée sur le code Parallax (cf swarm-engine/src/scheduling) :
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
 *   /cluster/status_json.node_list  =  TOUS les nodes (ACTIVE et STANDBY)
 *                                      avec `status` dérivé de `is_active`
 *
 * **Conséquence importante** : si M4 Pro (ACTIVE, is_active=True) porte
 * tout le modèle et M3 (STANDBY, is_active=False) est en redondance, on a
 * `node_list = [{status: "available"}, {status: "waiting"}]`. Le swarm
 * PEUT servir (le pipeline est formé et ready côté M4), mais une logique
 * naïve "nodesWaiting > 0 → loading" garderait le popup ouvert à tort.
 *
 * Règle correcte pour "ready à chatter" :
 *   cluster.status === "available"  ET  au moins UN node is_active=True
 *
 * Règle pour "encore en refit / téléchargement" :
 *   cluster.status === "available"  ET  AUCUN node is_active=True yet
 *   → c'est le cas du premier boot où le pipeline est alloué mais le node
 *     porteur n'a pas encore fini de charger ses layers.
 *
 * `need_more_nodes` exposé par /cluster/status_json est volontairement
 * IGNORÉ : il flippe à False dès le premier bootstrap (même raté), donc
 * il ment dans le cas typique "j'ai pas assez de capacité pour ce modèle".
 */
export type SwarmBlockingReason =
  | { kind: "worker-not-started"; phase: SwarmWorkerPhase }
  | { kind: "worker-crashed"; lastError?: string }
  | { kind: "worker-missing-binary" }
  | { kind: "scheduler-unreachable" }
  | { kind: "connecting-to-swarm" }
  | { kind: "need-more-peers"; nodesTotal: number }
  | { kind: "loading-model"; nodesWaiting: number; nodesTotal: number }

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

/**
 * Grace period UNIQUEMENT quand `nodes.length >= init_nodes_num` ET
 * `status="waiting"`. Couvre la staleness du poll (4s) + le temps que le
 * scheduler Parallax termine son round de bootstrap (`Scheduler.bootstrap()`
 * est appelé SYNCHRONIQUEMENT dans `_process_joins` dès qu'un node atteint le
 * seuil — ça prend ~100ms côté scheduler, mais notre poll peut tomber juste
 * avant). 8s = 2 cycles de poll, suffisant pour observer le résultat même au
 * pire timing. Après ça : si `status` est encore "waiting", l'allocation a
 * échoué pour de bon (capacité GPU insuffisante) et plus de peers aideraient.
 *
 * À l'inverse, si `nodes.length < init_nodes_num`, on est SOUS le seuil
 * opérateur — le scheduler ne tentera même PAS de bootstrap. Aucune raison
 * d'attendre : on affiche "need-more-peers" tout de suite.
 */
const BOOTSTRAP_GRACE_MS = 8_000

function deriveReasons(
  worker: SwarmActiveState,
  sched: SchedulerStatusDetail,
  schedLoading: boolean,
  nodesFirstSeenMs: number | null,
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
    // running → on n'ajoute rien ici, le scheduler dira si on est ready
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

  // --- Pipeline formé côté scheduler ---
  if (sched.status === "available") {
    // Au moins un node a fini son refit ⇒ le pipeline est servable.
    // Les autres nodes "waiting" sont soit en STANDBY (réserve, pas
    // dans le pipeline), soit en cours de refit dans un autre pipeline
    // (multi-shard) — ni l'un ni l'autre ne nous empêche de chatter.
    if (nodesActive > 0) {
      return reasons // pas de raison bloquante restante → ready
    }
    // Pipeline alloué mais AUCUN node n'a encore terminé son refit :
    // c'est le boot initial après allocation, on télécharge le modèle.
    reasons.push({ kind: "loading-model", nodesWaiting: nodesTotal, nodesTotal })
    return reasons
  }

  // --- cluster.status === "waiting" : pipeline non formé ---
  if (nodesTotal === 0) {
    // Personne n'est encore visible côté scheduler. Soit notre worker
    // n'a pas fini son handshake Lattica/P2P (cas usuel), soit le swarm
    // est vraiment vide. Dans les deux cas → "connecting".
    reasons.push({ kind: "connecting-to-swarm" })
    return reasons
  }

  // À partir d'ici : nodesTotal > 0 et status="waiting". Décide entre
  // "need-more-peers" et "connecting" SUR DES SIGNAUX RÉELS du scheduler.
  const initNodes = sched.initNodesNum ?? 1

  if (nodesTotal < initNodes) {
    // Sous le seuil opérateur (`min_nodes_bootstrapping`) : le scheduler ne
    // tentera PAS de bootstrap tant qu'on n'a pas atteint initNodes. Pas
    // d'ambiguïté possible → besoin de plus de peers, immédiat.
    reasons.push({ kind: "need-more-peers", nodesTotal })
    return reasons
  }

  // nodesTotal >= initNodes et status="waiting". Deux cas indistinguables
  // depuis l'API à un instant T :
  //   a) bootstrap() en cours / juste terminé mais notre poll est stale (4s)
  //   b) bootstrap() a échoué (capacité GPU/RAM insuffisante)
  //
  // Côté Parallax, bootstrap() est appelé synchroniquement dans
  // _process_joins() dès qu'un node franchit le seuil — donc (a) se résout
  // en ~100ms côté scheduler. On laisse 8s pour absorber 2 cycles de poll
  // (worst-case), après quoi on conclut que c'est (b) : un peer de plus
  // permettrait de répartir les layers et de former un pipeline.
  const ageMs = nodesFirstSeenMs !== null ? Date.now() - nodesFirstSeenMs : BOOTSTRAP_GRACE_MS
  if (ageMs < BOOTSTRAP_GRACE_MS) {
    reasons.push({ kind: "connecting-to-swarm" })
  } else {
    reasons.push({ kind: "need-more-peers", nodesTotal })
  }

  return reasons
}

export function useSwarmState(): () => SwarmStateDetail {
  const sched = useSchedulerStatus()
  const [worker, setWorker] = createSignal<SwarmActiveState>(getSwarmActiveState())
  const unsub = subscribeSwarmActiveState(setWorker)
  onCleanup(unsub)

  // Timestamp (ms) du premier poll où des nodes étaient visibles. Sert à la
  // grace period "connecting-to-swarm" avant de conclure "need-more-peers".
  // Remis à null si les nodes disparaissent (scheduler restart, etc.).
  const [nodesFirstSeenMs, setNodesFirstSeenMs] = createSignal<number | null>(null)
  createEffect(() => {
    const hasNodes = sched.status().nodes.length > 0
    if (hasNodes && nodesFirstSeenMs() === null) setNodesFirstSeenMs(Date.now())
    else if (!hasNodes && nodesFirstSeenMs() !== null) setNodesFirstSeenMs(null)
  })

  return createMemo<SwarmStateDetail>(() => {
    const w = worker()
    const s = sched.status()
    const reasons = deriveReasons(w, s, sched.loading(), nodesFirstSeenMs())

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
