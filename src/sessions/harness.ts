import { type FSWatcher, readdirSync, readFileSync, watch } from "node:fs";
import { join } from "node:path";
import type { AgentInfo, InstanceId, Sid } from "@ccmsg/protocol";

/** The status the harness writes while a dialog is open and it is waiting for
 * an answer, alongside a `waitingFor` naming what it waits on.
 *
 * Read out of the harness binary (2.1.263): `{status:"waiting",waitingFor:…}`.
 * This is the one thing the raw status decides (§5.1 / DV-Q5) — busy and idle
 * are the gateway's to say, so no other value of it is read here. */
const WAITING = "waiting";

/** How often the confirmation poll re-reads the directory.
 *
 * `fs.watch` is the route; this is not. macOS/Bun delivers FSEvents tens of
 * seconds late under load (measured in the old daemon while many test children
 * ran), and the poll exists so a change the watch is sitting on is picked up
 * before a person notices it is missing (§5.1). Five seconds is the interval
 * the old daemon's `claude agents` poller ran at as its only route, and this
 * one replaces it as a backstop (DV-Q6), so it cannot be the slower of the
 * two. */
export const CONFIRM_POLL_MS = 5_000;

const STATE_FILE = /^\d+\.json$/;

/** The sessions the harness itself reports, read from one config home.
 *
 * The directory is the whole input: it says which sessions exist and which is
 * waiting on a dialog (§5.1). Only the config home this instance was given is
 * ever opened (M6) — the path is handed in, and nothing here searches for
 * another one.
 *
 * Two things live here, and §6.3 separates them. Reading the directory answers
 * a question, and is done whenever one is asked. Watching it says the answer
 * may have changed, which is only worth knowing while somebody is subscribed —
 * so the watch is what the subscription drives, and no answer waits on it. */
export class HarnessSessions {
  #watcher: FSWatcher | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly dir: string,
    private readonly instance: InstanceId,
    private readonly onChange: () => void,
    private readonly pollMs: number = CONFIRM_POLL_MS,
  ) {}

  get running(): boolean {
    return this.#watcher !== undefined || this.#timer !== undefined;
  }

  /** Begins watching. Called when the first subscriber arrives and not before
   * (§6.3 / §8.3: no upstream is read until somebody is listening). */
  start(): void {
    if (this.running) return;
    try {
      this.#watcher = watch(this.dir, this.onChange);
    } catch {
      // The directory does not exist yet — a config home whose harness has not
      // run. The poll below both covers the wait and picks it up when it
      // appears, so this is not a failure to start.
      this.#watcher = undefined;
    }
    this.#timer = setInterval(this.onChange, this.pollMs);
    this.onChange();
  }

  stop(): void {
    this.#watcher?.close();
    this.#watcher = undefined;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** The directory as it is at this instant.
   *
   * Every answer comes from here rather than from anything the watch left
   * behind. Which sessions exist is an input to the classification (§5.1), and
   * classifying happens inside `message_send`'s decision and inside the
   * recompute that writes `last_live` — neither of which can hand back a
   * promise without changing what it means, and neither of which may depend on
   * somebody being subscribed. The ops that signal a session's process read it
   * here too: a pid from a poll that has not run is a number belonging to
   * nobody.
   *
   * Read in place because the directory is a handful of small files of this
   * uid's own config home (M6) — a syscall or two per session, not a wait. */
  scan(): ReadonlyMap<Sid, AgentInfo> {
    const rows = new Map<Sid, AgentInfo>();
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return rows;
    }
    for (const name of names) {
      if (!STATE_FILE.test(name)) continue;
      let document: unknown;
      try {
        document = JSON.parse(readFileSync(join(this.dir, name), "utf8"));
      } catch {
        continue;
      }
      const row = toRow(document, this.dir, this.instance);
      if (row !== undefined) rows.set(row.sid, row);
    }
    return rows;
  }
}

/** Whether the harness says this session is waiting on a dialog. */
export function isWaiting(row: AgentInfo): boolean {
  return row.status === WAITING;
}

/** The conversion of one upstream document into the contract's spelling
 * (§3.5): renamed to snake_case, instants in Unix ms, and nothing carried over
 * that the contract does not name.
 *
 * A row whose process is gone is dropped: the file outlives a session that did
 * not clean up after itself, and "the session exists" is what this input is
 * for. */
function toRow(document: unknown, configDir: string, instance: InstanceId): AgentInfo | undefined {
  if (typeof document !== "object" || document === null) return undefined;
  const raw = document as Record<string, unknown>;
  const sid = text(raw["sessionId"]);
  const pid = raw["pid"];
  const cwd = text(raw["cwd"]);
  const kind = text(raw["kind"]);
  const startedAt = raw["startedAt"];
  if (sid === undefined || cwd === undefined || kind === undefined) return undefined;
  if (typeof pid !== "number" || typeof startedAt !== "number") return undefined;
  if (!alive(pid)) return undefined;
  return {
    sid,
    instance,
    pid,
    cwd,
    kind,
    started_at: startedAt,
    config_dir: configDir,
    ...optional("name", text(raw["name"])),
    ...optional("status", text(raw["status"])),
    ...optional("waiting_for", text(raw["waitingFor"])),
    ...optional("state", text(raw["state"])),
    ...optional("background_id", text(raw["backgroundId"])),
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // EPERM would mean alive but ours to signal — impossible here, since the
    // daemon and the sessions of its config home run as one uid (§2 A4).
    return false;
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optional<K extends string, V>(key: K, value: V | undefined): Record<K, V> | object {
  return value === undefined ? {} : { [key]: value };
}
