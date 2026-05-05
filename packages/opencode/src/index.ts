import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { RunCommand } from "./cli/cmd/run"
import { GenerateCommand } from "./cli/cmd/generate"
import * as Log from "@opencode-ai/core/util/log"
import { ConsoleCommand } from "./cli/cmd/account"
import { ProvidersCommand } from "./cli/cmd/providers"
import { AgentCommand } from "./cli/cmd/agent"
import { UpgradeCommand } from "./cli/cmd/upgrade"
import { UninstallCommand } from "./cli/cmd/uninstall"
import { ModelsCommand } from "./cli/cmd/models"
import { SwarmsCommand } from "./cli/cmd/swarms"
import { UI } from "./cli/ui"
import { Installation } from "./installation"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { NamedError } from "@opencode-ai/core/util/error"
import { FormatError } from "./cli/error"
import { ServeCommand } from "./cli/cmd/serve"
import { Filesystem } from "@/util/filesystem"
import { DebugCommand } from "./cli/cmd/debug"
import { StatsCommand } from "./cli/cmd/stats"
import { McpCommand } from "./cli/cmd/mcp"
import { GithubCommand } from "./cli/cmd/github"
import { ExportCommand } from "./cli/cmd/export"
import { ImportCommand } from "./cli/cmd/import"
import { AttachCommand } from "./cli/cmd/tui/attach"
import { TuiThreadCommand } from "./cli/cmd/tui/thread"
import { AcpCommand } from "./cli/cmd/acp"
import { EOL } from "os"
import { WebCommand } from "./cli/cmd/web"
import { PrCommand } from "./cli/cmd/pr"
import { SessionCommand } from "./cli/cmd/session"
import { DbCommand } from "./cli/cmd/db"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { JsonMigration } from "@/storage/json-migration"
import { Database } from "@/storage/db"
import { errorMessage } from "./util/error"
import { PluginCommand } from "./cli/cmd/plug"
import { Heap } from "./cli/heap"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { ensureProcessMetadata } from "@opencode-ai/core/util/opencode-process"
import * as Swarm from "./swarm"

const processMetadata = ensureProcessMetadata("main")

process.on("unhandledRejection", (e) => {
  Log.Default.error("rejection", {
    e: errorMessage(e),
  })
})

process.on("uncaughtException", (e) => {
  Log.Default.error("exception", {
    e: errorMessage(e),
  })
})

// Filet de sécurité : si une commande fait process.exit() direct (cas de la
// TUI thread qui appelle process.exit(0) dans son handler), le finally global
// ne s'exécute pas. Ce handler synchrone envoie au moins SIGTERM au worker
// pour qu'aucun process GPU Parallax ne survive au binaire fabi.
process.on("exit", () => {
  Swarm.shutdownActiveSync()
})

const args = hideBin(process.argv)

