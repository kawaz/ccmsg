import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import type { WorkspaceFolder } from "@ccmsg/protocol";

/** The folders a session's editor workspace names, read where the editor
 * writes them.
 *
 * Not folded out of the transcript, because the transcript does not carry them:
 * the harness records what was said and done in a session, and no record of any
 * kind names an editor workspace. The old daemon read them the same way, from
 * the workspace file beside the session's working directory, and that file is
 * the only place the folders are stated.
 *
 * A session that has no workspace file names no folders, which is what an empty
 * list means to the contract and admits no `workspace` path at all. */
export function workspaceFolders(cwd: string | undefined): WorkspaceFolder[] {
  if (cwd === undefined || !isAbsolute(cwd)) return [];
  const folders: WorkspaceFolder[] = [];
  const seen = new Set<string>();
  for (const file of workspaceFiles(cwd)) {
    for (const spec of specs(file)) {
      // Relative to the workspace file, which is how an editor reads them.
      const real = directory(resolve(dirname(file), spec.path));
      if (real === undefined || overbroad(real) || seen.has(real)) continue;
      seen.add(real);
      folders.push({ name: spec.name ?? basename(real), path: real });
    }
  }
  return folders;
}

/** The workspace files directly beside the session's working directory, in a
 * fixed order so the same directory always states its folders the same way. */
function workspaceFiles(cwd: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(cwd);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith(WORKSPACE_SUFFIX))
    .sort()
    .map((name) => resolve(cwd, name));
}

/** What one workspace file declares: the `folders` array, and of each entry the
 * path it names and the name it may give that path. */
function specs(file: string): { path: string; name?: string }[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(uncommented(readFileSync(file, "utf8")));
  } catch {
    // Written by hand and half-saved, or not a workspace file after all.
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const declared = (parsed as Record<string, unknown>)["folders"];
  if (!Array.isArray(declared)) return [];
  const specs: { path: string; name?: string }[] = [];
  for (const entry of declared) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const path = row["path"];
    if (typeof path !== "string" || path.length === 0) continue;
    const name = row["name"];
    specs.push({
      path,
      ...(typeof name === "string" && name.length > 0 ? { name } : {}),
    });
  }
  return specs;
}

/** A workspace file is JSON with comments and trailing commas, which the
 * editors that write it accept. Stripped rather than parsed by a second
 * grammar: what survives is the JSON the file already is. Strings are tracked
 * so that a `//` inside a path is not mistaken for a comment. */
function uncommented(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] as string;
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    const next = text[i + 1];
    if (char === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    out += char;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** What the filesystem calls a folder that is one. A path naming a file, or
 * nothing at all, names no folder and is dropped. */
function directory(path: string): string | undefined {
  try {
    const real = realpathSync(path);
    return statSync(real).isDirectory() ? real : undefined;
  } catch {
    return undefined;
  }
}

/** Whether admitting a folder would admit far more than a workspace.
 *
 * The root and the home directory and anything above them are refused: a
 * workspace file naming one of those turns the `workspace` surface into the
 * whole filesystem, and the folders are an allowlist rather than a hint. */
function overbroad(real: string): boolean {
  if (real === sep || dirname(real) === real) return true;
  const home = directory(homedir());
  return home !== undefined && (real === home || home.startsWith(withSep(real)));
}

function withSep(path: string): string {
  return path.endsWith(sep) ? path : path + sep;
}

const WORKSPACE_SUFFIX = ".code-workspace";
