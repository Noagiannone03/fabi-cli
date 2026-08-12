import type { Hooks, PluginInput, ToolContext, ToolDefinition } from "@opencode-ai/plugin"
import { BusEvent } from "@/bus/bus-event"
import { SessionID } from "@/session/schema"
import { Effect, Schema } from "effect"

// The published package intentionally ships JavaScript only. Keep the import
// pinned in package.json and validate its server entrypoint at runtime below.
// @ts-expect-error @prevalentware/opencode-goal-plugin has no declaration file
import GoalModule from "@prevalentware/opencode-goal-plugin/server"

const GOAL_VARIANT = "fabi-goal"
const TERMINAL = new Set(["complete", "unmet"])
const GOAL_STATUSES = ["active", "paused", "budgetLimited", "usageLimited", "complete", "unmet"] as const
export type GoalStatus = (typeof GOAL_STATUSES)[number]
export const IDLE_DECISIONS = ["continued", "wrapup", "settled"] as const
export type IdleDecision = (typeof IDLE_DECISIONS)[number]

export class Info extends Schema.Class<Info>("FabiGoalInfo")({
  objective: Schema.optional(Schema.String),
  status: Schema.Literals(GOAL_STATUSES),
  tokensUsed: Schema.optional(Schema.Number),
  tokenBudget: Schema.optional(Schema.NullOr(Schema.Number)),
  autoTurns: Schema.optional(Schema.Number),
  maxAutoTurns: Schema.optional(Schema.NullOr(Schema.Number)),
  wrapupSent: Schema.optional(Schema.Boolean),
}) {}

export const Lifecycle = Symbol("fabi.goal.lifecycle")

export type LifecycleHooks = Hooks & {
  dispose?: () => void | Promise<void>
  [Lifecycle]?: {
    status(sessionID: string): Promise<Info | null>
    setStatus(sessionID: string, status: "active" | "paused"): Promise<Info>
    takeIdleDecision(sessionID: string): IdleDecision | undefined
  }
}

export const Event = {
  Status: BusEvent.define(
    "fabi.goal.status",
    Schema.Struct({
      sessionID: SessionID,
      status: Schema.NullOr(Schema.Literals(GOAL_STATUSES)),
      objective: Schema.optional(Schema.String),
      tokensUsed: Schema.optional(Schema.Number),
      tokenBudget: Schema.optional(Schema.NullOr(Schema.Number)),
      autoTurns: Schema.optional(Schema.Number),
      maxAutoTurns: Schema.optional(Schema.NullOr(Schema.Number)),
      decision: Schema.optional(Schema.Literals(IDLE_DECISIONS)),
    }),
  ),
}

function text(parts: Array<{ type?: string; text?: string }>) {
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim()
}

function context(input: PluginInput, sessionID: string, agent: string): ToolContext {
  return {
    sessionID,
    messageID: "fabi-goal-admission",
    agent,
    directory: input.directory,
    worktree: input.worktree,
    abort: new AbortController().signal,
    metadata() {},
    ask: () => Effect.void,
  }
}

async function output(definition: ToolDefinition, args: Record<string, unknown>, ctx: ToolContext) {
  const value = await definition.execute(args, ctx)
  return typeof value === "string" ? value : value.output
}

function parseSnapshot(value: string): Info | null {
  const parsed: unknown = JSON.parse(value)
  if (!parsed || typeof parsed !== "object" || !("goal" in parsed)) throw new Error("invalid Goal response")
  const goal = parsed.goal
  if (goal === null) return null
  if (
    !goal ||
    typeof goal !== "object" ||
    !("status" in goal) ||
    typeof goal.status !== "string" ||
    !GOAL_STATUSES.includes(goal.status as GoalStatus)
  ) {
    throw new Error("invalid Goal snapshot")
  }
  const record = goal as Record<string, unknown>
  return Info.make({
    status: record.status as GoalStatus,
    ...(typeof record.objective === "string" ? { objective: record.objective } : {}),
    ...(typeof record.tokensUsed === "number" ? { tokensUsed: record.tokensUsed } : {}),
    ...(typeof record.tokenBudget === "number" || record.tokenBudget === null
      ? { tokenBudget: record.tokenBudget }
      : {}),
    ...(typeof record.autoTurns === "number" ? { autoTurns: record.autoTurns } : {}),
    ...(typeof record.maxAutoTurns === "number" || record.maxAutoTurns === null
      ? { maxAutoTurns: record.maxAutoTurns }
      : {}),
    ...(typeof record.budgetWrapupSent === "boolean" ? { wrapupSent: record.budgetWrapupSent } : {}),
  })
}