// ---------------------------------------------------------------------------
// Affichage live des événements de boot du swarm.
// On écrit sur stderr pour ne pas polluer le stdout d'une commande pipée.
// Tag visible "[fabi swarm]" pour que l'utilisateur sache d'où ça vient.
// ---------------------------------------------------------------------------
function printSwarmEvent(event: Swarm.SwarmStartEvent, runtime: Swarm.SwarmRuntime): void {
  const tag = UI.Style.TEXT_INFO_BOLD + "[fabi swarm]" + UI.Style.TEXT_NORMAL
  const dim = UI.Style.TEXT_DIM
  const ok = UI.Style.TEXT_SUCCESS
  const warn = UI.Style.TEXT_WARNING
  const reset = UI.Style.TEXT_NORMAL

  const writeLine = (msg: string) => process.stderr.write(`${tag} ${msg}${reset}${EOL}`)

  switch (event.kind) {
    case "discovery": {
      const r = event.result
      if (r.kind === "ok") {
        writeLine(
          `${ok}swarm découvert${reset} : ${r.swarm.id} (${r.swarm.peers} peer${r.swarm.peers > 1 ? "s" : ""}, ${r.swarm.totalVramGb} GB VRAM)`,
        )
        writeLine(`${dim}            model=${r.swarm.model}`)
      } else if (r.kind === "no-match") {
        writeLine(`${warn}registry: ${r.reason}${reset}`)
        if (r.allSwarms.length > 0) {
          writeLine(
            `${dim}            disponibles: ${r.allSwarms.map((s) => `${s.id}(${s.status})`).join(", ")}`,
          )
        }
      } else {
        writeLine(`${warn}registry injoignable${reset} : ${r.error.message}`)
      }
      break
    }
    case "discovery-skipped": {
      writeLine(
        `${dim}auto-discovery skippée (${event.reason === "explicit-peer" ? "--scheduler-peer fourni" : "pas de registry configuré"})${reset}`,
      )
      break
    }
    case "discovery-fallback": {
      writeLine(`${dim}fallback vers le scheduler par défaut (${event.reason})${reset}`)
      break
    }
    case "scheduler": {
      if (event.info.reachable) {
        writeLine(`${ok}scheduler joignable${reset} : ${event.url}`)
        const parts: string[] = []
        if (event.info.status) parts.push(`status=${event.info.status}`)
        if (typeof event.info.nodeCount === "number") parts.push(`workers=${event.info.nodeCount}`)
        if (event.info.model) parts.push(`model=${event.info.model}`)
        if (parts.length) writeLine(`${dim}            ${parts.join("  ·  ")}`)
      } else {
        writeLine(`${warn}scheduler injoignable${reset} : ${event.url}`)
        writeLine(`${dim}            (Fabi continue en mode dégradé — corrige le scheduler ou utilise un autre provider)`)
      }
      break
    }
    case "worker-disabled": {
      writeLine(`${warn}worker swarm désactivé (--no-parallax) — mode dev, pas pour usage normal${reset}`)
      break
    }
    case "worker": {
      const s = event.status
      switch (s.kind) {
        case "starting":
          writeLine(`${dim}démarrage du worker parallax (peer ${runtime.schedulerPeer})…${reset}`)
          break
        case "running":
          writeLine(`${ok}worker parallax démarré${reset} (pid ${s.pid}) — tu contribues au swarm 🦦`)
          break
        case "missing-binary":
          writeLine(`${warn}parallax non installé${reset} — lancement de l'installer interactif…`)
          break
        case "exited":
          writeLine(
            `${warn}worker parallax arrêté inattendu${reset} (code=${s.code} signal=${s.signal ?? "-"} runtime=${Math.round(s.runtimeMs / 1000)}s)`,
          )
          if (s.output.length) {
            writeLine(`${dim}dernières lignes parallax :`)
            for (const line of s.output.slice(-6)) writeLine(`${dim}  ${line}`)
          }
          break
        case "error":
          writeLine(`${warn}worker parallax : ${s.message}${reset}`)
          break
      }
      break
    }
    case "installer-prompt": {
      // L'installer va prendre la main sur stdout/stderr ; pas de tag ici
      // pour ne pas bruiter l'UX du prompt.
      break
    }
    case "installer-result": {
      if (event.result.ok) {
        writeLine(`${ok}runtime parallax prêt${reset} (${event.result.binPath})`)
      } else {
        writeLine(`${warn}install parallax non aboutie${reset} (${event.result.reason})`)
        // Détail du message renvoyé par l'installer pour aider l'utilisateur.
        writeLine(`${dim}            ${event.result.message}${reset}`)
      }
      break
    }
  }
}

// Message bloquant final quand Parallax est requis mais qu'on n'a pas pu
// le démarrer (l'installer a déjà tourné en amont et expliqué la raison
// précise de l'échec : user-declined, python-missing, pip-failed, ...).
// Philosophie Fabi : "tu codes = tu contribues" (cf. README et ADR 002).
function printParallaxRequiredMessage(reason: "missing-binary" | "spawn-failed"): void {
  const danger = UI.Style.TEXT_DANGER_BOLD
  const warn = UI.Style.TEXT_WARNING
  const dim = UI.Style.TEXT_DIM
  const reset = UI.Style.TEXT_NORMAL

  const lines: string[] = [
    "",
    `${danger}❌ Fabi ne peut pas démarrer sans worker Parallax${reset}`,
    "",
    `${warn}Philosophie Fabi : tu utilises le swarm = tu y contribues.${reset}`,
    `${dim}Pas de mode consommateur seul — sinon le swarm meurt sous le poids${reset}`,
    `${dim}des utilisateurs qui ne donnent pas de compute en retour.${reset}`,
    "",
    reason === "spawn-failed"
      ? `${dim}Le worker a refusé de démarrer même après installation. Logs au-dessus pour la cause.${reset}`
      : `${dim}Relance ${reset}fabi${dim} quand tu seras prêt à installer Parallax.${reset}`,
    "",
    `${dim}Dev / contributeurs du fork uniquement : ${reset}--no-parallax${dim} skip le worker${reset}`,
    "",
  ]
  for (const line of lines) process.stderr.write(line + EOL)
}

