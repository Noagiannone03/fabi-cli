// Tests sur la sélection de swarms côté CLI.

import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test"
import { discoverSwarm, fetchRegistrySwarms, type RegistrySwarm } from "./registry"

const baseSwarm = (over: Partial<RegistrySwarm>): RegistrySwarm => ({
  id: "swarm-1",
  name: "Swarm 1",
  schedulerUrl: "http://example.com:3001",
  schedulerPeer: "12D3KooWAAA",
  model: "Qwen/Qwen3-Coder-30B",
  status: "online",
  schedulerStatus: "ready",
  peers: 3,
  totalVramGb: 48,
  lastSeen: new Date().toISOString(),
  ...over,
})

const installFetchMock = (impl: () => Promise<Response>): void => {
  // Bun's `typeof fetch` includes `preconnect` ; on mock juste l'appel principal
  // et on cast en typeof fetch via unknown pour satisfaire TS sans complexité.
  globalThis.fetch = mock(impl) as unknown as typeof fetch
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("fetchRegistrySwarms", () => {
  test("retourne la liste depuis la réponse API", async () => {
    installFetchMock(async () =>
      new Response(
        JSON.stringify({
          apiVersion: "v1",
          generatedAt: "now",
          host: "x",
          swarms: [baseSwarm({})],
        }),
      ),
    )
    const out = await fetchRegistrySwarms("http://reg/")
    expect(out).toHaveLength(1)
    expect(out[0]?.id).toBe("swarm-1")
  })

  test("throw si non-2xx", async () => {
    installFetchMock(async () => new Response("nope", { status: 503 }))
    await expect(fetchRegistrySwarms("http://reg")).rejects.toThrow(/503/)
  })

  test("throw si JSON sans swarms[]", async () => {
    installFetchMock(async () => new Response(JSON.stringify({ apiVersion: "v1" })))
    await expect(fetchRegistrySwarms("http://reg")).rejects.toThrow()
  })
})

describe("discoverSwarm", () => {
  beforeEach(() => {
    installFetchMock(async () =>
      new Response(
        JSON.stringify({
          apiVersion: "v1",
          generatedAt: "now",
          host: "x",
          swarms: [
            baseSwarm({ id: "alpha", model: "Qwen/Qwen3-Coder-30B" }),
            baseSwarm({ id: "beta", model: "Llama-3.3-70B" }),
            baseSwarm({ id: "offline", status: "offline" }),
          ],
        }),
      ),
    )
  })

  test("retourne le 1er online par défaut", async () => {
    const r = await discoverSwarm({ registryUrl: "http://reg" })
    expect(r.kind).toBe("ok")
    if (r.kind === "ok") expect(r.swarm.id).toBe("alpha")
  })

  test("filtre par preferredId", async () => {
    const r = await discoverSwarm({ registryUrl: "http://reg", preferredId: "beta" })
    expect(r.kind).toBe("ok")
    if (r.kind === "ok") expect(r.swarm.id).toBe("beta")
  })

  test("no-match si preferredId inconnu", async () => {
    const r = await discoverSwarm({ registryUrl: "http://reg", preferredId: "xyz" })
    expect(r.kind).toBe("no-match")
    if (r.kind === "no-match") expect(r.reason).toContain("xyz")
  })

  test("filtre par modèle (substring case-insensitive)", async () => {
    const r = await discoverSwarm({ registryUrl: "http://reg", preferredModel: "llama" })
    expect(r.kind).toBe("ok")
    if (r.kind === "ok") expect(r.swarm.id).toBe("beta")
  })

  test("registry-error si fetch fail", async () => {
    installFetchMock(async () => {
      throw new Error("network down")
    })
    const r = await discoverSwarm({ registryUrl: "http://reg" })
    expect(r.kind).toBe("registry-error")
  })

  test("offline filtré sauf si acceptOffline", async () => {
    const r1 = await discoverSwarm({ registryUrl: "http://reg", preferredId: "offline" })
    expect(r1.kind).toBe("no-match")
    const r2 = await discoverSwarm({
      registryUrl: "http://reg",
      preferredId: "offline",
      acceptOffline: true,
    })
    expect(r2.kind).toBe("ok")
  })
})
