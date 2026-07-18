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
//   1. venv bundlé dans le tarball Fabi (runtime/parallax-venv/) — court-circuit total
//   2. env FABI_PARALLAX_SOURCE  (override explicite, accepte path local OU URL git)
//   3. clone local du fork swarm-engine si dispo (= dev local du méta-projet)
//   4. checkout du commit qualifié de Noagiannone03/swarm-engine
//      dans ~/.local/share/fabi/runtime/parallax-src/ puis pip install -e .
//      IMPORTANT : on passe par un clone + editable car le pyproject.toml
//      upstream a un build-backend poetry-core qui ignore les sous-packages
//      en mode wheel (`pip install git+https://`). Le mode editable expose
//      le source dir via .pth → tous les sous-packages visibles.
//      Le SHA immuable évite qu'une branche mutable change le runtime après
//      qualification sans nouvelle version du CLI.

import { spawn } from "node:child_process"
import { existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import * as Log from "@opencode-ai/core/util/log"
import * as UI from "../cli/ui"
import { isCommitSha, managedCloneArgs, QUALIFIED_PARALLAX_COMMIT } from "./runtime-source"

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

/** Nom du venv créé par l'installer interactif (fallback). */
const INTERACTIVE_VENV_NAME = ".venv"

/** Nom du venv bundlé dans le tarball Fabi (priorité). */
const BUNDLED_VENV_NAME = "parallax-venv"

function binSubdir(): string {
  return process.platform === "win32" ? "Scripts" : "bin"
}

function parallaxFileName(): string {
  return process.platform === "win32" ? "parallax.exe" : "parallax"
}

/** Dossier `bin` du venv interactif (fallback). */
export function venvBinDir(): string {
  return join(installRoot(), INTERACTIVE_VENV_NAME, binSubdir())
}

/** Dossier `bin` du venv bundlé dans le tarball. */
function bundledVenvBinDir(): string {
  return join(installRoot(), BUNDLED_VENV_NAME, binSubdir())
}

/**
 * Path du binaire `parallax` à utiliser — préfère le venv bundlé du tarball
 * si présent, sinon retombe sur le venv créé par l'installer interactif.
 */
export function managedParallaxBin(): string {
  const bundled = join(bundledVenvBinDir(), parallaxFileName())
  if (existsSync(bundled)) return bundled
  return join(venvBinDir(), parallaxFileName())
}

/** Path attendu du binaire `pip` du venv interactif. */
function venvPipBin(): string {
  return join(venvBinDir(), process.platform === "win32" ? "pip.exe" : "pip")
}

/** Path attendu du binaire `python` du venv interactif. */
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
  /** Path local du clone Parallax — utilisé pour `pip install -e <path>`. */
  localPath: string
  /** URL git si on doit cloner (sinon undefined = path déjà prêt). */
  cloneUrl?: string
  /** Branche, tag ou commit à checkout. */
  cloneRef?: string
  /** Description user-friendly pour le prompt. */
  display: string
}

const FORK_PARALLAX_GIT = "https://github.com/Noagiannone03/swarm-engine.git"

function resolveSource(): SourceInfo {
  // 1. Override explicite via env (path local OU URL git)
  const envSource = process.env.FABI_PARALLAX_SOURCE?.trim()
  if (envSource) {
    // Chemin local → utilisable directement
    if (envSource.startsWith("/") || envSource.startsWith(".") || envSource.startsWith("~")) {
      const abs = envSource.startsWith("~") ? join(homedir(), envSource.slice(1)) : resolve(envSource)
      return { localPath: abs, display: `clone local : ${abs}` }
    }
    // URL git (https/git+https/ssh) → on clone ce fork
    const cloneUrl = envSource.replace(/^git\+/, "")
    const cloneRef = process.env.FABI_PARALLAX_REF?.trim() || undefined
    return {
      localPath: join(installRoot(), "parallax-src"),
      cloneUrl,
      cloneRef,
      display: `git clone : ${cloneUrl}${cloneRef ? `@${cloneRef}` : ""}`,
    }
  }

  // 2. Clone local du fork swarm-engine (dev du méta-projet Fabi)
  // Depuis ce fichier (...packages/fabi-cli/packages/opencode/src/swarm/installer.ts)
  // jusqu'à ...packages/swarm-engine = remonter de 5 niveaux
  const localFork = resolve(HERE, "..", "..", "..", "..", "..", "swarm-engine")
  if (existsSync(join(localFork, "setup.py")) || existsSync(join(localFork, "pyproject.toml"))) {
    return { localPath: localFork, display: `clone local : ${localFork}` }
  }

  // 3. Fallback : on clone le fork swarm-engine dans
  // ~/.local/share/fabi/runtime/parallax-src/ puis pip install -e . (editable).
  // Le mode editable contourne le bug de packaging upstream (pyproject.toml
  // poetry-core ignore les sous-packages parallax_utils, scheduling,
  // parallax_extensions en mode wheel).
  // FABI_PARALLAX_REF peut overrider le commit qualifié.
  const cloneRef = process.env.FABI_PARALLAX_REF?.trim() || QUALIFIED_PARALLAX_COMMIT
  return {
    localPath: join(installRoot(), "parallax-src"),
    cloneUrl: FORK_PARALLAX_GIT,
    cloneRef,
    display: `git clone : ${FORK_PARALLAX_GIT}@${cloneRef}`,
  }
}

