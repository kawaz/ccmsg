import { closeSync, type FSWatcher, openSync, readSync, statSync, watch } from "node:fs";
import { open, stat } from "node:fs/promises";
import { CONFIRM_POLL_MS } from "../sessions/harness.ts";

/** How much of an existing transcript is read when a tail starts.
 *
 * The fold's two values both describe the present — the error the latest turn
 * ended on, and the last time a person spoke — so what a tail needs on opening
 * is the recent end of the file, not its history. A megabyte is a few hundred
 * records at the sizes the harness writes, which reaches back past the current
 * turn by a wide margin while costing one read of fixed size however large the
 * file has grown (DESIGN §2.3: a transcript of any size is read from its end).
 *
 * A person who has not spoken within it is reported as having no known input
 * rather than as having spoken long ago, which is what the contract's absent
 * `last_user_input_at` already means. */
export const FOLD_TAIL_BYTES = 1024 * 1024;

/** What the tail found appended, with the offsets that place it.
 *
 * The offsets are the ones a transcript read pages by, so what arrives live
 * and what was read stitch together without reading anything twice. `end` is
 * past the last complete line, which is not `size` when a record is still
 * being written. */
export interface Appended {
  readonly lines: readonly string[];
  readonly start: number;
  readonly end: number;
  readonly size: number;
}

export interface TailDeps {
  /** Complete lines only; a record still being written waits for its end. */
  readonly onAppended: (appended: Appended) => void;
  /** The end of the file as it stood when the tail opened, oldest first, with
   * the offsets that place it. The seed of what is folded and of what is
   * classified, not something a subscriber is sent. */
  readonly onSeed: (seeded: Appended) => void;
  /** The file is not the one the tail was reading: it shrank, so what was
   * folded out of the old contents no longer describes it. */
  readonly onTruncated: () => void;
  readonly pollMs?: number;
}

/** One transcript file, followed while somebody wants it (DESIGN §6.3).
 *
 * Watch plus a low-rate confirmation poll, for the reason and at the interval
 * the sessions directory uses (DESIGN §4.2): the watch is the route and the poll is
 * the backstop for what a delayed FSEvents queue is still sitting on. The
 * interval is shared rather than chosen again, so the two watches cannot
 * drift into two different answers to the same question. */
export class TranscriptTail {
  #watcher: FSWatcher | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #reading: Promise<void> = Promise.resolve();
  /** Just past the last complete line consumed. A record still being written
   * leaves the offset before it, so the next read takes it whole rather than
   * having to hold half of it — which also keeps a character split across two
   * writes from being decoded in halves. */
  #offset = 0;
  #size = 0;

  constructor(
    private readonly path: string,
    private readonly deps: TailDeps,
  ) {
    // Where the file ends, read before anything can ask. A subscription's
    // snapshot states this and is answered in the same turn the tail is
    // created, so a size that only the awaited seed had filled in would be
    // reported as zero and every byte already written would look appended.
    // Reading it here also fixes what the seed reads: the seed takes this size
    // rather than stating a newer one, so nothing lands between the size the
    // subscriber was given and the first frame it is sent.
    this.#size = sizeNow(path);
    this.#offset = this.#size;
  }

  /** The transcript's size as last observed, which is what a subscription's
   * snapshot states and where the frames after it begin. */
  get size(): number {
    return this.#size;
  }

  get running(): boolean {
    return this.#watcher !== undefined || this.#timer !== undefined;
  }

  /** Begin following, seeding the fold from the end of what is already there.
   *
   * The seed is read before this returns rather than awaited, for the reason
   * the size is read in the constructor: a subscription's snapshot is answered
   * in the same turn the tail is started, and what the seed settles — the
   * fold's values, and the items a subscriber opens on — would otherwise be
   * stated as empty and the whole existing end of the file would arrive later
   * as though it had just been appended. */
  async start(): Promise<void> {
    if (this.running) return;
    this.#seed();
    try {
      this.#watcher = watch(this.path, () => void this.refresh());
    } catch {
      // The file does not exist yet — a session that has not been written to.
      // The poll covers the wait and picks it up when it appears.
      this.#watcher = undefined;
    }
    this.#timer = setInterval(() => void this.refresh(), this.deps.pollMs ?? CONFIRM_POLL_MS);
  }