/**
 * Qualified server-only Goal integration for Fabi's OPENCODE_PURE runtime.
 *
 * The normal npm plugin loader stays disabled. This exact dependency is loaded
 * as trusted product code, and the Fabi chat variant deterministically creates
 * a goal before the model turn instead of hoping the model calls create_goal.
 */
export async function FabiGoalPlugin(input: PluginInput): Promise<LifecycleHooks> {
  if (!GoalModule || typeof GoalModule.server !== "function") {
    throw new Error("qualified Goal plugin has no server entrypoint")
  }
  const hooks = (await GoalModule.server(input, {
    auto_continue: true,
    defer_while_tasks_active: true,
    max_auto_turns: 25,
    max_prompt_failures: 1,
    register_command: true,
    command_name: "goal",
    restricted_agents: ["plan"],
    allow_goal_execution_from_plan: false,
  })) as LifecycleHooks
  const get = hooks.tool?.get_goal
  const create = hooks.tool?.create_goal
  const updateStatus = hooks.tool?.update_goal_status
  if (!get || !create || !updateStatus) throw new Error("qualified Goal plugin is missing lifecycle tools")

  const status = async (sessionID: string) =>
    parseSnapshot(await output(get, {}, context(input, sessionID, "build")))
  const setStatus = async (sessionID: string, goalStatus: "active" | "paused") => {
    const updated = parseSnapshot(
      await output(updateStatus, { status: goalStatus }, context(input, sessionID, "build")),
    )
    if (!updated) throw new Error("qualified Goal plugin returned no goal after status update")
    return updated
  }
  const idleDecisions = new Map<string, IdleDecision>()

  const originalMessage = hooks["chat.message"]
  hooks["chat.message"] = async (message, response) => {
    if (message.variant === GOAL_VARIANT) {
      const objective = text(response.parts)
      if (!objective) throw new Error("Goal mode requires a non-empty objective")
      const current = await status(message.sessionID)
      if (!current || TERMINAL.has(current.status)) {
        await output(create, { objective }, context(input, message.sessionID, "build"))
      } else if (current.status !== "active") {
        // Selecting Goal and submitting is an explicit resume action. This is
        // deliberately not triggered by ordinary Agent/Ask messages.
        await setStatus(message.sessionID, "active")
      }
    }
    await originalMessage?.(message, response)
  }
  const originalEvent = hooks.event
  hooks.event = async (input) => {
    const sessionID = sessionIDFromGoalEvent(input.event)
    const idle = isGoalIdleEvent(input.event) && !!sessionID
    const before = idle ? await status(sessionID) : null
    await originalEvent?.(input)
    if (!idle) return
    const after = await status(sessionID)
    const continued = after?.status === "active" && (after.autoTurns ?? 0) > (before?.autoTurns ?? 0)
    const wrapup =
      (after?.status === "budgetLimited" || after?.status === "usageLimited") &&
      after.wrapupSent === true &&
      before?.wrapupSent !== true
    idleDecisions.set(sessionID, continued ? "continued" : wrapup ? "wrapup" : "settled")
  }
  hooks[Lifecycle] = {
    status,
    setStatus,
    takeIdleDecision(sessionID) {
      const decision = idleDecisions.get(sessionID)
      idleDecisions.delete(sessionID)
      return decision
    },
  }
  return hooks
}

function eventRecord(event: unknown) {
  return event && typeof event === "object" ? (event as { type?: unknown; properties?: unknown }) : undefined
}

function eventProperties(event: unknown) {
  const properties = eventRecord(event)?.properties
  return properties && typeof properties === "object" ? (properties as Record<string, unknown>) : undefined
}

export function isGoalIdleEvent(event: unknown) {
  const record = eventRecord(event)
  const properties = eventProperties(event)
  if (record?.type === "session.idle") return typeof properties?.sessionID === "string"
  if (record?.type !== "session.status" || typeof properties?.sessionID !== "string") return false
  const status = properties.status
  return !!status && typeof status === "object" && "type" in status && status.type === "idle"
}

export function sessionIDFromGoalEvent(event: unknown) {
  const sessionID = eventProperties(event)?.sessionID
  return typeof sessionID === "string" ? SessionID.make(sessionID) : undefined
}
