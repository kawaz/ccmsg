import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { LauncherConfig } from "../instance/config.ts";
import { canonical, within } from "../files/index.ts";

/** Whether a directory is one the launcher may act on, and what the filesystem
 * calls it.
 *
 * The comparison runs on what both sides resolve to, so a path spelled through
 * a symlink out of a root is refused however it was written — the same rule the
 * file ops go through, asked of the roots config states rather than of the ones
 * a session states.
 *
 * A root that no longer resolves grants nothing and stops nothing: another
 * configured root may still hold the candidate. */
export function insideRoots(config: LauncherConfig, path: string): string | undefined {
  if (!isAbsolute(path)) return undefined;
  const real = canonical(path);
  if (!isDirectory(real)) return undefined;
  for (const root of config.root_dirs) {
    if (within(real, canonical(root))) return real;
  }
  return undefined;
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
