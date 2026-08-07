import { homedir } from "node:os"
import { join } from "node:path"

/**
 * Resolve the persistent Fabi root using the native convention of the host.
 *
 * `XDG_DATA_HOME` remains the explicit cross-platform override used by tests
 * and portable installs. Native Windows installers use `%LOCALAPPDATA%\fabi`,
 * while Unix keeps `~/.local/share/fabi`.
 */
export function fabiDataRoot(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const explicit = env.XDG_DATA_HOME?.trim()
  const nativeWindows = platform === "win32" ? env.LOCALAPPDATA?.trim() : undefined
  return join(explicit || nativeWindows || join(home, ".local", "share"), "fabi")
}

export function fabiRuntimeRoot(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  return join(fabiDataRoot(platform, env, home), "runtime")
}