// ---------------------------------------------------------------------------
// Synchro paresseuse du clone source (mode chaud)
// ---------------------------------------------------------------------------

export interface SourceRefresh {
  /** Path du clone, ou null si la source n'est pas un clone géré. */
  localPath: string | null
  /** Branche/ref sur laquelle pointe la source attendue. */
  expectedRef: string | null
  /** SHA HEAD avant pull (court). */
  beforeSha: string | null
  /** SHA HEAD après pull (court). null si pull skip ou KO. */
  afterSha: string | null
  /** True si on a effectivement pull/fetch des nouveaux commits. */
  updated: boolean
  /** Raison si on a skip (pas un clone, override env, fetch KO, etc.). */
  skipReason?: string
}

async function shaShort(repoPath: string): Promise<string | null> {
  const r = await captureCmd("git", ["-C", repoPath, "rev-parse", "--short=8", "HEAD"])
  if (r.exitCode !== 0) return null
  return r.stdout.trim() || null
}

async function matchesCommit(repoPath: string, ref: string | undefined): Promise<boolean> {
  if (!isCommitSha(ref)) return true
  const current = await captureCmd("git", ["-C", repoPath, "rev-parse", "HEAD"])
  return current.exitCode === 0 && current.stdout.trim().toLowerCase() === ref.toLowerCase()
}

/**
 * Met à jour le clone géré du fork swarm-engine si on est derrière le remote.
 * Ne fait rien si la source vient d'un override `FABI_PARALLAX_SOURCE` local
 * (= clone de dev), ou si ce n'est pas un git clone.
 *
 * Les overrides de branche restent best-effort. Le commit produit qualifie,
 * lui, doit être atteint exactement avant de lancer le worker.
 */
async function refreshSourceClone(): Promise<SourceRefresh> {
  const source = resolveSource()
  // Si pas une URL de clone (override local user), on touche à rien.
  if (!source.cloneUrl) {
    return {
      localPath: source.localPath,
      expectedRef: null,
      beforeSha: existsSync(join(source.localPath, ".git")) ? await shaShort(source.localPath) : null,
      afterSha: null,
      updated: false,
      skipReason: "source-is-local-checkout",
    }
  }

  if (!existsSync(join(source.localPath, ".git"))) {
    return {
      localPath: source.localPath,
      expectedRef: source.cloneRef ?? null,
      beforeSha: null,
      afterSha: null,
      updated: false,
      skipReason: "no-managed-clone",
    }
  }

  const beforeSha = await shaShort(source.localPath)
  if (isCommitSha(source.cloneRef)) {
    if (await matchesCommit(source.localPath, source.cloneRef)) {
      return {
        localPath: source.localPath,
        expectedRef: source.cloneRef,
        beforeSha,
        afterSha: beforeSha,
        updated: false,
      }
    }
    const fetch = await captureCmd("git", ["-C", source.localPath, "fetch", "--depth=1", "origin", source.cloneRef])
    if (fetch.exitCode !== 0) {
      return {
        localPath: source.localPath,
        expectedRef: source.cloneRef,
        beforeSha,
        afterSha: null,
        updated: false,
        skipReason: `git-fetch-failed (${fetch.stderr.trim().slice(0, 120)})`,
      }
    }
    const checkout = await captureCmd("git", ["-C", source.localPath, "checkout", "--detach", source.cloneRef])
    const afterSha = await shaShort(source.localPath)
    return {
      localPath: source.localPath,
      expectedRef: source.cloneRef,
      beforeSha,
      afterSha,
      updated: checkout.exitCode === 0 && !!beforeSha && !!afterSha && beforeSha !== afterSha,
      skipReason: checkout.exitCode === 0 ? undefined : `git-checkout-failed (${checkout.stderr.trim().slice(0, 120)})`,
    }
  }
  // Le clone a été initialisé via `git clone --branch <ref>` donc la branche
  // courante suit déjà `origin/<ref>`. `git pull --ff-only --quiet` sans
  // args additionnels respecte ce tracking, et bail-out propre si l'user
  // a divergé manuellement (commits locaux, branche switchée). On ne
  // tente pas de réparer — on log et l'user reste sur sa version.
  const pull = await captureCmd("git", ["-C", source.localPath, "pull", "--ff-only", "--quiet"])
  const afterSha = await shaShort(source.localPath)
  const updated = !!(beforeSha && afterSha && beforeSha !== afterSha)
  return {
    localPath: source.localPath,
    expectedRef: source.cloneRef ?? null,
    beforeSha,
    afterSha,
    updated,
    skipReason: pull.exitCode !== 0 ? `git-pull-failed (${pull.stderr.trim().slice(0, 120)})` : undefined,
  }
}

