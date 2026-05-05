// Installer interactif de Parallax.
//
// Philosophie Fabi : "tu codes = tu contribues". On veut que `npm i -g fabi`
// reste instantané (~10 MB de wrapper TS), mais qu'au 1er lancement on
// PROPOSE d'installer le runtime Parallax (Python + PyTorch + vLLM/MLX) plutôt
// que de demander à l'utilisateur de copier-coller des commandes shell.
//
// Stratégie : on délègue à `pip` dans un venv isolé sous `~/.local/share/fabi/runtime/`.
// pip gère les wheels CUDA/MLX/CPU automatiquement selon la plateforme — bien
// mieux qu'un installer custom qui devrait reproduire cette logique.
//
// Sources possibles (par ordre de priorité) :
//   1. env FABI_PARALLAX_SOURCE  (override explicite, accepte path local OU pkg PyPI OU git+https)
//   2. clone local du fork swarm-engine si dispo (= dev local du méta-projet)
//   3. git+https://github.com/GradientHQ/parallax.git (le vrai Parallax — PAS le package "parallax" sur PyPI qui est un autre projet SSH)

import { spawn } from "node:child_process"
import { existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import * as Log from "@opencode-ai/core/util/log"
import * as UI from "../cli/ui"

const log = Log.create({ service: "swarm.installer" })
const HERE = dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// Chemins gérés
// ---------------------------------------------------------------------------

/** Racine de l'install Parallax géré par Fabi. */
function installRoot(): string {
  const data = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share")
  return join(data, "fabi", "runtime")
}

/** Dossier `bin` du venv créé par l'installer. */
export function venvBinDir(): string {
  return join(installRoot(), ".venv", process.platform === "win32" ? "Scripts" : "bin")
}

/** Path attendu du binaire `parallax` après install. */
export function managedParallaxBin(): string {
  return join(venvBinDir(), process.platform === "win32" ? "parallax.exe" : "parallax")
}

/** Path attendu du binaire `pip` du venv. */
function venvPipBin(): string {
  return join(venvBinDir(), process.platform === "win32" ? "pip.exe" : "pip")
}

/** Path attendu du binaire `python` du venv. */
function venvPythonBin(): string {
  return join(venvBinDir(), process.platform === "win32" ? "python.exe" : "python")
}

// ---------------------------------------------------------------------------
// Détection Python système
// ---------------------------------------------------------------------------

interface CmdResult {
  exitCode: number
  stdout: string
  stderr: string
}

async function captureCmd(cmd: string, args: string[]): Promise<CmdResult> {
  return new Promise((resolveResult) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString()
    })
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString()
    })
    child.on("close", (code) => resolveResult({ exitCode: code ?? 1, stdout, stderr }))
    child.on("error", () => resolveResult({ exitCode: 1, stdout, stderr }))
  })
}

/** Stream stdout/stderr du sous-process directement vers le terminal. */
async function streamCmd(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolveCode) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "inherit", "inherit"], env: process.env })
    child.on("close", (code) => resolveCode(code ?? 1))
    child.on("error", () => resolveCode(1))
  })
}

/**
 * Trouve un Python ≥ 3.10 dans le PATH. Renvoie la commande à utiliser
 * (typiquement "python3" sur Linux/macOS, "python" sur Windows / certains
 * setups Mac via pyenv).
 */
