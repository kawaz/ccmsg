import type { Requester } from "../dispatch/index.ts";

/** How long one terminal's frames are gathered before they go out.
 *
 * The value bounds two things at once. Towards the reader: a person watching a
 * list cannot see a change arrive sooner than the display draws it, so frames
 * closer together than a few display frames are spent on nothing, while a wait
 * long enough to be read as lag starts around a quarter of a second. Towards
 * the cluster: a relayed frame waits once per hop, so the delay a subscriber
 * sees is this value times the hops between it and the instance that produced
 * the value — at 100 ms a two-hop cluster still answers inside the window a
 * person reads as immediate, which a longer period would leave.
 *
 * It is not a poll. Nothing is looked at when the period elapses: the timer is
 * armed only by a frame that has to wait, and an idle terminal has none. */
export const FLUSH_PERIOD_MS = 100;

/** How many frames that cannot be folded one terminal may hold at once.
 *
 * Folded frames need no bound — a topic that replaces its value keeps one entry
 * however often it is stated — so this bounds the occurrences and the deltas,
 * the frames that mean something twice if they arrive twice. At one flush every
 * `FLUSH_PERIOD_MS` a terminal that keeps up drains this many every period, so
 * reaching the limit means the producer has been outrunning the reader by more
 * than 2500 frames a second for as long as the queue has stood: past anything a
 * person, a session or a peer produces, and into the storm this layer exists
 * for. What is over the limit is refused rather than dropped quietly, so the op
 * that raised it is the one that hears about it. */
export const QUEUE_LIMIT = 256;

/** The two things the queue asks of time, so a test can hold both still.
 *
 * `schedule` answers with the way to cancel what it armed, because a terminal
 * that goes away while a flush is pending has to leave nothing behind. */
export interface EgressClock {
  now(): number;
  schedule(afterMs: number, run: () => void): () => void;
}

const REAL_CLOCK: EgressClock = {
  now: () => Date.now(),
  schedule: (afterMs, run) => {
    const timer = setTimeout(run, afterMs);
    return () => {
      clearTimeout(timer);
    };
  },
};

/** What a caller may move: the period, the limit, and the clock both are read
 * against. */
export interface EgressOptions {
  readonly periodMs?: number;
  readonly limit?: number;
  readonly clock?: EgressClock;
}

interface Pending {
  /** The key this frame folds on, absent for one that does not fold. */
  readonly fold?: string;
  frame: object;
}

/** One terminal's outgoing frames, gathered and let go on a period.
 *
 * A terminal is a person's connection, a mesh peer or a CLI subscriber, and
 * this is the same layer for all three: what differs between them is the socket
 * underneath, not how fast a subscriber can be written to.
 *
 * Three things happen here, and the topic's own granularity decides which. A
 * frame that replaces the value it carries folds onto the one already waiting
 * under the same key, so a value stated a thousand times between two flushes
 * leaves one frame and it is the latest — the reader is never handed a value
 * that has already been superseded, and never misses the last one. A frame that
 * is an occurrence or a delta cannot fold, so it queues in the order it was
 * raised and the queue is bounded: past the bound the frame is refused, which is
 * how the pressure reaches whoever is producing it instead of accumulating
 * here. Both leave together on the flush, in the order they were queued.
 *
 * The first frame after a quiet spell goes out at once: the period bounds how
 * often a flush happens, not how long a lone change waits. */
export class Egress {
  #queue: Pending[] = [];
  /** The waiting frame per fold key, so a restatement finds its own entry
   * rather than being appended behind it. */
  readonly #folded = new Map<string, Pending>();
  /** How many waiting frames do not fold, which is what the limit counts. */
  #kept = 0;
  #lastFlush = Number.NEGATIVE_INFINITY;
  #cancel: (() => void) | undefined;

  readonly #periodMs: number;
  readonly #limit: number;
  readonly #clock: EgressClock;

  constructor(
    private readonly conn: Requester,
    options: EgressOptions = {},
  ) {
    this.#periodMs = options.periodMs ?? FLUSH_PERIOD_MS;
    this.#limit = options.limit ?? QUEUE_LIMIT;
    this.#clock = options.clock ?? REAL_CLOCK;
  }

  /** Take one frame for this terminal. `fold` is the key it replaces itself
   * under, absent for a frame that has to be sent as often as it is raised.
   *
   * `false` is the queue refusing the frame: it is full of frames that cannot
   * be folded, and the caller is the one that can answer for it. */
  push(frame: object, fold?: string): boolean {
    if (fold === undefined) {
      if (this.#kept >= this.#limit) return false;
      this.#kept += 1;
      this.#queue.push({ frame });
    } else {
      const held = this.#folded.get(fold);
      if (held !== undefined) {
        // In place: the value moves, its position among the occurrences around
        // it does not.
        held.frame = frame;
        this.#arm();
        return true;
      }
      const entry: Pending = { fold, frame };
      this.#queue.push(entry);
      this.#folded.set(fold, entry);
    }
    this.#arm();
    return true;
  }

  /** Send everything waiting, in the order it was queued. */
  flush(): void {
    this.#cancel?.();
    this.#cancel = undefined;
    this.#lastFlush = this.#clock.now();
    const queue = this.#queue;
    this.#queue = [];
    this.#folded.clear();
    this.#kept = 0;
    for (const entry of queue) this.conn.send(entry.frame);
  }

  /** The terminal is done with: what was queued goes out, and nothing armed
   * outlives it. */
  release(): void {
    this.flush();
  }

  #arm(): void {
    if (this.#cancel !== undefined) return;
    const wait = this.#periodMs - (this.#clock.now() - this.#lastFlush);
    if (wait <= 0) {
      this.flush();
      return;
    }
    this.#cancel = this.#clock.schedule(wait, () => {
      this.#cancel = undefined;
      this.flush();
    });
  }
}