/** Wrapper public pour worker.ts (diagnostic au boot). */
export async function inspectManagedSource(): Promise<SourceRefresh> {
  return refreshSourceClone()
}

// ---------------------------------------------------------------------------
// Détection des extras pip selon la plateforme
// ---------------------------------------------------------------------------

/**
 * Renvoie l'extra à passer à `pip install -e parallax[<extra>]` selon la
 * plateforme et le matériel.
 *
 * - macOS Apple Silicon → "mac" (torch + mlx + mlx-lm + nanobind)
 * - Linux x64 + NVIDIA  → "gpu" (sglang + mlx variants)
 * - Linux + pas de GPU  → "" (transformers only — fonctionnement dégradé)
 *
 * Override possible via FABI_PARALLAX_EXTRA (utile pour vllm sur certains hôtes).
 */
async function resolveExtras(): Promise<string> {
  const env = process.env.FABI_PARALLAX_EXTRA?.trim()
  if (env !== undefined) return env

  if (process.platform === "darwin") return "mac"

  if (process.platform === "linux") {
    // Détection NVIDIA via la présence de nvidia-smi
    const r = await captureCmd("nvidia-smi", ["--version"])
    if (r.exitCode === 0) return "gpu"
    return ""
  }

  return ""
}

// ---------------------------------------------------------------------------
// Auto-install Python si absent (best effort, prompt user)
// ---------------------------------------------------------------------------