function show(out: string) {
  const text = out.trimStart()
  if (!text.startsWith("fabi ")) {
    process.stderr.write(UI.logo() + EOL + EOL)
    process.stderr.write(text)
    return
  }
  process.stderr.write(out)
}

const cli = yargs(args)
  .parserConfiguration({ "populate--": true })
  .scriptName("fabi")
  .wrap(100)
  .help("help", "show help")
  .alias("help", "h")
  .version("version", "show version number", InstallationVersion)
  .alias("version", "v")
  .option("print-logs", {
    describe: "print logs to stderr",
    type: "boolean",
  })
  .option("log-level", {
    describe: "log level",
    type: "string",
    choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  })
  .option("pure", {
    describe: "run without external plugins",
    type: "boolean",
  })
  .option("parallax", {
    describe:
      "lance le worker parallax au boot (REQUIS en usage normal — --no-parallax est réservé aux devs du fork qui veulent skip Parallax)",
    type: "boolean",
    default: true,
  })
  .option("registry", {
    describe: "URL du fabi-registry (auto-discovery des swarms)",
    type: "string",
  })
  .option("swarm", {
    describe: "ID du swarm à rejoindre (recherche dans le registry)",
    type: "string",
  })
  .option("swarm-model", {
    describe: "filtre les swarms par modèle (substring du nom HuggingFace)",
    type: "string",
  })
  .option("scheduler", {
    describe: "URL HTTP du scheduler — override le registry",
    type: "string",
  })
  .option("scheduler-peer", {
    describe: "PeerID Lattica du scheduler — override le registry",
    type: "string",
  })
  .option("no-registry", {
    describe: "skip l'auto-discovery via registry, utilise les flags/env directement",
    type: "boolean",
  })
  .option("swarm-verbose", {
    describe: "forwarde stdout/stderr du worker parallax vers stderr",
    type: "boolean",
  })
  .middleware(async (opts) => {
    if (opts.pure) {
      process.env.OPENCODE_PURE = "1"
    }

    await Log.init({
      print: process.argv.includes("--print-logs"),
      dev: Installation.isLocal(),
      level: (() => {
        if (opts.logLevel) return opts.logLevel as Log.Level
        if (Installation.isLocal()) return "DEBUG"
        return "INFO"
      })(),
    })

    Heap.start()

    process.env.AGENT = "1"
    process.env.OPENCODE = "1"
    process.env.OPENCODE_PID = String(process.pid)
    // Markers Fabi en plus des markers OpenCode (compat upstream).
    process.env.FABI = "1"
    process.env.FABI_PID = String(process.pid)

    Log.Default.info("fabi", {
      version: InstallationVersion,
      args: process.argv.slice(2),
      process_role: processMetadata.processRole,
      run_id: processMetadata.runID,
    })

    const marker = path.join(Global.Path.data, "opencode.db")
    if (!(await Filesystem.exists(marker))) {
      const tty = process.stderr.isTTY
      process.stderr.write("Performing one time database migration, may take a few minutes..." + EOL)
      const width = 36
      const orange = "\x1b[38;5;214m"
      const muted = "\x1b[0;2m"
      const reset = "\x1b[0m"
      let last = -1
      if (tty) process.stderr.write("\x1b[?25l")
      try {
        await JsonMigration.run(drizzle({ client: Database.Client().$client }), {
          progress: (event) => {
            const percent = Math.floor((event.current / event.total) * 100)
            if (percent === last && event.current !== event.total) return
            last = percent
            if (tty) {
              const fill = Math.round((percent / 100) * width)
              const bar = `${"■".repeat(fill)}${"･".repeat(width - fill)}`
              process.stderr.write(
                `\r${orange}${bar} ${percent.toString().padStart(3)}%${reset} ${muted}${event.label.padEnd(12)} ${event.current}/${event.total}${reset}`,
              )
              if (event.current === event.total) process.stderr.write("\n")
            } else {
              process.stderr.write(`sqlite-migration:${percent}${EOL}`)
            }
          },
        })
      } finally {
        if (tty) process.stderr.write("\x1b[?25h")
        else {
          process.stderr.write(`sqlite-migration:done${EOL}`)
        }
      }
      process.stderr.write("Database migration complete." + EOL)
    }
  })
  // Middleware swarm Fabi : démarre le worker parallax et ping le scheduler
  // pour les commandes qui font de l'inférence (TUI default, run, serve).
  // Toutes les erreurs sont absorbées : un swarm injoignable ou un binaire
  // parallax absent ne doit jamais empêcher l'utilisateur d'utiliser fabi
  // (fallback : mode consumer-only sur le scheduler distant).
  .middleware(async (opts) => {
    // Skip pour --help / --version / completion (pas d'inférence demandée).
    if (opts.help || opts.version) return
    const command = (opts._?.[0] as string | undefined) ?? undefined
    if (!Swarm.shouldStartSwarm(command)) return

    const runtime = Swarm.resolveSwarmRuntime({
      registryUrl: opts.registry as string | undefined,
      preferredSwarmId: opts.swarm as string | undefined,
      preferredModel: opts.swarmModel as string | undefined,
      schedulerUrl: opts.scheduler as string | undefined,
      schedulerPeer: opts.schedulerPeer as string | undefined,
      // yargs traite --no-parallax comme parallax: false (cf. .option ci-dessus).
      noParallax: opts.parallax === false ? true : undefined,
      // --scheduler-peer explicite OU --no-registry → skip registry
      skipRegistry:
        Boolean(opts.schedulerPeer) || opts.noRegistry === true ? true : undefined,
      verbose: opts.swarmVerbose === true ? true : undefined,
    })

    try {
      await Swarm.startSwarm(runtime, (event) => printSwarmEvent(event, runtime))
    } catch (err) {
      // Worker Parallax requis mais absent → philosophie Fabi : pas de free-riding,
      // on n'autorise pas la consommation du swarm sans contribution.
      // L'utilisateur doit installer Parallax (ou utiliser --no-parallax en dev).
      if (err instanceof Swarm.SwarmWorkerRequiredError) {
        printParallaxRequiredMessage(err.reason)
        process.exit(1)
      }
      // Autre erreur (réseau scheduler, race condition, ...) — log et continue.
      Log.Default.warn("swarm boot failed", { error: errorMessage(err) })
    }
  })
  .usage("")
  .completion("completion", "generate shell completion script")
  .command(AcpCommand)
  .command(McpCommand)
  .command(TuiThreadCommand)
  .command(AttachCommand)
  .command(RunCommand)
  .command(GenerateCommand)
  .command(DebugCommand)
  .command(ConsoleCommand)
  .command(ProvidersCommand)
  .command(AgentCommand)
  .command(UpgradeCommand)
  .command(UninstallCommand)
  .command(ServeCommand)
  .command(WebCommand)
  .command(ModelsCommand)
  .command(SwarmsCommand)
  .command(StatsCommand)
  .command(ExportCommand)
  .command(ImportCommand)
  .command(GithubCommand)
  .command(PrCommand)
  .command(SessionCommand)
  .command(PluginCommand)
  .command(DbCommand)
  .fail((msg, err) => {
    if (
      msg?.startsWith("Unknown argument") ||
      msg?.startsWith("Not enough non-option arguments") ||
      msg?.startsWith("Invalid values:")
    ) {
      if (err) throw err
      cli.showHelp(show)
    }
    if (err) throw err
    process.exit(1)
  })
  .strict()

