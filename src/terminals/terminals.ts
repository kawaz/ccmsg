import type { InstanceId, TerminalInfo, Timestamp } from "@ccmsg/protocol";
import { Readings } from "../sessions/index.ts";
import {
  Elements,
  TERMINAL_ROWS,
  type TopicValue,
  type UpstreamResource,
} from "../topics/index.ts";

/** How often the manager is asked for its list.
 *
 * Asking is the only route there is: a terminal manager announces nothing, and
 * what it runs in a terminal is its own affair, so there is no file to watch
 * and no event to wait on. What keeps the cost of that bounded is the
 * subscription — the poll runs while somebody is looking at the terminals and
 * not otherwise (DESIGN §6.3), so an instance nobody is watching starts no
 * children at all.
 *
 * Five seconds is the interval the harness directory's confirmation poll runs
 * at, so a terminal opening and a session appearing reach a client within the
 * same span rather than one trailing the other. */
export const TERMINAL_POLL_MS = 5_000;

/** The terminals of this host, as a terminal manager answers with them. A host
 * with no manager answers with none; a poll that failed throws, because a
 * failed reading is not a host whose terminals are gone. */
export type TerminalListing = () => Promise<readonly TerminalInfo[]>;

export interface TerminalsDeps {
  readonly self: InstanceId;
  readonly list: TerminalListing;
  readonly publish: (topic: string, data: unknown) => void;
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
  /** The poll interval, so a test does not wait one out. */
  readonly pollMs?: number;
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
  #timer: ReturnType<typeof setInterval> | undefined;
  #rows: readonly TerminalInfo[] = [];
  /** When the poll behind the rows above ran, which a frame states so a client
   * can tell a quiet list from a stale one. Absent before the first one. */
  #polledAt: Timestamp | undefined;
  /** Whether the last poll failed, so a manager that is failing is logged once
   * rather than every interval. */
  #failing = false;

  constructor(private readonly deps: TerminalsDeps) {
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
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => void this.read(), this.deps.pollMs ?? TERMINAL_POLL_MS);
    void this.read();
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Whether the poll is running, which is what "the subscription drives the
   * resource" means in practice. */
  get polling(): boolean {
    return this.#timer !== undefined;
  }

  /** What a fresh subscriber is handed: every terminal there is.
   *
   * The poll has only just been started, so the opening frame waits for a
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
   * A failed poll leaves the rows as they stand: the terminals of a host whose
   * manager did not answer are unknown, not gone, and publishing them as
   * removals would close every terminal in every client's view and open them
   * again on the next poll that works. */
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
