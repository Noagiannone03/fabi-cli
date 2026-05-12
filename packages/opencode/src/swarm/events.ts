// Parser pour les events structurés `[FABI] {json}` émis par notre fork du
// worker Parallax (cf swarm-engine/src/parallax_utils/fabi_events.py).
//
// Le worker stdout est branché sur le pipe `child.stdout` côté Node ; on
// reçoit des Buffers qui peuvent contenir plusieurs lignes (ou des lignes
// coupées au milieu si la donnée arrive en plusieurs chunks). Cette classe
// fait du framing ligne par ligne (buffer interne jusqu'au `\n`), tague les
// lignes commençant par `[FABI] ` comme events, et délègue le reste.
//
// Conception :
//   - One instance per worker spawn (state local au stream)
//   - Pas de dépendance externe : peut être utilisé hors TUI
//   - Si un event a un format inattendu, on l'ignore silencieusement —
//     l'objectif est que la moindre erreur côté worker n'écroule pas la UI.

import { patchSwarmActiveState } from "./state"

const EVENT_PREFIX = "[FABI] "

/**
 * Forme connue d'un event. On garde un `Record<string, unknown>` pour les
 * champs additionnels que le worker peut ajouter au fil du temps sans
 * forcer une mise à jour du CLI.
 */
interface FabiEvent extends Record<string, unknown> {
  event: string
  ts?: number
}

/**
 * Stream parser ligne-par-ligne. Construit un buffer jusqu'au `\n`, puis
 * pour chaque ligne complète :
 *   - si elle commence par `[FABI] ` → tente de parser comme event JSON et
 *     pousse l'effet correspondant dans `swarm/state`
 *   - sinon → appelle `onPlain(line)` si fourni (ring buffer / verbose log)
 */
export class FabiEventStream {
  private buffer = ""

  constructor(private readonly onPlain?: (line: string) => void) {}

  ingest(chunk: Buffer | string): void {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString()
    // On garde la queue après le dernier `\n` (ligne potentiellement partielle).
    let idx = this.buffer.indexOf("\n")
    while (idx >= 0) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, "")
      this.buffer = this.buffer.slice(idx + 1)
      if (line.length > 0) this.handleLine(line)
      idx = this.buffer.indexOf("\n")
    }
  }

  /** À appeler au close du process pour vider la dernière ligne sans `\n`. */
  flush(): void {
    if (this.buffer.length > 0) {
      const line = this.buffer.replace(/\r$/, "")
      this.buffer = ""
      if (line.length > 0) this.handleLine(line)
    }
  }

  private handleLine(line: string): void {
    if (!line.startsWith(EVENT_PREFIX)) {
      this.onPlain?.(line)
      return
    }
    const json = line.slice(EVENT_PREFIX.length)
    let evt: FabiEvent
    try {
      evt = JSON.parse(json) as FabiEvent
    } catch {
      // Ligne corrompue (chunk au milieu, JSON invalide) — ignore.
      this.onPlain?.(line)
      return
    }
    if (typeof evt?.event !== "string") return
    applyEventToState(evt)
  }
}

/**
 * Map un event vers le patch correspondant dans `swarm/state`. Garder cette
 * logique CENTRALISÉE : un seul endroit où savoir quel event change quoi.
 */
function applyEventToState(evt: FabiEvent): void {
  switch (evt.event) {
    case "peer_id": {
      const peer = typeof evt.peer_id === "string" ? evt.peer_id : undefined
      if (peer) {
        patchSwarmActiveState({ workerPeerId: peer, workerStage: "handshake" })
      }
      return
    }
    case "joining_scheduler": {
      patchSwarmActiveState({ workerStage: "joining" })
      return
    }
    case "allocated": {
      const start = typeof evt.start_layer === "number" ? evt.start_layer : undefined
      const end = typeof evt.end_layer === "number" ? evt.end_layer : undefined
      patchSwarmActiveState({
        workerStage: "loading-weights",
        workerStartLayer: start,
        workerEndLayer: end,
      })
      return
    }
    case "alloc_timeout": {
      // Worker va exit(1) juste après. La phase passera à "crashed" via le
      // close handler de worker.ts ; en attendant on signale spécifiquement
      // qu'on a timeout (différent d'un crash applicatif).
      patchSwarmActiveState({
        workerStage: "alloc-timeout",
        lastError: "scheduler couldn't allocate layers within 300s",
      })
      return
    }
    case "weights_load_start": {
      const total = typeof evt.files_total === "number" ? evt.files_total : undefined
      patchSwarmActiveState({
        workerStage: "loading-weights",
        weightsFilesDone: 0,
        weightsFilesTotal: total,
      })
      return
    }
    case "weights_load_progress": {
      const done = typeof evt.files_done === "number" ? evt.files_done : undefined
      const total = typeof evt.files_total === "number" ? evt.files_total : undefined
      patchSwarmActiveState({
        workerStage: "loading-weights",
        weightsFilesDone: done,
        weightsFilesTotal: total,
      })
      return
    }
    case "weights_load_done": {
      const total = typeof evt.files_total === "number" ? evt.files_total : undefined
      patchSwarmActiveState({
        workerStage: "ready",
        weightsFilesDone: total,
        weightsFilesTotal: total,
      })
      return
    }
    default:
      // Event inconnu : on le laisse passer silencieusement. Permet d'ajouter
      // de nouveaux events côté worker sans casser un CLI plus ancien.
      return
  }
}
