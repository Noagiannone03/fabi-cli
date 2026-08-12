import type {
  Hooks,
  PluginInput,
  Plugin as PluginInstance,
  PluginModule,
  WorkspaceAdapter as PluginWorkspaceAdapter,
} from "@opencode-ai/plugin"
import { Config } from "@/config/config"
import { Bus } from "../bus"
import * as Log from "@opencode-ai/core/util/log"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { Flag } from "@opencode-ai/core/flag/flag"
import { ServerAuth } from "@/server/auth"
import { CodexAuthPlugin } from "./codex"
import { Session } from "@/session/session"
import { NamedError } from "@opencode-ai/core/util/error"
import { CopilotAuthPlugin } from "./github-copilot/copilot"
import { gitlabAuthPlugin as GitlabAuthPlugin } from "opencode-gitlab-auth"
import { PoeAuthPlugin } from "opencode-poe-auth"
import { CloudflareAIGatewayAuthPlugin, CloudflareWorkersAuthPlugin } from "./cloudflare"
import { AzureAuthPlugin } from "./azure"
import { Effect, Layer, Context, Stream } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { errorMessage } from "@/util/error"
import { PluginLoader } from "./loader"
import { parsePluginSpecifier, readPluginId, readV1Plugin, resolvePluginId } from "./shared"
import { registerAdapter } from "@/control-plane/adapters"
import type { WorkspaceAdapter } from "@/control-plane/types"
import {
  Event as FabiGoalEvent,
  FabiGoalPlugin,
  type Info as FabiGoalInfo,
  isGoalIdleEvent,
  Lifecycle as FabiGoalLifecycle,
  type LifecycleHooks,
  sessionIDFromGoalEvent,
} from "./fabi-goal"

const log = Log.create({ service: "plugin" })

type State = {
  hooks: LifecycleHooks[]
}

// Hook names that follow the (input, output) => Promise<void> trigger pattern
type TriggerName = {
  [K in keyof Hooks]-?: NonNullable<Hooks[K]> extends (input: any, output: any) => Promise<void> ? K : never
}[keyof Hooks]

