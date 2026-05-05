// Client du fabi-registry — service d'auto-discovery des swarms.
//
// Le registry tourne sur le serveur d'orchestration et expose la liste des
// schedulers Parallax disponibles via `GET /v1/swarms`. Cf
// `packages/fabi-registry/` dans le meta-projet pour le service côté serveur.
//
// Côté CLI :
//   - Au démarrage de la TUI / du `fabi run`, on appelle le registry pour
//     résoudre {schedulerUrl, schedulerPeer} dynamiquement
//   - L'utilisateur peut overrider via `--scheduler-peer` (skip registry)
//   - Si registry injoignable → fallback sur les valeurs hardcodées de
//     `defaults.ts`, en avertissant l'utilisateur
//
// Le contrat `RegistrySwarm` doit rester compatible avec `SwarmEntry` du
// package fabi-registry. Si tu modifies l'un, modifie l'autre.

import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "swarm.registry" })

/** Une entrée swarm telle que servie par GET /v1/swarms. */
export interface RegistrySwarm {
  id: string
  name: string
  schedulerUrl: string
  schedulerPeer: string | null
  model: string
  status: "online" | "offline" | "unknown"
  schedulerStatus: string | null
  peers: number
  totalVramGb: number
  lastSeen: string
  containerName?: string
}

/** Wrapper de la réponse complète de l'API. */
interface RegistryResponse {
  apiVersion: "v1"
  generatedAt: string
  host: string
  swarms: RegistrySwarm[]
}

export interface FetchOptions {
  /** Timeout total de la requête (défaut 3000ms). */
  timeoutMs?: number
}

/**
 * Récupère la liste complète des swarms depuis le registry. Throw en cas
 * d'erreur (timeout, 5xx, JSON invalide).
 */
export async function fetchRegistrySwarms(
  registryUrl: string,
  opts: FetchOptions = {},
): Promise<RegistrySwarm[]> {
  const url = `${registryUrl.replace(/\/+$/, "")}/v1/swarms`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 3000)
  try {
    const res = await fetch(url, { method: "GET", signal: ctrl.signal })
    if (!res.ok) throw new Error(`registry returned ${res.status} ${res.statusText}`)
    const json = (await res.json()) as RegistryResponse
    if (!Array.isArray(json.swarms)) {
      throw new Error("registry response missing 'swarms' array")
    }
    return json.swarms
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Sélection de swarm
// ---------------------------------------------------------------------------

export interface DiscoverOptions {
  /** URL du registry. */
  registryUrl: string
  /** Préférence sur l'id (--swarm). */
  preferredId?: string
  /** Préférence sur le modèle (--swarm-model). */
  preferredModel?: string
  /** Si true, on accepte aussi un swarm en `offline` (déconseillé). */
  acceptOffline?: boolean
  /** Timeout fetch. */
  timeoutMs?: number
}

export type DiscoverResult =
  | { kind: "ok"; swarm: RegistrySwarm; allSwarms: RegistrySwarm[] }
  | { kind: "no-match"; reason: string; allSwarms: RegistrySwarm[] }
  | { kind: "registry-error"; error: Error }

/**
 * Choisit un swarm depuis le registry selon les préférences user.
 *
 * Stratégie :
 *   1. Filtre les swarms selon `acceptOffline`
 *   2. Si `preferredId` matche → return
 *   3. Si `preferredModel` matche → return le 1er
 *   4. Sinon, return le 1er (alphabétique)
 *
 * Ne throw jamais — toute erreur réseau ou logique est encapsulée dans
 * un `DiscoverResult`. L'appelant décide de fallback ou pas.
 */
export async function discoverSwarm(opts: DiscoverOptions): Promise<DiscoverResult> {
  let allSwarms: RegistrySwarm[]
  try {
    allSwarms = await fetchRegistrySwarms(opts.registryUrl, { timeoutMs: opts.timeoutMs ?? 3000 })
  } catch (err) {
    log.debug("registry fetch failed", { url: opts.registryUrl, error: (err as Error).message })
    return { kind: "registry-error", error: err as Error }
  }

  const usable = allSwarms.filter((s) => {
    if (!s.schedulerPeer) return false // pas exploitable sans peer ID
    if (!s.schedulerUrl) return false
    if (!opts.acceptOffline && s.status !== "online") return false
    return true
  })

  if (usable.length === 0) {
    return {
      kind: "no-match",
      reason: allSwarms.length === 0 ? "registry empty" : "no usable swarm (offline or missing peer)",
      allSwarms,
    }
  }

  // 1. ID exact
  if (opts.preferredId) {
    const byId = usable.find((s) => s.id === opts.preferredId)
    if (byId) return { kind: "ok", swarm: byId, allSwarms }
    return {
      kind: "no-match",
      reason: `no swarm with id="${opts.preferredId}"`,
      allSwarms,
    }
  }

  // 2. Match modèle (substring case-insensitive — facilite "qwen" pour matcher "Qwen/Qwen3-Coder-30B")
  if (opts.preferredModel) {
    const needle = opts.preferredModel.toLowerCase()
    const byModel = usable.find((s) => s.model.toLowerCase().includes(needle))
    if (byModel) return { kind: "ok", swarm: byModel, allSwarms }
    return {
      kind: "no-match",
      reason: `no swarm matching model="${opts.preferredModel}"`,
      allSwarms,
    }
  }

  // 3. Premier dispo (sorted alpha par le registry)
  return { kind: "ok", swarm: usable[0]!, allSwarms }
}