async function findSystemPython(): Promise<string | null> {
  const candidates = process.platform === "win32" ? ["python", "python3"] : ["python3", "python"]
  for (const cmd of candidates) {
    const r = await captureCmd(cmd, ["--version"])
    if (r.exitCode !== 0) continue
    const versionLine = (r.stdout + r.stderr).trim()
    const m = /Python (\d+)\.(\d+)/.exec(versionLine)
    if (!m) continue
    const major = parseInt(m[1], 10)
    const minor = parseInt(m[2], 10)
    if (major === 3 && minor >= 10) {
      log.info("system python found", { cmd, version: versionLine })
      return cmd
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Source de Parallax à installer
// ---------------------------------------------------------------------------

interface SourceInfo {
  /** Chemin local OU nom de package PyPI. */
  spec: string
  /** Si vrai, on utilise `pip install -e <spec>` (editable, dev). */
  editable: boolean
  /** Description user-friendly pour le prompt. */
  display: string
}

function resolveSource(): SourceInfo {
  // 1. Override explicite via env
  const envSource = process.env.FABI_PARALLAX_SOURCE?.trim()
  if (envSource) {
    if (envSource.startsWith("/") || envSource.startsWith(".") || envSource.startsWith("~")) {
      const abs = envSource.startsWith("~") ? join(homedir(), envSource.slice(1)) : resolve(envSource)
      return { spec: abs, editable: true, display: `path local : ${abs}` }
    }
    return { spec: envSource, editable: false, display: `package : ${envSource}` }
  }

  // 2. Clone local du fork swarm-engine (dev du méta-projet Fabi)
  // Depuis ce fichier (...packages/fabi-cli/packages/opencode/src/swarm/installer.ts)
  // jusqu'à ...packages/swarm-engine = remonter de 5 niveaux
  const localFork = resolve(HERE, "..", "..", "..", "..", "..", "swarm-engine")
  if (existsSync(join(localFork, "setup.py")) || existsSync(join(localFork, "pyproject.toml"))) {
    return { spec: localFork, editable: true, display: `clone local : ${localFork}` }
  }

  // 3. Fallback : on installe le runtime Parallax directement depuis le repo Git
  // upstream (GradientHQ). Le package "parallax" sur PyPI est un AUTRE projet
  // (un outil SSH sans rapport) — il ne faut surtout pas l'utiliser comme fallback.
  // Override possible via FABI_PARALLAX_SOURCE pour pointer sur un fork.
  return {
    spec: "git+https://github.com/GradientHQ/parallax.git",
    editable: false,
    display: "git+https://github.com/GradientHQ/parallax.git",
  }
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type InstallResult =
  | { ok: true; binPath: string }
  | { ok: false; reason: InstallFailReason; message: string }

export type InstallFailReason =
  | "non-interactive"
  | "user-declined"
  | "python-missing"
  | "venv-failed"
  | "pip-failed"
  | "binary-not-found-after-install"

// ---------------------------------------------------------------------------
// Prompt interactif Y/n
// ---------------------------------------------------------------------------

async function confirm(question: string, defaultYes = true): Promise<boolean> {
  if (!process.stdin.isTTY) return false
  const suffix = defaultYes ? " [Y/n] " : " [y/N] "
  const answer = (await UI.input(question + suffix)).trim().toLowerCase()
  if (answer === "") return defaultYes
  return answer.startsWith("y") || answer === "o" || answer === "oui"
}

// ---------------------------------------------------------------------------
// Installation principale
// ---------------------------------------------------------------------------

/**
 * Tente d'installer Parallax dans `~/.local/share/fabi/runtime/.venv/`.
 *
 * - Si le binaire est déjà installé → renvoie son path sans rien faire
 * - Sinon : prompt user → si oui, lance `python -m venv` puis `pip install`
 * - Streame le progress de pip directement sur le terminal user
 *
 * **Bloquant** : peut prendre 5-15 min selon la connexion (PyTorch est gros).
 * L'utilisateur voit le progress et peut Ctrl+C.
 */
export async function tryInstallParallax(): Promise<InstallResult> {
  const binPath = managedParallaxBin()

  // Déjà installé ? On retourne tout de suite.
  if (existsSync(binPath)) {
    log.info("parallax already installed in managed venv", { binPath })
    return { ok: true, binPath }
  }

  // 1. Vérifier qu'on est dans un terminal interactif
  if (!process.stdin.isTTY) {
    return {
      ok: false,
      reason: "non-interactive",
      message:
        "Stdin n'est pas un TTY — installation interactive impossible. " +
        "Lance depuis un terminal, ou installe Parallax manuellement.",
    }
  }

  // 2. Vérifier Python
  const python = await findSystemPython()
  if (!python) {
    return {
      ok: false,
      reason: "python-missing",
      message:
        "Python 3.10+ requis et non trouvé dans le PATH. " +
        "Installe-le depuis https://www.python.org/ ou via ton package manager (apt, brew, pyenv, ...).",
    }
  }

  // 3. Prompt user
  const source = resolveSource()
  const dim = UI.Style.TEXT_DIM
  const reset = UI.Style.TEXT_NORMAL
  const bold = UI.Style.TEXT_NORMAL_BOLD
  const info = UI.Style.TEXT_INFO_BOLD

  process.stderr.write("\n")
  process.stderr.write(`${info}Fabi a besoin du runtime Parallax pour faire tourner un worker.${reset}\n`)
  process.stderr.write(`${dim}- Source     : ${source.display}${reset}\n`)
  process.stderr.write(`${dim}- Cible      : ${installRoot()}${reset}\n`)
  process.stderr.write(`${dim}- Python     : ${python}${reset}\n`)
  process.stderr.write(`${dim}- Taille DL  : ~1.5 GB (PyTorch + vLLM/MLX + deps)${reset}\n`)
  process.stderr.write(`${dim}- Durée      : 5-15 min selon ta connexion${reset}\n`)
  process.stderr.write("\n")

  const proceed = await confirm(`${bold}Installer Parallax maintenant ?${reset}`)
  if (!proceed) {
    return {
      ok: false,
      reason: "user-declined",
      message: "Installation annulée par l'utilisateur. Relance fabi quand tu veux installer.",
    }
  }

  // 4. Création du venv
  const root = installRoot()
  process.stderr.write(`\n${info}[fabi installer]${reset} Création du virtualenv...\n`)
  mkdirSync(root, { recursive: true })
  const venvPath = join(root, ".venv")
  const venvCode = await streamCmd(python, ["-m", "venv", venvPath])
  if (venvCode !== 0) {
    return {
      ok: false,
      reason: "venv-failed",
      message: `Échec création du venv (code ${venvCode}). Vérifie que ${python} a bien le module venv (apt: 'python3-venv').`,
    }
  }

  // 5. Upgrade pip (silencieux pour ne pas trop bruiter)
  const pip = venvPipBin()
  process.stderr.write(`${info}[fabi installer]${reset} Mise à jour de pip dans le venv...\n`)
  await streamCmd(venvPythonBin(), ["-m", "pip", "install", "--upgrade", "pip", "--quiet"])

  // 6. Installation de Parallax (le gros morceau)
  process.stderr.write(`\n${info}[fabi installer]${reset} Installation de Parallax depuis ${source.display}...\n`)
  process.stderr.write(`${dim}            Sois patient — PyTorch + vLLM peut prendre plusieurs minutes.${reset}\n\n`)
  const installArgs = source.editable ? ["install", "-e", source.spec] : ["install", source.spec]
  const installCode = await streamCmd(pip, installArgs)
  if (installCode !== 0) {
    return {
      ok: false,
      reason: "pip-failed",
      message: `Échec de pip install (code ${installCode}). Regarde les logs au-dessus pour la cause précise.`,
    }
  }

  // 7. Vérification finale
  if (!existsSync(binPath)) {
    return {
      ok: false,
      reason: "binary-not-found-after-install",
      message: `pip install est passé mais le binaire ${binPath} est absent. Le package ne fournit peut-être pas d'entry-point 'parallax'.`,
    }
  }

  process.stderr.write(`\n${info}[fabi installer]${reset} ${UI.Style.TEXT_SUCCESS}✅ Parallax installé avec succès${reset}\n`)
  process.stderr.write(`${dim}            Binaire : ${binPath}${reset}\n\n`)
  return { ok: true, binPath }
}
