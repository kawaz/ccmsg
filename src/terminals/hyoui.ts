import { HYOUI_TERMINAL_SCHEME, type InstanceId, type TerminalInfo } from "@ccmsg/protocol";
import { HYOUI_COMMAND, terminalId } from "./ids.ts";
import { run } from "../sessions/processes.ts";
import type { TerminalListing } from "./terminals.ts";

/** How the manager is asked for its whole list. One line per terminal, which is
 * what lets a line this instance cannot read be dropped on its own. */
const LIST = [HYOUI_COMMAND, "list", "--format=jsonl"];

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