  stop(): void {
    this.#watcher?.close();
    this.#watcher = undefined;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Read what has been appended since the last read. Reads are chained rather
   * than overlapped, so a watch event and a poll arriving together cannot
   * interleave their reads of the same file. */
  refresh(): Promise<void> {
    this.#reading = this.#reading.then(() => this.#read());
    return this.#reading;
  }

  #seed(): void {
    const size = this.#size;
    if (size === 0) return;
    const from = Math.max(0, size - FOLD_TAIL_BYTES);
    const complete = whole(this.#sliceSync(from, size));
    this.#offset = from + complete.byteLength;
    // The first line is half a record whenever the read began mid-file, so it
    // is dropped: what is read are whole records or nothing.
    const at = from === 0 ? 0 : complete.indexOf(NEWLINE) + 1;
    this.deps.onSeed({ lines: split(complete, at), start: from + at, end: this.#offset, size });
  }

  async #read(): Promise<void> {
    const size = await this.#stat();
    if (size < this.#offset) {
      // Shorter than what was already consumed: the file was replaced, so what
      // was folded out of it describes nothing, and reading resumes from its
      // beginning.
      this.#offset = 0;
      this.deps.onTruncated();
    }
    this.#size = size;
    if (size === this.#offset) return;
    const complete = whole(await this.#slice(this.#offset, size));
    if (complete.byteLength === 0) return;
    const start = this.#offset;
    const end = start + complete.byteLength;
    this.#offset = end;
    this.deps.onAppended({ lines: split(complete, 0), start, end, size });
  }

  async #stat(): Promise<number> {
    try {
      return (await stat(this.path)).size;
    } catch {
      // Not there. Nothing was appended, and the poll keeps looking.
      return this.#offset;
    }
  }

  /** The bytes in a range. A range that reads short — the file was truncated
   * between the stat and the read — yields what was actually there.
   *
   * Bytes rather than text, because the offsets that place what is read are
   * found in them: a slice that begins part-way into a file lands wherever the
   * arithmetic puts it, inside a character as readily as before one, and
   * decoding first would turn those bytes into a replacement character of a
   * different length and move every offset derived from it. */
  /** The same range, read without yielding, which is what the seed is read
   * through: the turn that starts a tail is the turn that answers a
   * subscription, and it has to hold the end of the file by then. Bounded by
   * `FOLD_TAIL_BYTES` however large the transcript is. */
  #sliceSync(from: number, to: number): Buffer {
    if (to <= from) return Buffer.alloc(0);
    let handle: number;
    try {
      handle = openSync(this.path, "r");
    } catch {
      return Buffer.alloc(0);
    }
    try {
      const buffer = Buffer.alloc(to - from);
      return buffer.subarray(0, readSync(handle, buffer, 0, buffer.length, from));
    } finally {
      closeSync(handle);
    }
  }

  async #slice(from: number, to: number): Promise<Buffer> {
    if (to <= from) return Buffer.alloc(0);
    const handle = await open(this.path, "r").catch(() => undefined);
    if (handle === undefined) return Buffer.alloc(0);
    try {
      const buffer = Buffer.alloc(to - from);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, from);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }
}

const NEWLINE = 0x0a;

/** What of a read is whole records: everything up to and including the last
 * newline. A transcript ends every record with one, so what follows the last
 * is a record the writer has not finished. */
function whole(bytes: Buffer): Buffer {
  const last = bytes.lastIndexOf(NEWLINE);
  return last < 0 ? Buffer.alloc(0) : bytes.subarray(0, last + 1);
}

/** The records in what was read, from a byte that begins one. */
function split(complete: Buffer, at: number): string[] {
  const lines: string[] = [];
  for (let from = at; from < complete.byteLength;) {
    const newline = complete.indexOf(NEWLINE, from);
    lines.push(complete.toString("utf8", from, newline));
    from = newline + 1;
  }
  return lines;
}

/** How large the file is right now, or zero for one that is not there yet.
 * Synchronous because the value is wanted before the first await. */
function sizeNow(path: string): number {
  return statSync(path, { throwIfNoEntry: false })?.size ?? 0;
}
