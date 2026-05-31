// Tests sur le tiering mémoire des limites worker (fonction pure, sans hardware).

import { describe, expect, test } from "bun:test"
import { resolveWorkerLimits, type HardwareProfile } from "./worker"

const DEFAULTS = {
  maxBatchSize: "8",
  maxSequenceLength: "32768",
  maxNumTokensPerBatch: "16384",
  kvBlockSize: "32",
}

const hw = (over: Partial<HardwareProfile>): HardwareProfile => ({
  accelerator: "generic",
  ramGb: 32,
  ...over,
})

describe("resolveWorkerLimits — Apple Silicon", () => {
  test("≤24 GB unifié → batch=1, seq=16384", () => {
    const l = resolveWorkerLimits(hw({ accelerator: "apple-silicon", ramGb: 16 }))
    expect(l.maxBatchSize).toBe("1")
    expect(l.maxSequenceLength).toBe("16384")
  })
  test("32 GB unifié → batch=2", () => {
    const l = resolveWorkerLimits(hw({ accelerator: "apple-silicon", ramGb: 32 }))
    expect(l.maxBatchSize).toBe("2")
    expect(l.maxSequenceLength).toBe("32768")
  })
  test("≥64 GB → defaults pleins", () => {
    expect(resolveWorkerLimits(hw({ accelerator: "apple-silicon", ramGb: 128 }))).toEqual(DEFAULTS)
  })
})

describe("resolveWorkerLimits — CUDA (VRAM tiers)", () => {
  test("8 GB (3060) → batch=1, seq=8192, kv=16", () => {
    const l = resolveWorkerLimits(hw({ accelerator: "cuda", vramGb: 8 }))
    expect(l).toEqual({ maxBatchSize: "1", maxSequenceLength: "8192", maxNumTokensPerBatch: "4096", kvBlockSize: "16" })
  })
  test("12 GB → batch=1, seq=16384", () => {
    const l = resolveWorkerLimits(hw({ accelerator: "cuda", vramGb: 12 }))
    expect(l.maxBatchSize).toBe("1")
    expect(l.maxSequenceLength).toBe("16384")
  })
  test("16 GB → batch=2, seq=16384", () => {
    const l = resolveWorkerLimits(hw({ accelerator: "cuda", vramGb: 16 }))
    expect(l.maxBatchSize).toBe("2")
    expect(l.maxSequenceLength).toBe("16384")
  })
  test("20 GB (4080) → batch=2, seq=32768", () => {
    const l = resolveWorkerLimits(hw({ accelerator: "cuda", vramGb: 20 }))
    expect(l.maxBatchSize).toBe("2")
    expect(l.maxSequenceLength).toBe("32768")
  })
  test("24 GB (3090/4090) → defaults pleins", () => {
    expect(resolveWorkerLimits(hw({ accelerator: "cuda", vramGb: 24 }))).toEqual(DEFAULTS)
  })
  test("4090 reporté à 23.99 GB (24564 MiB) → arrondi à 24 → defaults", () => {
    expect(resolveWorkerLimits(hw({ accelerator: "cuda", vramGb: 24564 / 1024 }))).toEqual(DEFAULTS)
  })
  test("48 GB (A6000) → defaults pleins", () => {
    expect(resolveWorkerLimits(hw({ accelerator: "cuda", vramGb: 48 }))).toEqual(DEFAULTS)
  })
})

describe("resolveWorkerLimits — generic / CPU", () => {
  test("pas d'accélérateur détecté → defaults pleins", () => {
    expect(resolveWorkerLimits(hw({ accelerator: "generic" }))).toEqual(DEFAULTS)
  })
})
