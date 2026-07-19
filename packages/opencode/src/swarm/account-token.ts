// Jeton de compte Fabi — identité unique partagée entre le worker (contribution)
// et le client (consommation). La porte de contribution du scheduler (FABI_GATE)
// débloque la consommation tant que ce compte a un worker actif.
//
// Stocké dans ~/.config/fabi/account-token — MÊME emplacement que l'IDE Fabi,
// donc un seul compte pour le CLI et l'IDE. C'est une vraie credential bearer :
// elle reste invisible pour l'utilisateur, ne doit jamais être loguée et ne
// transite que via TLS / RPC Lattica chiffré.

import { randomBytes } from "crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "fs"
import { homedir } from "os"
import { join } from "path"

let cached: string | undefined
const VALID_TOKEN = /^[0-9a-f]{64}$/i

export function normalizeAccountToken(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized && VALID_TOKEN.test(normalized) ? normalized.toLowerCase() : undefined
}

function tokenPath(): string {
  return join(homedir(), ".config", "fabi", "account-token")
}

/** Renvoie le jeton de compte, en le générant (32 octets hex) au 1er appel.
 * Idempotent, mis en cache. Best-effort si le FS n'est pas inscriptible. */
export function getAccountToken(): string {
  if (cached) return cached
  const path = tokenPath()
  const fromEnvironment = process.env.FABI_ACCOUNT_TOKEN?.trim()
  if (fromEnvironment) {
    const normalized = normalizeAccountToken(fromEnvironment)
    if (!normalized) {
      throw new Error("FABI_ACCOUNT_TOKEN must contain exactly 32 hexadecimal bytes")
    }
    cached = normalized
    return cached
  }
  if (existsSync(path)) {
    try {
      const existing = readFileSync(path, "utf-8").trim()
      const normalized = normalizeAccountToken(existing)
      if (normalized) {
        cached = normalized
        return cached
      }
      throw new Error(`invalid Fabi credential in ${path}; refusing to rotate account identity silently`)
    } catch (error) {
      throw new Error(`unable to read Fabi credential ${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const token = randomBytes(32).toString("hex")
  try {
    mkdirSync(join(homedir(), ".config", "fabi"), { recursive: true, mode: 0o700 })
    writeFileSync(path, token + "\n", { encoding: "utf-8", mode: 0o600, flag: "wx" })
    try {
      chmodSync(path, 0o600)
    } catch {
      /* chmod best-effort */
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const existing = readFileSync(path, "utf-8").trim()
      const normalized = normalizeAccountToken(existing)
      if (normalized) {
        cached = normalized
        return cached
      }
    }
    /* FS non inscriptible → credential éphémère de session */
  }
  cached = token
  return cached
}
