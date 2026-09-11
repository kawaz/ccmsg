import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  INBOX_MAX_PER_SID,
  INBOX_RETENTION_MS,
  type InboxMessage,
  type Sid,
  type Timestamp,
} from "@ccmsg/protocol";

export const INBOX_FILE = "inbox.jsonl";

/** One line of the file. Three verbs, all of them appends: a message arriving
 * that could not be handed over, that message reaching its session, and that
 * message being dropped to make room for a newer one.
 *
 * The alternative — rewriting the file whenever a message leaves — would make
 * every removal a whole-file write, and a daemon killed during one loses
 * messages that were neither delivered nor meant to go. Appending means the
 * only line a kill can damage is the last one, and a damaged last line is a
 * message the sender was never told was safe. */
type Record_ =
  | { readonly v: "add"; readonly sid: Sid; readonly message: InboxMessage }
  | { readonly v: "delivered"; readonly sid: Sid; readonly mid: string }
  | { readonly v: "dropped"; readonly sid: Sid; readonly mid: string };

/** What was said to a session and has not reached it.
 *
 * The one thing here that nothing else can reconstruct (§3.6): the sender's
 * `message.send` has already been answered, no transcript holds a message that
 * was never handed over, and the text lives nowhere else. Losing this file
 * loses the words.
 *
 * One file rather than one per sid. Both are append-only and both mean the same
 * thing for removal and expiry (§4.3); a single file makes the write path one
 * open handle and makes "what is undelivered right now" one replay. */
export class Inbox {
  readonly #held = new Map<Sid, InboxMessage[]>();

  constructor(private readonly file: string) {}

  /** Replay the file, drop what has expired, and write back what is left.
   *
   * The rewrite is the only whole-file write, and it happens before anything
   * can be appended: it is what keeps the file from growing by every message
   * ever delivered. A kill during it leaves the previous file, since it lands
   * through a temporary and a rename. */
  load(now: Timestamp = Date.now()): void {
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch {
      return;
    }
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      let record: Record_;
      try {
        record = JSON.parse(line) as Record_;
      } catch {
        // The last line of a file the daemon was killed while writing.
        continue;
      }
      this.#replay(record);
    }
    this.#expire(now);
    this.#compact();
  }

  /** Everything still undelivered for one session, oldest first. Expiry is
   * evaluated here rather than by a timer: a message nobody is asking about has
   * nothing to expire for (M3). */
  undelivered(sid: Sid, now: Timestamp = Date.now()): InboxMessage[] {
    this.#expire(now, sid);
    return [...(this.#held.get(sid) ?? [])];
  }

  /** Hold a message for a session that could not take it.
   *
   * Answers whether the oldest was dropped to make room, which is the whole of
   * `inbox_full`: the message is held either way, and what the sender is told
   * differs because something of theirs is now gone. */
  hold(sid: Sid, message: InboxMessage, now: Timestamp = Date.now()): { evicted: boolean } {
    this.#expire(now, sid);
    const held = this.#held.get(sid) ?? [];
    this.#held.set(sid, held);
    held.push(message);
    this.#append({ v: "add", sid, message });
    if (held.length <= INBOX_MAX_PER_SID) return { evicted: false };
    const oldest = held.shift();
    if (oldest !== undefined) this.#append({ v: "dropped", sid, mid: oldest.mid });
    return { evicted: true };
  }

  /** Note that messages reached their session, which is what takes them out of
   * the inbox (§4.3). */
  delivered(sid: Sid, mids: readonly string[]): void {
    const held = this.#held.get(sid);
    if (held === undefined || mids.length === 0) return;
    const gone = new Set(mids);
    const left = held.filter((message) => !gone.has(message.mid));
    if (left.length === 0) this.#held.delete(sid);
    else this.#held.set(sid, left);
    for (const mid of mids) this.#append({ v: "delivered", sid, mid });
  }

  /** Every session something is waiting for. What reads it is the offer of
   * §4.3: when a session becomes able to receive, what it is owed has to be
   * findable without asking about each sid in turn. */
  sids(): Sid[] {
    return [...this.#held.keys()];
  }

  /** The highest counter this instance has already issued, so a restart does
   * not hand out a `mid` that a held message already carries. */
  lastCounter(prefix: string): number {
    let highest = 0;
    for (const held of this.#held.values()) {
      for (const message of held) {
        if (!message.mid.startsWith(prefix)) continue;
        const counter = Number(message.mid.slice(prefix.length));
        if (Number.isSafeInteger(counter) && counter > highest) highest = counter;
      }
    }
    return highest;
  }

  #replay(record: Record_): void {
    if (record.v === "add") {
      const held = this.#held.get(record.sid) ?? [];
      this.#held.set(record.sid, held);
      held.push(record.message);
      return;
    }
    const held = this.#held.get(record.sid);
    if (held === undefined) return;
    const left = held.filter((message) => message.mid !== record.mid);
    if (left.length === 0) this.#held.delete(record.sid);
    else this.#held.set(record.sid, left);
  }

  /** Drop what is past the window the contract sets (DV-Q4). Nothing is
   * appended for an expiry: the same clock reaches the same verdict on the next
   * replay, so writing it down would record a conclusion rather than an event. */
  #expire(now: Timestamp, only?: Sid): void {
    for (const [sid, held] of this.#held) {
      if (only !== undefined && sid !== only) continue;
      const left = held.filter((message) => now - message.sent_at <= INBOX_RETENTION_MS);
      if (left.length === held.length) continue;
      if (left.length === 0) this.#held.delete(sid);
      else this.#held.set(sid, left);
    }
  }

  #append(record: Record_): void {
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify(record)}\n`);
  }

  #compact(): void {
    const lines: string[] = [];
    for (const [sid, held] of this.#held) {
      for (const message of held) lines.push(JSON.stringify({ v: "add", sid, message }));
    }
    if (lines.length === 0) {
      try {
        unlinkSync(this.file);
      } catch {
        // Nothing was there to begin with.
      }
      return;
    }
    const temporary = `${this.file}.${process.pid}.tmp`;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(temporary, `${lines.join("\n")}\n`);
    renameSync(temporary, this.file);
  }
}

/** Where the inbox lives for an instance whose state directory is `stateDir`
 * (§8.1: every per-instance path is derived from its config home). */
export function inboxPath(stateDir: string): string {
  return join(stateDir, INBOX_FILE);
}
