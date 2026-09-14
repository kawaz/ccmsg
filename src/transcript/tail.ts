import { type FSWatcher, watch } from "node:fs";
import { open, stat } from "node:fs/promises";
import { CONFIRM_POLL_MS } from "../sessions/harness.ts";
import { breathe } from "./scan.ts";

/** How much of a transcript one read takes at a time.
 *
 * The reading of a whole file is cut into reads of this size and the loop is
 * handed back between them, so following a transcript of any size costs the
 * instance a read of fixed size rather than a pause proportional to the file.
 * A megabyte is a few hundred records at the sizes the harness writes, which
 * is large enough that the turns themselves cost nothing measurable against
 * the parsing they carry. */
export const READ_CHUNK_BYTES = 1024 * 1024;

/** What the tail read, with the offsets that place it.
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
  /** What was already in the file when the tail opened, oldest first, in the
   * reads it arrived in. The input of what is folded and of what is
   * classified, not something a subscriber is sent. */
  readonly onExisting: (read: Appended) => void;
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
  ) {}

  /** The transcript's size as last observed, which is what a subscription's
   * snapshot states and where the frames after it begin. */
  get size(): number {
    return this.#size;
  }

  /** Just past the last record read, which is what a reading resumed later
   * starts from. */
  get offset(): number {
    return this.#offset;
  }

  get running(): boolean {
    return this.#watcher !== undefined || this.#timer !== undefined;
  }

  /** Read what is already there, then begin following.
   *
   * `from` is where a reading of this same file left off — nothing for a file
   * being read for the first time, which is read from its beginning. Everything
   * before the tail's own first append is therefore accounted for, whether it
   * was read now or read once before and remembered.
   *
   * This is awaited by whoever states a value derived from the file, so a
   * subscriber is told what the whole transcript says rather than what its end
   * says (CT-Q8). */
  async start(from = 0): Promise<void> {
    if (this.running) return;
    await this.#catchUp(from);
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

  /** The file as it already stands, read to the end it had when this began.
   * What is written while it runs is left to the first append, so the size a
   * subscription opens on and the first frame after it meet exactly. */
  async #catchUp(from: number): Promise<void> {
    this.#offset = from;
    this.#size = await this.#stat(from);
    await this.#consume(this.#size, this.deps.onExisting);
  }

  async #read(): Promise<void> {
    const size = await this.#stat(this.#offset);
    if (size < this.#offset) {
      // Shorter than what was already consumed: the file was replaced, so what
      // was folded out of it describes nothing, and reading resumes from its
      // beginning.
      this.#offset = 0;
      this.deps.onTruncated();
    }
    this.#size = size;
    await this.#consume(size, this.deps.onAppended);
  }

  /** Everything up to `size`, in reads of a fixed size with the loop handed
   * back between them. A record still being written ends the pass: it is left
   * for the read that finds its end. */
  async #consume(size: number, state: (read: Appended) => void): Promise<void> {
    while (this.#offset < size) {
      // A record longer than one read is taken in one piece rather than in
      // halves, so the window grows until it holds a whole one.
      let to = Math.min(this.#offset + READ_CHUNK_BYTES, size);
      let complete = whole(await this.#slice(this.#offset, to));
      while (complete.byteLength === 0 && to < size) {
        to = Math.min(to + READ_CHUNK_BYTES, size);
        complete = whole(await this.#slice(this.#offset, to));
      }
      if (complete.byteLength === 0) return;
      const start = this.#offset;
      this.#offset = start + complete.byteLength;
      state({ lines: split(complete), start, end: this.#offset, size });
      if (this.#offset < size) await breathe();
    }
  }

  async #stat(fallback: number): Promise<number> {
    try {
      return (await stat(this.path)).size;
    } catch {
      // Not there. Nothing was appended, and the poll keeps looking.
      return fallback;
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

/** The records in what was read, which begins at a record. */
function split(complete: Buffer): string[] {
  const lines: string[] = [];
  for (let from = 0; from < complete.byteLength;) {
    const newline = complete.indexOf(NEWLINE, from);
    lines.push(complete.toString("utf8", from, newline));
    from = newline + 1;
  }
  return lines;
}
