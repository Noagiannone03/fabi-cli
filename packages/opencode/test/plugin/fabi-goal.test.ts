import { afterEach, describe, expect, test } from "bun:test"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { FabiGoalPlugin, Lifecycle } from "@/plugin/fabi-goal"
import { mkdir, rm } from "fs/promises"
import { join } from "path"

const root = join(import.meta.dir, ".fabi-goal-state")
const previous = process.env.OPENCODE_GOAL_STATE_PATH

afterEach(async () => {
  if (previous === undefined) delete process.env.OPENCODE_GOAL_STATE_PATH
  else process.env.OPENCODE_GOAL_STATE_PATH = previous
  await rm(root, { recursive: true, force: true })
})

function input(client: Record<string, unknown> = {}) {
  return {
    client,
    project: {},
    directory: root,
    worktree: root,
    experimental_workspace: { register() {} },
    serverUrl: new URL("http://127.0.0.1:4096"),
    $: undefined,
  } as unknown as PluginInput
}

function message(hooks: Hooks, sessionID: string, objective: string) {
  return hooks["chat.message"]?.(
    { sessionID, agent: "build", variant: "fabi-goal" },
    {
      message: { sessionID, agent: "build" },
      parts: [{ type: "text", text: objective }],
    } as Parameters<NonNullable<Hooks["chat.message"]>>[1],
  )
}

describe("qualified Fabi Goal plugin", () => {
  test("creates one persistent goal deterministically from the Fabi variant", async () => {
    await mkdir(root, { recursive: true })
    process.env.OPENCODE_GOAL_STATE_PATH = join(root, "goals.json")
    const hooks = await FabiGoalPlugin(input())
    const lifecycle = hooks[Lifecycle]
    expect(lifecycle).toBeDefined()

    await message(hooks, "session-goal", "Finish the queue and prove it")
    const first = await lifecycle?.status("session-goal")
    expect(first?.status).toBe("active")
    expect(first?.objective).toBe("Finish the queue and prove it")

    await message(hooks, "session-goal", "This is a follow-up, not a replacement")
    const followup = await lifecycle?.status("session-goal")
    expect(followup?.objective).toBe(first?.objective)
    expect(followup?.autoTurns).toBe(first?.autoTurns)

    await hooks.dispose?.()
  })

  test("ordinary build messages never create a goal", async () => {
    await mkdir(root, { recursive: true })
    process.env.OPENCODE_GOAL_STATE_PATH = join(root, "goals.json")
    const hooks = await FabiGoalPlugin(input())

    await hooks["chat.message"]?.(
      { sessionID: "session-build", agent: "build" },
      {
        message: { sessionID: "session-build", agent: "build" },
        parts: [{ type: "text", text: "Ordinary agent request" }],
      } as Parameters<NonNullable<Hooks["chat.message"]>>[1],
    )

    expect(await hooks[Lifecycle]?.status("session-build")).toBeNull()
    await hooks.dispose?.()
  })

  test("pauses explicitly and resumes only from a new Goal submission", async () => {
    await mkdir(root, { recursive: true })
    process.env.OPENCODE_GOAL_STATE_PATH = join(root, "goals.json")
    const hooks = await FabiGoalPlugin(input())
    const lifecycle = hooks[Lifecycle]

    await message(hooks, "session-pause", "Complete the controlled objective")
    expect((await lifecycle?.setStatus("session-pause", "paused"))?.status).toBe("paused")

    await hooks["chat.message"]?.(
      { sessionID: "session-pause", agent: "build" },
      {
        message: { sessionID: "session-pause", agent: "build" },
        parts: [{ type: "text", text: "An Agent message must not resume Goal" }],
      } as Parameters<NonNullable<Hooks["chat.message"]>>[1],
    )
    expect((await lifecycle?.status("session-pause"))?.status).toBe("paused")

    await message(hooks, "session-pause", "Resume the same objective")
    expect((await lifecycle?.status("session-pause"))?.status).toBe("active")
    expect((await lifecycle?.status("session-pause"))?.objective).toBe("Complete the controlled objective")
    await hooks.dispose?.()
  })

  test("continues an active goal from the durable idle event without a watchdog timeout", async () => {
    await mkdir(root, { recursive: true })
    process.env.OPENCODE_GOAL_STATE_PATH = join(root, "goals.json")
    const continuations: Array<Record<string, unknown>> = []
    const hooks = await FabiGoalPlugin(
      input({
        session: {
          messages: async () => ({
            data: [
              {
                info: {
                  id: "assistant-1",
                  role: "assistant",
                  agent: "build",
                  time: { completed: Date.now() },
                },
                parts: [{ type: "text", text: "Initial work is not complete yet." }],
              },
            ],
          }),
          promptAsync: async (request: Record<string, unknown>) => {
            continuations.push(request)
          },
        },
        app: { log: async () => undefined },
      }),
    )

    await message(hooks, "session-continue", "Finish the durable objective")
    await hooks.event?.({
      event: {
        type: "session.status",
        properties: { sessionID: "session-continue", status: { type: "idle" } },
      } as Parameters<NonNullable<Hooks["event"]>>[0]["event"],
    })

    expect(continuations).toHaveLength(1)
    expect(hooks[Lifecycle]?.takeIdleDecision("session-continue")).toBe("continued")
    expect(continuations[0]).toMatchObject({
      path: { id: "session-continue" },
      body: { agent: "build", parts: [{ type: "text" }] },
    })
    expect((await hooks[Lifecycle]?.status("session-continue"))?.autoTurns).toBe(1)
    await hooks.dispose?.()
  })
})
