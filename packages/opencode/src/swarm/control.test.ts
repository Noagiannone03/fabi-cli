// Tests du planificateur de hot-swap (pur) + du bridge TUI→lifecycle.

import { afterEach, describe, expect, test } from "bun:test"
import {
  planSwarmSwitch,
  registerSwarmSwitchHandler,
  requestSwarmSwitch,
  type SwarmSwitchResult,
} from "./control"
import type { DiscoverResult, RegistrySwarm } from "./registry"
import type { SwarmActiveState } from "./state"

const swarm = (over: Partial<RegistrySwarm>): RegistrySwarm => ({
  id: "swarm-b",
  name: "B",
  schedulerUrl: "https://sched/b",
  schedulerPeer: "12D3KooWB",
  model: "meta/Llama-3-70B",
  status: "online",
  schedulerStatus: "ready",
  peers: 4,
  totalVramGb: 80,
  lastSeen: new Date().toISOString(),
  ...over,
})

const state = (over: Partial<SwarmActiveState>): SwarmActiveState => ({
  phase: "running",
  swarmId: "swarm-a",
  swarmModel: "Qwen/Qwen3-Coder-30B",
  ...over,
})

const okResult = (s: RegistrySwarm): DiscoverResult => ({ kind: "ok", swarm: s, allSwarms: [s] })

describe("planSwarmSwitch", () => {
  test("registry error → abort", () => {
    const plan = planSwarmSwitch(state({}), { kind: "registry-error", error: new Error("boom") })
    expect(plan.action).toBe("abort")
    if (plan.action === "abort") expect(plan.reason).toBe("registry-error")
  })

  test("no match → abort not-found", () => {
    const plan = planSwarmSwitch(state({}), { kind: "no-match", reason: "none", allSwarms: [] })
    expect(plan.action).toBe("abort")
    if (plan.action === "abort") expect(plan.reason).toBe("not-found")
  })

  test("different swarm → switch", () => {
    const plan = planSwarmSwitch(state({ swarmId: "swarm-a" }), okResult(swarm({ id: "swarm-b" })))
    expect(plan.action).toBe("switch")
  })

  test("same swarm + worker alive → same (no-op)", () => {
    const plan = planSwarmSwitch(
      state({ swarmId: "swarm-b", phase: "running" }),
      okResult(swarm({ id: "swarm-b" })),
    )
    expect(plan.action).toBe("same")
  })

  test("same swarm but worker crashed → switch (re-join)", () => {
    const plan = planSwarmSwitch(
      state({ swarmId: "swarm-b", phase: "crashed" }),
      okResult(swarm({ id: "swarm-b" })),
    )
    expect(plan.action).toBe("switch")
  })

  test("no current swarm (idle) → switch", () => {
    const plan = planSwarmSwitch(
      state({ swarmId: undefined, phase: "idle" }),
      okResult(swarm({ id: "swarm-b" })),
    )
    expect(plan.action).toBe("switch")
  })
})

describe("requestSwarmSwitch bridge", () => {
  afterEach(() => registerSwarmSwitchHandler(null))

  test("no handler → no-runtime", async () => {
    registerSwarmSwitchHandler(null)
    expect(await requestSwarmSwitch("x/Model")).toEqual({ ok: false, reason: "no-runtime" })
  })

  test("forwards to the registered handler", async () => {
    const result: SwarmSwitchResult = { ok: true, model: "x/Model", swarmId: "s" }
    let received = ""
    registerSwarmSwitchHandler(async (m) => {
      received = m
      return result
    })
    expect(await requestSwarmSwitch("x/Model")).toBe(result)
    expect(received).toBe("x/Model")
  })

  test("handler throw → spawn-failed (never throws to the TUI)", async () => {
    registerSwarmSwitchHandler(async () => {
      throw new Error("kaboom")
    })
    const r = await requestSwarmSwitch("x/Model")
    expect(r.ok).toBe(false)
    expect(r.reason).toBe("spawn-failed")
    expect(r.message).toBe("kaboom")
  })
})
