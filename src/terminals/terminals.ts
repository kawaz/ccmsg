import type { InstanceId, TerminalInfo, Timestamp } from "@ccmsg/protocol";
import { Readings } from "../sessions/index.ts";
import {
  Elements,
  TERMINAL_ROWS,
  type TopicValue,
  type UpstreamResource,
} from "../topics/index.ts";

/** The terminals of this host, as a terminal manager answers with them. A host
 * with no manager answers with none; a reading that failed throws, because a
 * failed reading is not a host whose terminals are gone. */
export type TerminalListing = () => Promise<readonly TerminalInfo[]>;

/** What says the host's terminals may have moved, while somebody is looking.
 *
 * A terminal manager announces nothing itself, but it keeps a socket per
 * terminal, so a terminal opening and a terminal closing are entries appearing
 * and disappearing in a directory — which is an event to wait on rather than a
 * question to repeat. What the manager is asked is the whole list, once per
 * event and once when the subscription opens (DESIGN §4.6). */
export type TerminalWatching = (
  onChange: () => void,
  /** The directories to watch, for a test that has its own. */
  dirs?: readonly string[],
) => {
  start(): void;
  stop(): void;
};

export interface TerminalsDeps {
  readonly self: InstanceId;
  readonly list: TerminalListing;
  readonly watch: TerminalWatching;
  readonly publish: (topic: string, data: unknown) => void;
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
}

/** The `terminals` topic: what terminals this host has, whoever opened them
 * (contract DR-0026).
 *
 * A list of its own rather than a field of a session's row, because a terminal
 * is not a session's: a person opens one with a shell in it, a harness starts
 * in one before it has written anything about itself, and the terminal outlives
 * the session that was running there. Which session is in which terminal is
 * read off the pids by the contract's own `terminalsOf` / `starting`, so
 * nothing here derives it — this states what was observed and no more.
 *
 * What a frame carries is the rows that changed, decided the same way `peers`
 * and `agents` decide it (`Elements`), so a list restated unchanged goes
 * nowhere and a terminal that was closed travels as a removal. */
export class Terminals implements UpstreamResource {
  readonly #readings: Readings<readonly TerminalInfo[] | undefined>;
  readonly #sent = new Elements(TERMINAL_ROWS);
  readonly #watch: { start(): void; stop(): void };
  #rows: readonly TerminalInfo[] = [];
  /** When the reading behind the rows above was made, which a frame states so a
   * client can tell a quiet list from a stale one. Absent before the first
   * one. */
  #polledAt: Timestamp | undefined;
  /** Whether the last reading failed, so a manager that is failing is logged
   * once rather than at every event. */
  #failing = false;

  constructor(private readonly deps: TerminalsDeps) {
    this.#watch = deps.watch(() => void this.read());
    this.#readings = new Readings(
      () => this.#list(),
      (rows) => {
        if (rows !== undefined) this.#settle(rows);
      },
    );
  }

  /** Read the list again, and settle what this states. Overlapping readings are
   * the generation's to sort out: one that was overtaken while it was in flight
   * is dropped rather than written over the newer answer (`Readings`). */
  read(): Promise<void> {
    return this.#readings.again();
  }

  start(): void {
    this.#watch.start();
  }

  stop(): void {
    this.#watch.stop();
  }

  /** What a fresh subscriber is handed: every terminal there is.
   *
   * The watch has only just been started, so the opening frame waits for a
   * reading of its own rather than stating an empty list that means something
   * else (CT-Q8). Stating the rows is also what the difference after it is
   * taken against. */
  async snapshot(): Promise<readonly TopicValue[]> {
    await this.read();
    return [
      {
        instance: this.deps.self,
        data: {
          terminals: this.#sent.stated(this.#rows),
          ...(this.#polledAt === undefined ? {} : { polled_at: this.#polledAt }),
        },
      },
    ];
  }

  /** One reading, or nothing where the manager could not be read.
   *
   * A failed reading leaves the rows as they stand: the terminals of a host
   * whose manager did not answer are unknown, not gone, and publishing them as
   * removals would close every terminal in every client's view and open them
   * again on the next reading that works. */
  async #list(): Promise<readonly TerminalInfo[] | undefined> {
    try {
      const rows = await this.deps.list();
      this.#failing = false;
      return rows;
    } catch (cause) {
      if (!this.#failing) {
        this.#failing = true;
        this.deps.log?.("the terminal manager could not be read", { error: String(cause) });
      }
      return undefined;
    }
  }

  #settle(rows: readonly TerminalInfo[]): void {
    this.#rows = rows;
    this.#polledAt = Date.now();
    const terminals = this.#sent.diff(rows);
    if (terminals.length > 0) {
      this.deps.publish("terminals", { terminals, polled_at: this.#polledAt });
    }
  }
}
