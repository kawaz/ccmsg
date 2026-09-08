/** Newline-delimited JSON, in one place for both transports (daemon-v2 §3.1).
 *
 * The limit and the backpressure handling live here rather than in the UDS and
 * WS listeners, so the two cannot drift into two framings. */

/** The largest line this instance accepts, in bytes.
 *
 * Basis: the messaging socket Claude Code itself speaks on the same host caps a
 * line at 1,048,576 characters (measured 2026-09-08 against Claude Code
 * 2.1.263), so a client that already lives inside that budget cannot be cut off
 * by ours. The contract states no limit of its own and the previous daemon had
 * none, so this is a chosen ceiling, not a contract value: nothing above
 * transport may assume a frame is small. */
export const MAX_LINE_BYTES = 1_048_576;

const NEWLINE = 0x0a;

export interface LineReaderSink {
  /** One complete, non-empty line, decoded as UTF-8. */
  line(text: string): void;
  /** A line that reached `MAX_LINE_BYTES` before its newline. The bytes are
   * dropped and reading resumes at the next newline, so one oversized line
   * costs that line and not the connection. */
  overflow(bytes: number): void;
}

/** Accumulates bytes and hands out whole lines.
 *
 * Bytes are split before they are decoded, so a multi-byte character straddling
 * two chunks is decoded once, whole, at the line boundary. */
export class LineReader {
  #buffer = new Uint8Array(0);
  /** Set after an overflow: bytes are discarded up to the next newline. */
  #discarding = false;
  #discarded = 0;
  readonly #decoder = new TextDecoder();

  constructor(private readonly sink: LineReaderSink) {}

  push(chunk: Uint8Array): void {
    let rest = chunk;
    while (rest.length > 0) {
      if (this.#discarding) {
        const at = rest.indexOf(NEWLINE);
        if (at < 0) {
          this.#discarded += rest.length;
          return;
        }
        this.#discarding = false;
        this.sink.overflow(this.#discarded + at);
        this.#discarded = 0;
        rest = rest.subarray(at + 1);
        continue;
      }
      const at = rest.indexOf(NEWLINE);
      if (at < 0) {
        this.#append(rest);
        if (this.#buffer.length > MAX_LINE_BYTES) this.#startDiscarding();
        return;
      }
      this.#append(rest.subarray(0, at));
      rest = rest.subarray(at + 1);
      if (this.#buffer.length > MAX_LINE_BYTES) {
        this.sink.overflow(this.#buffer.length);
        this.#buffer = new Uint8Array(0);
        continue;
      }
      const text = this.#decoder.decode(this.#buffer);
      this.#buffer = new Uint8Array(0);
      if (text.trim() !== "") this.sink.line(text);
    }
  }

  #startDiscarding(): void {
    this.#discarding = true;
    this.#discarded = this.#buffer.length;
    this.#buffer = new Uint8Array(0);
  }

  #append(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    const grown = new Uint8Array(this.#buffer.length + bytes.length);
    grown.set(this.#buffer);
    grown.set(bytes, this.#buffer.length);
    this.#buffer = grown;
  }
}

/** How one transport hands a line to its socket.
 *
 * `write` returns what the socket would not take: `undefined` when the whole
 * chunk went. This is the one shape both backpressure behaviours fit — a UDS
 * `write` returns a short count and leaves the tail to us, a WS `send` either
 * buffers the whole message itself or drops it whole. */
export interface ChunkSink<T> {
  encode(line: string): T;
  write(chunk: T): T | undefined;
  /** Nudge the socket to push what it accepted, where that is a separate step. */
  flush?(): void;
}

/** Lines waiting for a socket that is not taking them yet.
 *
 * Every line goes through the queue, including the ones that are written
 * immediately, so a line queued behind a blocked one can never overtake it. */
export class WriteQueue<T> {
  readonly #pending: T[] = [];

  constructor(private readonly sink: ChunkSink<T>) {}

  push(line: string): void {
    this.#pending.push(this.sink.encode(line));
    this.drain();
  }

  /** Write what the socket will take. Called on every push and again whenever
   * the socket reports it has room. */
  drain(): void {
    while (this.#pending.length > 0) {
      const chunk = this.#pending[0] as T;
      let remainder: T | undefined;
      try {
        remainder = this.sink.write(chunk);
      } catch {
        // The socket is going away mid-write; delivery is best-effort.
        this.#pending.length = 0;
        return;
      }
      if (remainder !== undefined) {
        // Still blocked: keep the unsent part at the front and wait to be
        // drained again rather than spinning on a full socket buffer.
        this.#pending[0] = remainder;
        break;
      }
      this.#pending.shift();
    }
    this.sink.flush?.();
  }
}
