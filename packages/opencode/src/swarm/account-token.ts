// Jeton de compte Fabi — identité unique partagée entre le worker (contribution)
// et le client (consommation). La porte de contribution du scheduler (FABI_GATE)
// débloque la consommation tant que ce compte a un worker actif.
//
// Stocké dans ~/.config/fabi/account-token — MÊME emplacement que l'IDE Fabi,
// donc un seul compte pour le CLI et l'IDE. Pas un secret de haute sécurité :
// juste un identifiant, transmis uniquement par canaux chiffrés (TLS vers /v1,
// RPC lattica pour le worker).

import { randomBytes } from "crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "fs"
import { homedir } from "os"
import { join } from "path"

let cached: string | undefined

function tokenPath(): string {
  return join(homedir(), ".config", "fabi", "account-token")
}

/** Renvoie le jeton de compte, en le générant (32 octets hex) au 1er appel.
 * Idempotent, mis en cache. Best-effort si le FS n'est pas inscriptible. */
export function getAccountToken(): string {
  if (cached) return cached
  const path = tokenPath()
  try {
    if (existsSync(path)) {
      const existing = readFileSync(path, "utf-8").trim()
      if (existing) {
        cached = existing
        return cached
      }
    }
  } catch {
    /* illisible → on régénère */
  }
  const token = randomBytes(32).toString("hex")
  try {
    mkdirSync(join(homedir(), ".config", "fabi"), { recursive: true })
    writeFileSync(path, token + "\n", { encoding: "utf-8" })
    try {
      chmodSync(path, 0o600)
    } catch {
      /* chmod best-effort */
    }
  } catch {
    /* FS non inscriptible → jeton éphémère de session */
  }
  cached = token
  return cached
}
