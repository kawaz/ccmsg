/** Which path the init system is told to run, and what became of the one it was
 * told.
 *
 * A unit file outlives the machine's software. The path this process is running
 * as is the path of one version of it — a runtime under a version manager lives
 * in a directory named after the version, and the next upgrade puts an
 * identical program somewhere else and takes that directory away. Registered as
 * it is, the supervisor works until the day it silently does not: the init
 * system goes on asking for a path nothing is at, and the person finds out when
 * nothing answers after a reboot.
 *
 * So a durable path is looked for before anything is written down, and what was
 * written down is read back by `service status`. The judgement here is the
 * coarse half of what `stable-which` does — whether the path names a version
 * rather than a program — and the reading back is what makes the other half
 * unnecessary: a pick that turns out wrong says so as a missing file rather
 * than as silence. */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, delimiter, join } from "node:path";
import { ENTRY } from "../daemon/registry.ts";
import type { Env } from "../instance/paths.ts";

/** Directory names that belong to one version of something rather than to the
 * thing itself. A path through any of them is gone at the next upgrade. */
const VERSIONED = ["/nix/store/", "/Cellar/", "/installs/", "/versions/", "/node_modules/"];

/** Whether this path is one a unit file may hold. */
export function durable(path: string): boolean {
  return !VERSIONED.some((mark) => path.includes(mark));
}

/** How large a file may be and still be read as a wrapper script. A wrapper is
 * a few lines; anything else is the program itself. */
const WRAPPER_MAX_BYTES = 64 * 1024;

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function sameFile(one: string, other: string): boolean {
  try {
    return realpathSync(one) === realpathSync(other);
  } catch {
    return false;
  }
}

/** Every entry of this name on `PATH`, in the order `PATH` states them. */
function onPath(name: string, env: Env): string[] {
  return (env["PATH"] ?? "")
    .split(delimiter)
    .filter((dir) => dir !== "")
    .map((dir) => join(dir, name))
    .filter((path) => isFile(path));
}

/** Whether running this path runs what this process is running: the same file,
 * or a wrapper that names the script this process was started with. */
function leadsHere(candidate: string, self: string): boolean {
  if (sameFile(candidate, self)) return true;
  try {
    if (statSync(candidate).size > WRAPPER_MAX_BYTES) return false;
    return readFileSync(candidate, "utf8").includes(ENTRY);
  } catch {
    return false;
  }
}

export interface Program {
  /** What the init system is told to run. */
  readonly command: string[];
  /** Whether that first path is one that survives an upgrade. False means the
   * best that could be found still names a version, which is worth saying
   * rather than hiding: the registration works now and is the one to redo
   * after the next upgrade. */
  readonly durable: boolean;
}

/** The supervisor as a path an init system can keep asking for.
 *
 * A `ccmsg` on `PATH` that leads back here is preferred over the runtime: it is
 * the program by its own name, and it stays put across a runtime upgrade
 * because it is what names the runtime rather than what the runtime is. Failing
 * that, the runtime by name on `PATH`, which at least resolves through whatever
 * the version manager keeps current. Failing both, this process's own path,
 * which is where it started. */
export function supervisorProgram(env: Env = process.env): Program {
  const self = process.execPath;
  for (const candidate of onPath("ccmsg", env)) {
    if (durable(candidate) && leadsHere(candidate, self)) {
      return { command: [candidate, "daemon", "supervise"], durable: true };
    }
  }
  for (const candidate of onPath(basename(self), env)) {
    if (durable(candidate) && sameFile(candidate, self)) {
      return { command: [candidate, ENTRY, "daemon", "supervise"], durable: true };
    }
  }
  return { command: [self, ENTRY, "daemon", "supervise"], durable: durable(self) };
}

/** What a unit file names as its program, and whether anything is there now. */
export interface RegisteredProgram {
  readonly path: string;
  /** Whether the registered path is one that survives an upgrade. A false here
   * is a registration that works today and will stop working quietly, which is
   * worth seeing before it does. */
  readonly durable: boolean;
  /** False on a registration whose program has moved: the init system is
   * asking for a path nothing is at, and re-registering is the answer. */
  readonly exists: boolean;
}

const ENTITY: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">" };

/** The program the registered unit names — read from the file rather than
 * worked out again, because the question is what the init system was told and
 * not what it would be told today. */
export function registeredProgram(
  unitFile: string,
  kind: "launchd" | "systemd",
): RegisteredProgram | null {
  let text: string;
  try {
    text = readFileSync(unitFile, "utf8");
  } catch {
    return null;
  }
  const found =
    kind === "launchd"
      ? /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(text)?.[1]
      : /^ExecStart=(\S+)/m.exec(text)?.[1];
  if (found === undefined) return null;
  const path = found.replace(/&amp;|&lt;|&gt;/g, (entity) => ENTITY[entity] as string);
  return { path, durable: durable(path), exists: existsSync(path) };
}