async function tryAutoInstallPython(): Promise<string | null> {
  if (!process.stdin.isTTY) return null

  // macOS : on tente Homebrew si dispo
  if (process.platform === "darwin") {
    const brew = await captureCmd("brew", ["--version"])
    if (brew.exitCode !== 0) {
      process.stderr.write(
        `\n[fabi installer] Python 3.10+ requis. Homebrew non détecté — installe Python depuis https://www.python.org/ ou via pyenv puis relance fabi.\n`,
      )
      return null
    }
    process.stderr.write(`\n[fabi installer] Python 3.10+ requis. Tu as Homebrew, on peut l'installer maintenant.\n`)
    const ok = await confirm(`Installer python@3.12 via Homebrew ?`)
    if (!ok) return null
    process.stderr.write(`[fabi installer] brew install python@3.12 …\n`)
    const code = await streamCmd("brew", ["install", "python@3.12"])
    if (code !== 0) return null
    // Le binaire python3 unversionné est dans le libexec de python@3.12
    const candidate = "/opt/homebrew/opt/python@3.12/libexec/bin/python3"
    if (existsSync(candidate)) return candidate
    return await findSystemPython()
  }

  // Linux : on ne fait rien d'automatique (sudo apt nécessaire), juste un message clair
  if (process.platform === "linux") {
    process.stderr.write(`\n[fabi installer] Python 3.10+ requis. Installe-le avec ton package manager :\n`)
    process.stderr.write(`  Debian/Ubuntu : sudo apt install python3.12 python3.12-venv\n`)
    process.stderr.write(`  Fedora/RHEL   : sudo dnf install python3.12\n`)
    process.stderr.write(`  Arch          : sudo pacman -S python\n`)
    process.stderr.write(`Puis relance fabi.\n`)
  }

  return null
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type InstallResult = { ok: true; binPath: string } | { ok: false; reason: InstallFailReason; message: string }

export type InstallFailReason =
  | "non-interactive"
  | "user-declined"
  | "python-missing"
  | "venv-failed"
  | "pip-failed"
  | "source-mismatch"
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
 * Tente d'installer (ou mettre à jour) Parallax dans
 * `~/.local/share/fabi/runtime/.venv/`.
 *
 * - Si le binaire est déjà installé ET le clone source est à jour → renvoie
 *   son path immédiatement (cas chaud le plus fréquent)
 * - Si le binaire est installé MAIS le clone source est en retard sur le
 *   remote → pull silencieux du fork (le mode editable expose le source
 *   dir, donc un git pull suffit pour propager les patches Fabi)
 * - Si le binaire manque → prompt user → `python -m venv` puis `pip install`
 *
 * **Pourquoi la synchronisation** : une installation existante doit rester
 * alignée sur le SHA qualifié par le CLI courant. Une nouvelle qualification
 * produit entraîne un nouveau pin et jamais une mise à jour implicite de
 * branche mutable.
 *
 * Streame le progress de pip directement sur le terminal user.
 *
 * **Bloquant** : 5-15 min en cold install (PyTorch), ~1s en update à chaud.
 */
export async function tryInstallParallax(): Promise<InstallResult> {
  const binPath = managedParallaxBin()

  // Déjà installé : on s'assure quand même que le clone source est à jour
  // (le binaire est un wrapper editable qui appelle le source dir, donc un
  // git pull suffit pour appliquer les nouveaux patches du fork).
  if (existsSync(binPath)) {
    const refresh = await refreshSourceClone()
    log.info("parallax already installed in managed venv", { binPath, refresh })
    if (
      isCommitSha(refresh.expectedRef) &&
      refresh.localPath &&
      !(await matchesCommit(refresh.localPath, refresh.expectedRef))
    ) {
      return {
        ok: false,
        reason: "source-mismatch",
        message: `Le runtime Parallax géré ne pointe pas sur le commit qualifié ${refresh.expectedRef}.`,
      }
    }
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

  // 2. Vérifier Python — propose un install auto si absent
  let python = await findSystemPython()
  if (!python) {
    const installed = await tryAutoInstallPython()
    if (installed) {
      python = installed
    } else {
      return {
        ok: false,
        reason: "python-missing",
        message:
          "Python 3.10+ requis et non trouvé dans le PATH. " +
          "Installe-le depuis https://www.python.org/ ou via ton package manager (apt, brew, pyenv, ...).",
      }
    }
  }

  // 3. Prompt user
  const source = resolveSource()
  const extras = await resolveExtras()
  const dim = UI.Style.TEXT_DIM
  const reset = UI.Style.TEXT_NORMAL
  const bold = UI.Style.TEXT_NORMAL_BOLD
  const info = UI.Style.TEXT_INFO_BOLD

  process.stderr.write("\n")
  process.stderr.write(`${info}Fabi a besoin du runtime Parallax pour faire tourner un worker.${reset}\n`)
  process.stderr.write(`${dim}- Source     : ${source.display}${reset}\n`)
  process.stderr.write(`${dim}- Cible      : ${installRoot()}${reset}\n`)
  process.stderr.write(`${dim}- Python     : ${python}${reset}\n`)
  process.stderr.write(`${dim}- Extras     : ${extras || "(aucun)"} ${reset}\n`)
  process.stderr.write(`${dim}- Taille DL  : ~1.5 GB (PyTorch + MLX/vLLM + deps)${reset}\n`)
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

  // 4. Clone si la source vient d'une URL git (et pas déjà clonée)
  const root = installRoot()
  mkdirSync(root, { recursive: true })
  if (source.cloneUrl) {
    if (existsSync(join(source.localPath, ".git"))) {
      process.stderr.write(`${info}[fabi installer]${reset} Mise à jour du clone Parallax existant…\n`)
      const refresh = await refreshSourceClone()
      if (refresh.skipReason) {
        process.stderr.write(`${dim}(${refresh.skipReason}, on continue avec le clone existant)${reset}\n`)
      }
      if (isCommitSha(source.cloneRef)) {
        if (!(await matchesCommit(source.localPath, source.cloneRef))) {
          return {
            ok: false,
            reason: "pip-failed",
            message: `Le clone Parallax existant ne peut pas être aligné sur le commit qualifié ${source.cloneRef}.`,
          }
        }
      }
    } else {
      process.stderr.write(
        `${info}[fabi installer]${reset} Clonage de Parallax depuis ${source.cloneUrl}${
          source.cloneRef ? `@${source.cloneRef}` : ""
        }…\n`,
      )
      for (const args of managedCloneArgs(source)) {
        const cloneCode = await streamCmd("git", args)
        if (cloneCode !== 0) {
          return {
            ok: false,
            reason: "pip-failed",
            message: `Échec préparation git ${source.cloneUrl} (code ${cloneCode}). Vérifie ta connexion et que git est installé.`,
          }
        }
      }
      if (isCommitSha(source.cloneRef)) {
        if (!(await matchesCommit(source.localPath, source.cloneRef))) {
          return {
            ok: false,
            reason: "pip-failed",
            message: `Le clone Parallax ne pointe pas sur le commit qualifié ${source.cloneRef}.`,
          }
        }
      }
    }
  }

  // 5. Création du venv interactif
  process.stderr.write(`\n${info}[fabi installer]${reset} Création du virtualenv…\n`)
  const venvPath = join(root, INTERACTIVE_VENV_NAME)
  const venvCode = await streamCmd(python, ["-m", "venv", venvPath])
  if (venvCode !== 0) {
    return {
      ok: false,
      reason: "venv-failed",
      message: `Échec création du venv (code ${venvCode}). Vérifie que ${python} a bien le module venv (apt: 'python3-venv').`,
    }
  }

  // 6. Upgrade pip (silencieux pour ne pas trop bruiter)
  const pip = venvPipBin()
  process.stderr.write(`${info}[fabi installer]${reset} Mise à jour de pip…\n`)
  await streamCmd(venvPythonBin(), ["-m", "pip", "install", "--upgrade", "pip", "--quiet"])

  // 7. Installation de Parallax en mode editable depuis le clone local
  // (le mode editable expose tous les sous-packages via .pth, contournant
  // le bug de packaging poetry-core upstream qui n'expose que `parallax/`).
  const editableSpec = extras ? `${source.localPath}[${extras}]` : source.localPath
  process.stderr.write(`\n${info}[fabi installer]${reset} pip install -e "${editableSpec}"…\n`)
  process.stderr.write(`${dim}            Sois patient — PyTorch + MLX peuvent prendre plusieurs minutes.${reset}\n\n`)
  const installCode = await streamCmd(pip, ["install", "-e", editableSpec])
  if (installCode !== 0) {
    return {
      ok: false,
      reason: "pip-failed",
      message: `Échec de pip install -e (code ${installCode}). Regarde les logs au-dessus pour la cause précise.`,
    }
  }

  // 8. Workaround : `requests` est utilisé par parallax/cli.py mais absent
  // des dépendances upstream (pyproject.toml). On l'installe explicitement.
  process.stderr.write(`${info}[fabi installer]${reset} Install de la dep manquante 'requests'…\n`)
  const reqCode = await streamCmd(pip, ["install", "--quiet", "requests"])
  if (reqCode !== 0) {
    process.stderr.write(`${dim}(install de requests a échoué, parallax pourra planter au démarrage)${reset}\n`)
  }

  // 9. Vérification finale
  const interactiveBin = join(venvBinDir(), parallaxFileName())
  if (!existsSync(interactiveBin)) {
    return {
      ok: false,
      reason: "binary-not-found-after-install",
      message: `pip install est passé mais le binaire ${interactiveBin} est absent. Vérifie les logs ci-dessus.`,
    }
  }

  process.stderr.write(
    `\n${info}[fabi installer]${reset} ${UI.Style.TEXT_SUCCESS}✅ Parallax installé avec succès${reset}\n`,
  )
  process.stderr.write(`${dim}            Binaire : ${interactiveBin}${reset}\n\n`)
  return { ok: true, binPath: interactiveBin }
}
