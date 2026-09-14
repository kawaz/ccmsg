import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  INBOX_MAX_PER_SID,
  INBOX_RETENTION_MS,
  InboxMessage,
  type InboxRemovedReason,
  isValid,
  Sid,
  type Timestamp,
  validationErrors,
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
 * The one thing here that nothing else can reconstruct (DESIGN §2.5): the sender's
 * `message.send` has already been answered, no transcript holds a message that
 * was never handed over, and the text lives nowhere else. Losing this file
 * loses the words.
 *
 * One file rather than one per sid. Both are append-only and both mean the same
 * thing for removal and expiry (DESIGN §6.7); a single file makes the write path one
 * open handle and makes "what is undelivered right now" one replay. */
export class Inbox {
  readonly #held = new Map<Sid, InboxMessage[]>();

  /** The appends already asked for, as one chain. */
  #written: Promise<void> = Promise.resolve();

  /** Told whenever a message leaves, and why. Every way out passes through
   * here — handed over, timed out, dropped for a newer one — so whoever states
   * removals on the topic has one place to hear about them rather than a
   * reading of its own per way (DESIGN §6.7). Absent until somebody asks: a
   * replay at startup reaches conclusions about a file, with nobody yet
   * subscribed for them to be news to. */
  #onRemoved?: (mid: string, reason: InboxRemovedReason) => void;

  constructor(
    private readonly file: string,
    /** Where a line the replay could not keep is named. Absent in the tests
     * that are about the holding rather than about what is said of it. */
    private readonly log: (message: string, fields: Record<string, unknown>) => void = () => {},
  ) {}

  /** Hear about messages leaving. */
  onRemoved(told: (mid: string, reason: InboxRemovedReason) => void): void {
    this.#onRemoved = told;
  }

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
      if (record.v === "add" && !this.#stateable(record.sid, record.message)) continue;
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
  async hold(
    sid: Sid,
    message: InboxMessage,
    now: Timestamp = Date.now(),
  ): Promise<{ evicted: boolean }> {
    this.#expire(now, sid);
    const held = this.#held.get(sid) ?? [];
    this.#held.set(sid, held);
    held.push(message);
    // Awaited rather than left to land: what the sender is told is that the
    // message is held, and it is not held until the line is on disk.
    await this.#append({ v: "add", sid, message });
    // What is over the limit is what the session holds now, not what it held
    // when the line was written: a delivery or an expiry for this session
    // leaves a different list in its place while the append is in flight, and
    // deciding against the list from before would drop a message out of one
    // nobody is holding and tell a watcher a delivered message was dropped.
    const standing = this.#held.get(sid) ?? [];
    if (standing.length <= INBOX_MAX_PER_SID) return { evicted: false };
    const oldest = standing.shift();
    if (oldest !== undefined) {
      await this.#append({ v: "dropped", sid, mid: oldest.mid });
      this.#onRemoved?.(oldest.mid, "dropped");
    }
    return { evicted: true };
  }

  /** Note that messages reached their session, which is what takes them out of
   * the inbox (DESIGN §6.7). */
  async delivered(sid: Sid, mids: readonly string[]): Promise<void> {
    const held = this.#held.get(sid);
    if (held === undefined || mids.length === 0) return;
    const gone = new Set(mids);
    const left = held.filter((message) => !gone.has(message.mid));
    if (left.length === 0) this.#held.delete(sid);
    else this.#held.set(sid, left);
    const written: Promise<void>[] = [];
    for (const mid of mids) {
      written.push(this.#append({ v: "delivered", sid, mid }));
      this.#onRemoved?.(mid, "delivered");
    }
    await Promise.all(written);
  }

  /** Settle once every line asked for so far is on disk. */
  async flush(): Promise<void> {
    await this.#written;
  }

  /** Every session something is waiting for. What reads it is the offer of
   * DESIGN §6.7: when a session becomes able to receive, what it is owed has to be
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

  /** Whether a line read back is a message the contract can state.
   *
   * The file outlives the contract that wrote it, and what is held is answered
   * to a person as rows of the `inbox` topic — so a single line the contract
   * has since outgrown, replayed as if it were current, is a frame the reader
   * refuses and a whole view lost for it. An instance states only what the
   * contract can say, about its own file as much as about anything else.
   *
   * Dropped rather than mended: the message is the sender's words and the
   * contract is what says how they are spelled, so there is nothing here that
   * could write a spelling the contract would accept without inventing it. It
   * leaves through the compaction that follows the replay, which writes back
   * only what is held; nothing is appended and no removal is stated, since a
   * replay has nobody subscribed to hear one and no `mid` the contract would
   * take to name it by. */
  #stateable(sid: unknown, message: unknown): boolean {
    const why = isValid(Sid, sid)
      ? validationErrors(InboxMessage, message)
      : [`sid: ${JSON.stringify(sid)} is no session id`];
    if (why.length === 0) return true;
    this.log("dropped an inbox record the contract cannot state", { sid, why });
    return false;
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

  /** Drop what is past the window the contract sets (DR-0008). Nothing is
   * appended for an expiry: the same clock reaches the same verdict on the next
   * replay, so writing it down would record a conclusion rather than an event. */
  #expire(now: Timestamp, only?: Sid): void {
    for (const [sid, held] of this.#held) {
      if (only !== undefined && sid !== only) continue;
      const left = held.filter((message) => now - message.sent_at <= INBOX_RETENTION_MS);
      if (left.length === held.length) continue;
      const gone = new Set(left.map((message) => message.mid));
      if (left.length === 0) this.#held.delete(sid);
      else this.#held.set(sid, left);
      for (const message of held) {
        if (!gone.has(message.mid)) this.#onRemoved?.(message.mid, "expired");
      }
    }
  }

  /** One line, behind the lines asked for before it.
   *
   * A message arriving is an ordinary event of a running instance, so the
   * append does not hold the instance still while it lands (DR-0015). The
   * chain is what keeps the file in the order the verbs happened: a delivery
   * written before the add it answers would replay as a message nobody was
   * ever holding. */
  #append(record: Record_): Promise<void> {
    const written = this.#written.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      await appendFile(this.file, `${JSON.stringify(record)}\n`);
    });
    // The chain carries the order, not the outcome: a line that could not be
    // written is answered to whoever asked for it, and the ones behind it still
    // go.
    this.#written = written.catch(() => {});
    return written;
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
 * (DESIGN §8.1: every per-instance path is derived from its config home). */
export function inboxPath(stateDir: string): string {
  return join(stateDir, INBOX_FILE);
}
