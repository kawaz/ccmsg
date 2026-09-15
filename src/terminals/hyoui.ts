import { join } from "node:path";
import { HYOUI_TERMINAL_SCHEME, type InstanceId, type TerminalInfo } from "@ccmsg/protocol";
import { HYOUI_COMMAND, terminalId } from "./ids.ts";
import { run } from "../sessions/processes.ts";
import { DirectoryWatch } from "../sessions/watch.ts";
import type { TerminalListing, TerminalWatching } from "./terminals.ts";

/** How the manager is asked for its whole list. One line per terminal, which is
 * what lets a line this instance cannot read be dropped on its own. */
const LIST = [HYOUI_COMMAND, "list", "--format=jsonl"];

/** What the manager calls the namespace it lists when nobody named one, and how
 * it is named. A namespace of its own is a directory under the base; the
 * default one is the base itself (hyoui `discovery`). */
const DEFAULT_NAMESPACE = "default";
const NAMESPACE = "HYOUI_NAMESPACE";

/** The terminals of this host, as the manager states them.
 *
 * A host with no such command has no terminals to state, and says so with an
 * empty list rather than a failure: an instance on a host that manages no
 * terminals is not a broken one. Every other failure is thrown, because a poll
 * that failed says nothing about the host — least of all that its terminals
 * are gone. */
export function hostTerminals(instance: InstanceId): TerminalListing {
  return async () => {
    let jsonl: string;
    try {
      jsonl = await run(LIST);
    } catch (cause) {
      if (missing(cause)) return [];
      throw cause;
    }
    return terminalsOf(instance, jsonl);
  };
}

/** Where the manager keeps the socket it binds per terminal, which is what the
 * list it answers with is a reading of (hyoui `discovery`): one or both of
 * `$XDG_RUNTIME_DIR/hyoui` and `${XDG_STATE_HOME:-$HOME/.local/state}/hyoui`,
 * and under either, the directory of the namespace being listed.
 *
 * The namespace is the environment's, because that is what decides which one
 * the manager lists when it is asked without being told — this instance asks
 * for its own namespace and watches the directory that namespace's sockets are
 * in, so the two cannot answer about different terminals. */
export function socketDirs(env: Record<string, string | undefined> = process.env): string[] {
  const bases: string[] = [];
  const runtime = env["XDG_RUNTIME_DIR"];
  if (runtime !== undefined && runtime !== "") bases.push(join(runtime, "hyoui"));
  const state = env["XDG_STATE_HOME"];
  const home = env["HOME"];
  if (state !== undefined && state !== "") bases.push(join(state, "hyoui"));
  else if (home !== undefined && home !== "") bases.push(join(home, ".local", "state", "hyoui"));
  const namespace = env[NAMESPACE];
  return namespace === undefined || namespace === "" || namespace === DEFAULT_NAMESPACE
    ? bases
    : bases.map((base) => join(base, namespace));
}

/** What says this host's terminals may have moved: a socket appearing or
 * disappearing in one of the directories the manager binds them in.
 *
 * Both candidate directories are watched whether or not they are there now —
 * one of them typically is not, and a host that has never run the manager gets
 * its first terminal at the moment the directory itself appears, which is
 * exactly what `DirectoryWatch` watches from above for. */
export const hostTerminalWatch: TerminalWatching = (onChange, dirs = socketDirs()) => {
  // Arming a watch is itself a reason to read, and there are two of them: while
  // they are being armed the reason is held back, so a subscription that opens
  // asks the manager once rather than once per directory.
  let arming = false;
  const watches = dirs.map(
    (dir) =>
      new DirectoryWatch(dir, () => {
        if (!arming) onChange();
      }),
  );
  return {
    start: () => {
      arming = true;
      try {
        for (const watch of watches) watch.start();
      } finally {
        arming = false;
      }
      onChange();
    },
    stop: () => {
      for (const watch of watches) watch.stop();
    },
  };
};

/** The rows one listing states, in the contract's spelling.
 *
 * A line this instance cannot read is left out rather than stated as a
 * half-row: what a terminal row is for is being opened and being matched
 * against a run, and a row missing what those need is worth less than the list
 * without it. */
export function terminalsOf(instance: InstanceId, jsonl: string): TerminalInfo[] {
  const rows: TerminalInfo[] = [];
  for (const line of jsonl.split("\n")) {
    if (line.trim() === "") continue;
    let document: unknown;
    try {
      document = JSON.parse(line);
    } catch {
      continue;
    }
    const row = stated(instance, document);
    if (row !== undefined) rows.push(row);
  }
  return rows;
}

/** One line of the listing as a row, or nothing where it states no terminal.
 *
 * `state` is the manager's own word, and the one about the process the `pid`
 * names is the one that belongs beside it: what the terminal is doing is what
 * is running in it. A terminal whose child the manager says nothing about
 * falls back to what it says about the terminal itself — both are its words,
 * and the field is an open set of them (contract, `TerminalInfo`). */
function stated(instance: InstanceId, document: unknown): TerminalInfo | undefined {
  if (typeof document !== "object" || document === null) return undefined;
  const {
    session,
    status,
    child_state: childState,
    child_pid: pid,
    started_unix_ms: startedAt,
    argv: command,
    cwd,
  } = document as Record<string, unknown>;
  const id = text(session);
  const state = text(childState) ?? text(status);
  if (id === undefined || state === undefined) return undefined;
  return {
    instance,
    id: terminalId(HYOUI_TERMINAL_SCHEME, id),
    state,
    // A manager that named no argv states a terminal with nothing known to be
    // running in it, which is an empty command rather than an absent field:
    // the contract asks every row for one.
    command: argv(command),
    ...optional("cwd", text(cwd)),
    ...(typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? { pid } : {}),
    ...(typeof startedAt === "number" && Number.isFinite(startedAt)
      ? { started_at: startedAt }
      : {}),
  };
}

function argv(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((part): part is string => typeof part === "string")
    : [];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optional<K extends string, V>(key: K, value: V | undefined): Record<K, V> | object {
  return value === undefined ? {} : { [key]: value };
}

/** Whether a failure is this host having no such command, which `Bun.spawn`
 * states as the code of the error it throws. */
function missing(cause: unknown): boolean {
  return (cause as { code?: unknown } | null)?.code === "ENOENT";
}
