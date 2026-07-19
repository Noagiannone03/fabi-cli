import { describe, expect, test } from "bun:test"
import { normalizeAccountToken } from "./account-token"

describe("Fabi account credential", () => {
  test("accepts exactly 32 hexadecimal bytes and canonicalizes case", () => {
    expect(normalizeAccountToken("AB".repeat(32))).toBe("ab".repeat(32))
    expect(normalizeAccountToken(`  ${"01".repeat(32)}\n`)).toBe("01".repeat(32))
  })

  test("rejects malformed credentials", () => {
    expect(normalizeAccountToken(undefined)).toBeUndefined()
    expect(normalizeAccountToken("")).toBeUndefined()
    expect(normalizeAccountToken("ab".repeat(31))).toBeUndefined()
    expect(normalizeAccountToken("zz".repeat(32))).toBeUndefined()
  })
})
