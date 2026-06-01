// Tests du planificateur de démarrage (fonction pure, sans I/O).

import { describe, expect, test } from "bun:test"
import type { RegistrySwarm } from "./registry"
import {
  formatSwarmChoice,
  isSwarmHealthy,
  isSwarmUsable,
  planSwarmStartup,
  sortByHealth,
} from "./startup-picker"

const swarm = (over: Partial<RegistrySwarm>): RegistrySwarm => ({
  id: "s",
  name: "S",
  schedulerUrl: "https://sched/x",
  schedulerPeer: "12D3KooWPEER",
  model: "Qwen/Qwen3-Coder-30B",
  status: "online",
  schedulerStatus: "ready",
  peers: 3,
  totalVramGb: 48,
  lastSeen: new Date().toISOString(),
  ...over,
})

describe("isSwarmUsable / isSwarmHealthy", () => {
  test("online + peers > 0 + peer/url → healthy", () => {
    const s = swarm({})
    expect(isSwarmUsable(s)).toBe(true)
    expect(isSwarmHealthy(s)).toBe(true)
  })
  test("online but 0 peers → usable, not healthy", () => {
    const s = swarm({ peers: 0 })
    expect(isSwarmUsable(s)).toBe(true)
    expect(isSwarmHealthy(s)).toBe(false)
  })
  test("offline → not usable", () => {
    expect(isSwarmUsable(swarm({ status: "offline" }))).toBe(false)
  })
  test("missing schedulerPeer → not usable", () => {
    expect(isSwarmUsable(swarm({ schedulerPeer: null }))).toBe(false)
  })
})

describe("planSwarmStartup", () => {
  test("remembered model still healthy → auto, no prompt", () => {
    const a = swarm({ id: "a", model: "Qwen/Qwen3-Coder-30B", peers: 2 })
    const b = swarm({ id: "b", model: "meta/Llama-3-70B", peers: 5 })
    const plan = planSwarmStartup({ swarms: [a, b], rememberedModel: "Qwen3-Coder" })
    expect(plan.action).toBe("auto")
    if (plan.action === "auto") expect(plan.swarm.id).toBe("a")
  })

  test("remembered has no peers, a healthy alternative exists → prompt, default on remembered", () => {
    const dead = swarm({ id: "a", model: "Qwen/Qwen3-Coder-30B", peers: 0 })
    const alive = swarm({ id: "b", model: "meta/Llama-3-70B", peers: 5 })
    const plan = planSwarmStartup({ swarms: [dead, alive], rememberedModel: "Qwen3-Coder" })
    expect(plan.action).toBe("prompt")
    if (plan.action === "prompt") {
      // sorted health-first → alive (b) first, dead (a) second; default points at remembered (a)
      expect(plan.choices[0]!.id).toBe("b")
      expect(plan.choices[plan.defaultIndex]!.id).toBe("a")
      expect(plan.reason).toContain("no peers")
    }
  })

  test("single usable swarm → auto even if it has no peers (nothing to choose)", () => {
    const only = swarm({ id: "a", peers: 0 })
    const plan = planSwarmStartup({ swarms: [only], rememberedModel: undefined })
    expect(plan.action).toBe("auto")
    if (plan.action === "auto") expect(plan.swarm.id).toBe("a")
  })

  test("no usable swarm → none (let existing fallback handle)", () => {
    const plan = planSwarmStartup({ swarms: [swarm({ status: "offline" })] })
    expect(plan.action).toBe("none")
  })

  test("explicit preference matching → auto, never prompt", () => {
    const a = swarm({ id: "a", model: "Qwen/Qwen3-Coder-30B", peers: 0 })
    const b = swarm({ id: "b", model: "meta/Llama-3-70B", peers: 5 })
    const plan = planSwarmStartup({
      swarms: [a, b],
      rememberedModel: "Qwen3-Coder",
      explicitPreference: true,
    })
    expect(plan.action).toBe("auto")
    if (plan.action === "auto") expect(plan.swarm.id).toBe("a")
  })

  test("explicit preference with no match → none", () => {
    const plan = planSwarmStartup({
      swarms: [swarm({ model: "meta/Llama-3-70B" })],
      rememberedModel: "DoesNotExist",
      explicitPreference: true,
    })
    expect(plan.action).toBe("none")
  })

  test("multiple usable, no remembered → prompt, default on healthiest", () => {
    const a = swarm({ id: "a", model: "x/A", peers: 1 })
    const b = swarm({ id: "b", model: "x/B", peers: 9 })
    const plan = planSwarmStartup({ swarms: [a, b] })
    expect(plan.action).toBe("prompt")
    if (plan.action === "prompt") {
      expect(plan.choices[0]!.id).toBe("b") // most peers first
      expect(plan.defaultIndex).toBe(0)
    }
  })

  test("forcePrompt overrides a healthy remembered swarm", () => {
    const a = swarm({ id: "a", model: "Qwen/Qwen3-Coder-30B", peers: 5 })
    const b = swarm({ id: "b", model: "x/B", peers: 2 })
    const plan = planSwarmStartup({
      swarms: [a, b],
      rememberedModel: "Qwen3-Coder",
      forcePrompt: true,
    })
    expect(plan.action).toBe("prompt")
  })
})

describe("sortByHealth / formatSwarmChoice", () => {
  test("healthy first then peers desc", () => {
    const dead = swarm({ id: "d", peers: 0 })
    const small = swarm({ id: "s", peers: 1 })
    const big = swarm({ id: "b", peers: 8 })
    expect(sortByHealth([dead, small, big]).map((s) => s.id)).toEqual(["b", "s", "d"])
  })
  test("format shows model, peers and a health label", () => {
    expect(formatSwarmChoice(swarm({ peers: 3 }))).toContain("3 peers")
    expect(formatSwarmChoice(swarm({ peers: 3 }))).toContain("ready")
    expect(formatSwarmChoice(swarm({ peers: 0 }))).toContain("no peers yet")
    expect(formatSwarmChoice(swarm({ peers: 1 }))).toContain("1 peer")
  })
})
