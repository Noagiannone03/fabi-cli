import { describe, expect, test } from "bun:test"
import { managedCloneArgs, QUALIFIED_PARALLAX_COMMIT } from "./runtime-source"

describe("managed Parallax source", () => {
  test("pins the runtime qualified by the swarm E2E", () => {
    expect(QUALIFIED_PARALLAX_COMMIT).toBe("48378d75f01b88bae693cbb763cfe36f7939b734")
  })

  test("fetches an immutable commit without treating it as a branch", () => {
    expect(
      managedCloneArgs({
        localPath: "/runtime/parallax-src",
        cloneUrl: "https://github.com/Noagiannone03/swarm-engine.git",
        cloneRef: QUALIFIED_PARALLAX_COMMIT,
      }),
    ).toEqual([
      ["init", "/runtime/parallax-src"],
      ["-C", "/runtime/parallax-src", "remote", "add", "origin", "https://github.com/Noagiannone03/swarm-engine.git"],
      ["-C", "/runtime/parallax-src", "fetch", "--depth=1", "origin", QUALIFIED_PARALLAX_COMMIT],
      ["-C", "/runtime/parallax-src", "checkout", "--detach", "FETCH_HEAD"],
    ])
  })

  test("keeps explicit branch overrides available for development", () => {
    expect(
      managedCloneArgs({
        localPath: "/runtime/parallax-src",
        cloneUrl: "https://example.com/parallax.git",
        cloneRef: "topic-branch",
      }),
    ).toEqual([
      ["clone", "--depth=1", "--branch", "topic-branch", "https://example.com/parallax.git", "/runtime/parallax-src"],
    ])
  })
})
