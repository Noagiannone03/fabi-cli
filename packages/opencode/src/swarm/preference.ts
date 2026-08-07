// Persistance du dernier swarm choisi par l'utilisateur.
//
// Pourquoi un fichier dédié plutôt que la config opencode : le choix du swarm
// (modèle + id) est une préférence runtime de Fabi, résolue AU BOOT (dans le
// middleware yargs) avant que la config TUI ne soit chargée. On la stocke donc
// à côté du runtime Fabi, en best-effort (toute erreur d'I/O est avalée — une
// préférence illisible ne doit jamais empêcher fabi de démarrer).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import * as Log from "@opencode-ai/core/util/log"
import { fabiDataRoot } from "./paths"

const log = Log.create({ service: "swarm.preference" })

export interface SwarmPreference {
  /** Modèle HuggingFace du dernier swarm choisi (ex: "Qwen/Qwen3-Coder-30B"). */
  swarmModel?: string
  /** Id registry du dernier swarm choisi (match exact au boot). */
  swarmId?: string
}

function prefDir(): string {
  return fabiDataRoot()
}

function prefPath(): string {
  return join(prefDir(), "preferences.json")
}

/** Lit la préférence persistée. Renvoie `{}` si absente/illisible. */
export function readSwarmPreference(): SwarmPreference {
  try {
    const p = prefPath()
    if (!existsSync(p)) return {}
    const obj = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>
    return {
      swarmModel: typeof obj.swarmModel === "string" ? obj.swarmModel : undefined,
      swarmId: typeof obj.swarmId === "string" ? obj.swarmId : undefined,
    }
  } catch (e) {
    log.debug("read preference failed", { error: (e as Error).message })
    return {}
  }
}

/** Écrit la préférence (best-effort). */
export function writeSwarmPreference(pref: SwarmPreference): void {
  try {
    mkdirSync(prefDir(), { recursive: true })
    writeFileSync(prefPath(), JSON.stringify(pref, null, 2))
  } catch (e) {
    log.debug("write preference failed", { error: (e as Error).message })
  }
}
