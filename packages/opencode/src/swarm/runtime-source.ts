export const QUALIFIED_PARALLAX_COMMIT = "214cb7f651af897c2bdf1b2b7ac1dd1e72542479"

export function isCommitSha(ref: string | null | undefined): ref is string {
  return !!ref && /^[0-9a-f]{40}$/i.test(ref)
}

/**
 * Build the exact Git operations used for a cold managed checkout.
 *
 * `git clone --branch <sha>` does not accept commit SHAs. For immutable
 * runtime pins, initialise an empty repository and fetch only the qualified
 * reachable commit. Branch/tag overrides keep the ordinary shallow clone.
 */
export function managedCloneArgs(source: { localPath: string; cloneUrl?: string; cloneRef?: string }): string[][] {
  if (!source.cloneUrl) return []
  if (isCommitSha(source.cloneRef)) {
    return [
      ["init", source.localPath],
      ["-C", source.localPath, "remote", "add", "origin", source.cloneUrl],
      ["-C", source.localPath, "fetch", "--depth=1", "origin", source.cloneRef],
      ["-C", source.localPath, "checkout", "--detach", "FETCH_HEAD"],
    ]
  }
  const args = ["clone", "--depth=1"]
  if (source.cloneRef) args.push("--branch", source.cloneRef)
  args.push(source.cloneUrl, source.localPath)
  return [args]
}
