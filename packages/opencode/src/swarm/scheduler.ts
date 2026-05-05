// Healthcheck du scheduler Aircarto.
//
// Le scheduler Parallax expose /cluster/status_json avec des infos utiles
// (statut, modèle servi, nombre de workers connectés). On l'appelle au boot
// pour donner du feedback à l'utilisateur, sans jamais bloquer le démarrage.

import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "swarm.scheduler" })

export interface SchedulerInfo {
  /** Le scheduler répond et a renvoyé un JSON valide. */
  reachable: boolean
  /** Statut du cluster ("waiting", "ready", etc.) si dispo. */
  status?: string
  /** Modèle servi par le scheduler (ex: "Qwen/Qwen3-Coder-30B-A3B-Instruct"). */
  model?: string
  /** Nombre de workers (peers) connectés au swarm. */
  nodeCount?: number
}

/**
 * Healthcheck du scheduler. Ne throw jamais — tout problème → reachable: false.
 *
 * @param schedulerUrl URL HTTP du scheduler (sans trailing slash)
 * @param timeoutMs    timeout total de la requête
 */
export async function checkScheduler(schedulerUrl: string, timeoutMs: number): Promise<SchedulerInfo> {
  const url = `${schedulerUrl.replace(/\/+$/, "")}/cluster/status_json`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { method: "GET", signal: ctrl.signal })
    if (!res.ok) {
      log.warn("scheduler returned non-2xx", { url, status: res.status })
      return { reachable: false }
    }
    const json = (await res.json()) as {
      data?: { status?: string; model_name?: string; node_list?: unknown[] }
    }
    const data = json.data ?? {}
    const info: SchedulerInfo = {
      reachable: true,
      status: data.status,
      model: data.model_name,
      nodeCount: Array.isArray(data.node_list) ? data.node_list.length : undefined,
    }
    log.debug("scheduler reachable", info)
    return info
  } catch (err) {
    log.debug("scheduler unreachable", { url, error: (err as Error).message })
    return { reachable: false }
  } finally {
    clearTimeout(timer)
  }
}
