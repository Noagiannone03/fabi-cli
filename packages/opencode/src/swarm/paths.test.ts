import { describe, expect, test } from "bun:test"
import { fabiDataRoot, fabiRuntimeRoot } from "./paths"

describe("Fabi managed paths", () => {
  test("uses LOCALAPPDATA for a native Windows installation", () => {
    expect(
      fabiRuntimeRoot("win32", { LOCALAPPDATA: "C:\\Users\\noa\\AppData\\Local" }, "C:\\Users\\noa").replaceAll(
        "\\",
        "/",
      ),
    ).toBe("C:/Users/noa/AppData/Local/fabi/runtime")
  })

  test("keeps XDG_DATA_HOME as an explicit override on Windows", () => {
    expect(
      fabiDataRoot(
        "win32",
        { XDG_DATA_HOME: "D:\\portable\\data", LOCALAPPDATA: "C:\\Users\\noa\\AppData\\Local" },
        "C:\\Users\\noa",
      ).replaceAll("\\", "/"),
    ).toBe("D:/portable/data/fabi")
  })

  test("uses the XDG-compatible Unix fallback", () => {
    expect(fabiRuntimeRoot("darwin", {}, "/Users/noa")).toBe("/Users/noa/.local/share/fabi/runtime")
  })
})