try {
  if (args.includes("-h") || args.includes("--help")) {
    await cli.parse(args, (err: Error | undefined, _argv: unknown, out: string) => {
      if (err) throw err
      if (!out) return
      show(out)
    })
  } else {
    await cli.parse()
  }
} catch (e) {
  let data: Record<string, any> = {}
  if (e instanceof NamedError) {
    const obj = e.toObject()
    Object.assign(data, {
      ...obj.data,
    })
  }

  if (e instanceof Error) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      cause: e.cause?.toString(),
      stack: e.stack,
    })
  }

  if (e instanceof ResolveMessage) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      code: e.code,
      specifier: e.specifier,
      referrer: e.referrer,
      position: e.position,
      importKind: e.importKind,
    })
  }
  Log.Default.error("fatal", data)
  const formatted = FormatError(e)
  if (formatted) UI.error(formatted)
  if (formatted === undefined) {
    UI.error("Unexpected error, check log file at " + Log.file() + " for more details" + EOL)
    process.stderr.write(errorMessage(e) + EOL)
  }
  process.exitCode = 1
} finally {
  // Tue le worker parallax avant de force-exit pour qu'aucun process GPU ne
  // reste en arrière-plan. Tolère un échec — le SIGKILL après grace period
  // garantit que rien ne survit.
  await Swarm.shutdownActive().catch((err) => {
    Log.Default.warn("swarm shutdown failed", { error: errorMessage(err) })
  })

  // Some subprocesses don't react properly to SIGTERM and similar signals.
  // Most notably, some docker-container-based MCP servers don't handle such signals unless
  // run using `docker run --init`.
  // Explicitly exit to avoid any hanging subprocesses.
  process.exit()
}
