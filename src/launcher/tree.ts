import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { DirTreeArgs, DirTreeEntry, DirTreeResult } from "@ccmsg/protocol";
import type { LauncherConfig } from "../instance/config.ts";
import { insideRoots } from "./roots.ts";

/** How far one request may walk, whatever it asks for.
 *
 * Design rationale: the depth is the client's to choose, and a walk whose cost
 * the client sets has no bound at all. Five levels covers the configured depth
 * plus several lazy expansions, and going deeper stays a matter of asking for a
 * descendant — which is the same walk, paid for one request at a time. */
const MAX_DEPTH = 5;

/** The directories a session could be started in.
 *
 * Directories only, and only below the configured roots. A root the config does
 * not hold contributes nothing rather than failing the request: the op states no
 * refusal for a path, and a tree assembled from several roots would otherwise be
 * lost whole because one of them went away. */
export function dirTree(config: LauncherConfig, args: DirTreeArgs): DirTreeResult {
  const depth = Math.min(MAX_DEPTH, args.depth ?? config.depth);
  // A filter of nothing is not a filter: an emptied search box shows the tree
  // rather than hiding all of it.
  const filter = args.filter === undefined || args.filter === "" ? undefined : args.filter;
  const entries: DirTreeEntry[] = [];
  for (const root of args.roots) {
    const real = insideRoots(config, root);
    if (real === undefined) continue;
    entries.push(...walk(config, real, real, depth, filter));
  }
  return { entries: sorted(entries) };
}

function walk(
  config: LauncherConfig,
  root: string,
  at: string,
  depth: number,
  filter: string | undefined,
): DirTreeEntry[] {
  const entries: DirTreeEntry[] = [];
  for (const dirent of read(at)) {
    // Design rationale: dot-directories are left out. This answers "where could
    // a session run", and a repository's `.git` is not one of those places —
    // browsing a session's own files is a different op with different rules.
    if (dirent.name.startsWith(".")) continue;
    const path = join(at, dirent.name);
    if (dirent.isSymbolicLink()) {
      // A link is a place to run only if what it points at is one, so it goes
      // through the same containment its target would.
      if (insideRoots(config, path) === undefined) continue;
    } else if (!dirent.isDirectory()) continue;

    const children = depth > 1 ? walk(config, root, path, depth - 1, filter) : undefined;
    if (filter !== undefined) {
      const matches = relative(root, path).includes(filter);
      // An ancestor of a match survives the filter: without it a match several
      // levels down would have nothing to hang from.
      if (!matches && (children === undefined || children.length === 0)) continue;
    }
    entries.push({ path, ...(children === undefined ? {} : { children: sorted(children) }) });
  }
  return entries;
}

function read(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    // A directory that cannot be read is still a place to run; what it holds is
    // simply not known, which is the same answer as holding nothing.
    return [];
  }
}

/** Codepoint order, which is the same wherever the daemon runs. */
function sorted(entries: DirTreeEntry[]): DirTreeEntry[] {
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