export interface Interface {
  readonly trigger: <
    Name extends TriggerName,
    Input = Parameters<Required<Hooks>[Name]>[0],
    Output = Parameters<Required<Hooks>[Name]>[1],
  >(
    name: Name,
    input: Input,
    output: Output,
  ) => Effect.Effect<Output>
  readonly list: () => Effect.Effect<Hooks[]>
  readonly goalStatus: (sessionID: string) => Effect.Effect<FabiGoalInfo | null>
  readonly pauseGoal: (sessionID: string) => Effect.Effect<FabiGoalInfo>
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Plugin") {}

// Built-in plugins that are directly imported (not installed from npm)
const INTERNAL_PLUGINS: PluginInstance[] = [
  CodexAuthPlugin,
  CopilotAuthPlugin,
  GitlabAuthPlugin,
  PoeAuthPlugin,
  CloudflareWorkersAuthPlugin,
  CloudflareAIGatewayAuthPlugin,
  AzureAuthPlugin,
  FabiGoalPlugin,
]

function isServerPlugin(value: unknown): value is PluginInstance {
  return typeof value === "function"
}

function getServerPlugin(value: unknown) {
  if (isServerPlugin(value)) return value
  if (!value || typeof value !== "object" || !("server" in value)) return
  if (!isServerPlugin(value.server)) return
  return value.server
}

function getLegacyPlugins(mod: Record<string, unknown>) {
  const seen = new Set<unknown>()
  const result: PluginInstance[] = []

  for (const entry of Object.values(mod)) {
    if (seen.has(entry)) continue
    seen.add(entry)
    const plugin = getServerPlugin(entry)
    if (!plugin) throw new TypeError("Plugin export is not a function")
    result.push(plugin)
  }

  return result
}

async function applyPlugin(load: PluginLoader.Loaded, input: PluginInput, hooks: Hooks[]) {
  const plugin = readV1Plugin(load.mod, load.spec, "server", "detect")
  if (plugin) {
    await resolvePluginId(load.source, load.spec, load.target, readPluginId(plugin.id, load.spec), load.pkg)
    hooks.push(await (plugin as PluginModule).server(input, load.options))
    return
  }

  for (const server of getLegacyPlugins(load.mod)) {
    hooks.push(await server(input, load.options))
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const config = yield* Config.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("Plugin.state")(function* (ctx) {
        const hooks: LifecycleHooks[] = []
        const bridge = yield* EffectBridge.make()

        function publishPluginError(message: string) {
          bridge.fork(bus.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() }))
        }

        const { Server } = yield* Effect.promise(() => import("../server/server"))

        const client = createOpencodeClient({
          baseUrl: "http://localhost:4096",
          directory: ctx.directory,
          headers: ServerAuth.headers(),
          fetch: async (...args) => Server.Default().app.fetch(...args),
        })
        const cfg = yield* config.get()
        const input: PluginInput = {
          client,
          project: ctx.project,
          worktree: ctx.worktree,
          directory: ctx.directory,
          experimental_workspace: {
            register(type: string, adapter: PluginWorkspaceAdapter) {
              registerAdapter(ctx.project.id, type, adapter as WorkspaceAdapter)
            },
          },
          get serverUrl(): URL {
            return Server.url ?? new URL("http://localhost:4096")
          },
          // @ts-expect-error
          $: typeof Bun === "undefined" ? undefined : Bun.$,
        }

        for (const plugin of INTERNAL_PLUGINS) {
          log.info("loading internal plugin", { name: plugin.name })
          const init = yield* Effect.tryPromise({
            try: () => plugin(input),
            catch: (err) => {
              log.error("failed to load internal plugin", { name: plugin.name, error: err })
            },
          }).pipe(Effect.option)
          if (init._tag === "Some") hooks.push(init.value)
        }

        const plugins = Flag.OPENCODE_PURE ? [] : (cfg.plugin_origins ?? [])
        if (Flag.OPENCODE_PURE && cfg.plugin_origins?.length) {
          log.info("skipping external plugins in pure mode", { count: cfg.plugin_origins.length })
        }
        if (plugins.length) yield* config.waitForDependencies()

        const loaded = yield* Effect.promise(() =>
          PluginLoader.loadExternal({
            items: plugins,
            kind: "server",
            report: {
              start(candidate) {
                log.info("loading plugin", { path: candidate.plan.spec })
              },
              missing(candidate, _retry, message) {
                log.warn("plugin has no server entrypoint", { path: candidate.plan.spec, message })
              },
              error(candidate, _retry, stage, error, resolved) {
                const spec = candidate.plan.spec
                const cause = error instanceof Error ? (error.cause ?? error) : error
                const message = stage === "load" ? errorMessage(error) : errorMessage(cause)

                if (stage === "install") {
                  const parsed = parsePluginSpecifier(spec)
                  log.error("failed to install plugin", { pkg: parsed.pkg, version: parsed.version, error: message })
                  publishPluginError(`Failed to install plugin ${parsed.pkg}@${parsed.version}: ${message}`)
                  return
                }

                if (stage === "compatibility") {
                  log.warn("plugin incompatible", { path: spec, error: message })
                  publishPluginError(`Plugin ${spec} skipped: ${message}`)
                  return
                }

                if (stage === "entry") {
                  log.error("failed to resolve plugin server entry", { path: spec, error: message })
                  publishPluginError(`Failed to load plugin ${spec}: ${message}`)
                  return
                }

                log.error("failed to load plugin", { path: spec, target: resolved?.entry, error: message })
                publishPluginError(`Failed to load plugin ${spec}: ${message}`)
              },
            },
          }),
        )
        for (const load of loaded) {
          if (!load) continue

          // Keep plugin execution sequential so hook registration and execution
          // order remains deterministic across plugin runs.
          yield* Effect.tryPromise({
            try: () => applyPlugin(load, input, hooks),
            catch: (err) => {
              const message = errorMessage(err)
              log.error("failed to load plugin", { path: load.spec, error: message })
              return message
            },
          }).pipe(
            Effect.catch(() => {
              // TODO: make proper events for this
              // bus.publish(Session.Event.Error, {
              //   error: new NamedError.Unknown({
              //     message: `Failed to load plugin ${load.spec}: ${message}`,
              //   }).toObject(),
              // })
              return Effect.void
            }),
          )
        }

        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            await Promise.allSettled(
              hooks
                .toReversed()
                .filter((hook) => typeof hook.dispose === "function")
                .map((hook) => Promise.resolve(hook.dispose?.())),
            )
          }),
        )

        // Notify plugins of current config
        for (const hook of hooks) {
          yield* Effect.tryPromise({
            try: () => Promise.resolve((hook as any).config?.(cfg)),
            catch: (err) => {
              log.error("plugin config hook failed", { error: err })
            },
          }).pipe(Effect.ignore)
        }

        // Subscribe to bus events, fiber interrupted when scope closes
        yield* bus.subscribeAll().pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              for (const hook of hooks) {
                const callback = hook.event
                if (!callback) continue
                const invoked = Effect.tryPromise({
                  try: () => callback({ event: event as any }),
                  catch: (error) => error,
                }).pipe(
                  Effect.catch((error) =>
                    Effect.sync(() => log.error("plugin event hook failed", { event: event.type, error })),
                  ),
                )
                if (hook[FabiGoalLifecycle]) {
                  yield* invoked
                } else {
                  yield* invoked.pipe(Effect.forkScoped)
                }
              }

              if (!isGoalIdleEvent(event)) return
              const sessionID = sessionIDFromGoalEvent(event)
              if (!sessionID) return
              const lifecycle = hooks.find((hook) => hook[FabiGoalLifecycle])?.[FabiGoalLifecycle]
              if (!lifecycle) return
              const decision = lifecycle.takeIdleDecision(sessionID)
              const goal = yield* Effect.tryPromise(() => lifecycle.status(sessionID)).pipe(Effect.option)
              if (goal._tag === "None") return
              yield* bus.publish(FabiGoalEvent.Status, {
                sessionID,
                status: goal.value?.status ?? null,
                ...(goal.value?.objective ? { objective: goal.value.objective } : {}),
                ...(typeof goal.value?.tokensUsed === "number" ? { tokensUsed: goal.value.tokensUsed } : {}),
                ...(goal.value?.tokenBudget !== undefined ? { tokenBudget: goal.value.tokenBudget } : {}),
                ...(typeof goal.value?.autoTurns === "number" ? { autoTurns: goal.value.autoTurns } : {}),
                ...(goal.value?.maxAutoTurns !== undefined ? { maxAutoTurns: goal.value.maxAutoTurns } : {}),
                ...(decision ? { decision } : {}),
              })
            }),
          ),
          Effect.forkScoped,
        )

        return { hooks }
      }),
    )

    const trigger = Effect.fn("Plugin.trigger")(function* <
      Name extends TriggerName,
      Input = Parameters<Required<Hooks>[Name]>[0],
      Output = Parameters<Required<Hooks>[Name]>[1],
    >(name: Name, input: Input, output: Output) {
      if (!name) return output
      const s = yield* InstanceState.get(state)
      for (const hook of s.hooks) {
        const fn = hook[name] as any
        if (!fn) continue
        yield* Effect.promise(async () => fn(input, output))
      }
      return output
    })

    const list = Effect.fn("Plugin.list")(function* () {
      const s = yield* InstanceState.get(state)
      return s.hooks
    })

    const goalStatus = Effect.fn("Plugin.goalStatus")(function* (sessionID: string) {
      const s = yield* InstanceState.get(state)
      const lifecycle = s.hooks.find((hook) => hook[FabiGoalLifecycle])?.[FabiGoalLifecycle]
      if (!lifecycle) return null
      return yield* Effect.promise(() => lifecycle.status(sessionID))
    })

    const pauseGoal = Effect.fn("Plugin.pauseGoal")(function* (sessionID: string) {
      const s = yield* InstanceState.get(state)
      const lifecycle = s.hooks.find((hook) => hook[FabiGoalLifecycle])?.[FabiGoalLifecycle]
      if (!lifecycle) return yield* Effect.die(new Error("qualified Goal plugin lifecycle is unavailable"))
      return yield* Effect.promise(() => lifecycle.setStatus(sessionID, "paused"))
    })

    const init = Effect.fn("Plugin.init")(function* () {
      yield* InstanceState.get(state)
    })

    return Service.of({ trigger, list, goalStatus, pauseGoal, init })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer), Layer.provide(Config.defaultLayer))

export * as Plugin from "."
