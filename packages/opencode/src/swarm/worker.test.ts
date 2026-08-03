// Tests sur le tiering mémoire des limites worker (fonction pure, sans hardware).

import { afterEach, describe, expect, test } from "bun:test"
import {
  gpuBackendArgs,
  prefixCacheArgs,
  prefixCacheEnabled,
  resolveMemoryReserveEnv,
  resolveWorkerLimits,
  type HardwareProfile,
} from "./worker"

const DEFAULTS = {
  maxBatchSize: "2",
  maxSequenceLength: "32768",
  maxNumTokensPerBatch: "8192",
  kvBlockSize: "32",
}

const hw = (over: Partial<HardwareProfile>): HardwareProfile => ({
  accelerator: "generic",
  ramGb: 32,
  ...over,
})

describe("resolveWorkerLimits — Apple Silicon", () => {
  test("≤24 GB unifié → batch=1, fenêtre 32k chunkée", () => {
    const l = resolveWorkerLimits(hw({ accelerator: "apple-silicon", ramGb: 16 }))
    expect(l.maxBatchSize).toBe("1")
    expect(l.maxSequenceLength).toBe("32768")
  })
  test("32 GB unifié → batch=1, fenêtre 32k", () => {
    const l = resolveWorkerLimits(hw({ accelerator: "apple-silicon", ramGb: 32 }))
    expect(l.maxBatchSize).toBe("1")
    expect(l.maxSequenceLength).toBe("32768")
  })
  test("≥64 GB → defaults pleins", () => {
    expect(resolveWorkerLimits(hw({ accelerator: "apple-silicon", ramGb: 128 }))).toEqual(DEFAULTS)
  })
})

describe("resolveMemoryReserveEnv", () => {
  test("lets the initialized runtime own RAM and VRAM admission on every OS", () => {
    expect(resolveMemoryReserveEnv(hw({ accelerator: "apple-silicon", ramGb: 16 }))).toEqual({})
    expect(resolveMemoryReserveEnv(hw({ accelerator: "generic", ramGb: 32 }))).toEqual({})
    expect(resolveMemoryReserveEnv(hw({ accelerator: "cuda", ramGb: 32, vramGb: 8 }))).toEqual({})
    expect(resolveMemoryReserveEnv(hw({ accelerator: "cuda", ramGb: 32, vramGb: 16 }))).toEqual({})
  })
})

describe("resolveWorkerLimits — CUDA (VRAM tiers)", () => {
  test("8 GB (3060) → batch=1, fenêtre 32k chunkée, kv=16", () => {
    const l = resolveWorkerLimits(hw({ accelerator: "cuda", vramGb: 8 }))
    expect(l).toEqual({
      maxBatchSize: "1",
      maxSequenceLength: "32768",
      maxNumTokensPerBatch: "4096",
      kvBlockSize: "16",
    })
  })
  test("12 GB → batch=1, fenêtre 32k chunkée", () => {
    const l = resolveWorkerLimits(hw({ accelerator: "cuda", vramGb: 12 }))
    expect(l.maxBatchSize).toBe("1")
    expect(l.maxSequenceLength).toBe("32768")
  })
  test("16 GB → batch=1, fenêtre 32k", () => {
    const l = resolveWorkerLimits(hw({ accelerator: "cuda", vramGb: 16 }))
    expect(l.maxBatchSize).toBe("1")
    expect(l.maxSequenceLength).toBe("32768")
  })
  test("20 GB (4080) → batch=1, fenêtre 32k", () => {
    const l = resolveWorkerLimits(hw({ accelerator: "cuda", vramGb: 20 }))
    expect(l.maxBatchSize).toBe("1")
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

describe("prefixCacheEnabled — opt-out env", () => {
  const original = process.env.FABI_PREFIX_CACHE
  afterEach(() => {
    if (original === undefined) delete process.env.FABI_PREFIX_CACHE
    else process.env.FABI_PREFIX_CACHE = original
  })

  test("activé par défaut (var absente)", () => {
    delete process.env.FABI_PREFIX_CACHE
    expect(prefixCacheEnabled()).toBe(true)
  })
  test.each(["0", "false", "off", "no", "FALSE", " Off "])("désactivé par %p", (v) => {
    process.env.FABI_PREFIX_CACHE = v
    expect(prefixCacheEnabled()).toBe(false)
  })
  test.each(["1", "true", "on", "yes"])("activé par %p", (v) => {
    process.env.FABI_PREFIX_CACHE = v
    expect(prefixCacheEnabled()).toBe(true)
  })
})

describe("prefixCacheArgs — Parallax CLI contract", () => {
  test("uses the engine default when enabled", () => {
    expect(prefixCacheArgs(true)).toEqual([])
  })

  test("passes the current upstream opt-out when disabled", () => {
    expect(prefixCacheArgs(false)).toEqual(["--disable-prefix-cache"])
  })
})

describe("gpuBackendArgs — platform runtime contract", () => {
  test("selects the bundled vLLM runtime on native Windows", () => {
    expect(gpuBackendArgs("win32")).toEqual(["--gpu-backend", "vllm"])
  })

  test("keeps the platform default on Unix workers", () => {
    expect(gpuBackendArgs("darwin")).toEqual([])
    expect(gpuBackendArgs("linux")).toEqual([])
  })
})
