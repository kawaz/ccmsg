import type { InstanceId, Sid, TerminalId } from "@ccmsg/protocol";

/** One row of a topic whose elements are matched by a name of their own, as the
 * mechanism reads it: the instance it belongs to, whichever of the names
 * matches it, and whether it is a departure. Everything else on the row belongs
 * to whoever stated it.
 *
 * Every name is optional here because each topic is matched by a different one
 * — `peers` by the session, `agents` by the process, `terminals` by the
 * terminal — and which applies is the kind below rather than anything read off
 * the row. */
export interface ElementRow {
  readonly sid?: Sid;
  readonly pid?: number;
  readonly id?: TerminalId;
  readonly instance: InstanceId;
  readonly removed?: true;
}

/** How one topic's rows are matched and how a departure of one is written.
 *
 * A row is matched by its instance and one name of its own: one session lives
 * on one instance, one process runs on one host and one terminal is opened on
 * one host, so either pair is what makes two hosts' rows tellable apart under
 * one topic name. Which name it is belongs to the topic — `peers` is a list of
 * sessions and `agents` a list of processes, and two processes may be running
 * one session (contract, `AgentInfo`). */
export interface ElementKind {
  /** The key this row is matched by, or nothing for something that is not a
   * row of this topic at all. */
  key(row: ElementRow): string | undefined;
  /** The departure of this row, which is a marked element rather than an
   * absence: a frame carries only what changed and an absence in it says
   * nothing (contract, `PeerRemoved`). */
  removal(row: ElementRow): ElementRow;
}

/** `peers`: one row per session (contract, `PeerInfo`). */
export const PEER_ROWS: ElementKind = {
  key: (row) => (typeof row.sid === "string" ? `${row.instance} ${row.sid}` : undefined),
  removal: (row) => ({ sid: row.sid, instance: row.instance, removed: true }),
};

/** `agents`: one row per process, which is why a removal names the pid and not
 * the session — the session may well still be there, with another process
 * running it (contract, `AgentRemoved`). */
export const AGENT_ROWS: ElementKind = {
  key: (row) => (typeof row.pid === "number" ? `${row.instance} ${row.pid}` : undefined),
  removal: (row) => ({ pid: row.pid, instance: row.instance, removed: true }),
};

/** `terminals`: one row per terminal, matched by the id its manager gave it
 * (contract, `TerminalInfo`). Not by the pid the row also carries: a terminal
 * whose command has exited still exists, and the same terminal goes on being
 * the same row when what runs inside it is replaced. */
export const TERMINAL_ROWS: ElementKind = {
  key: (row) => (typeof row.id === "string" ? `${row.instance} ${row.id}` : undefined),
  removal: (row) => ({ id: row.id, instance: row.instance, removed: true }),
};

/** The rows of one topic, and the one question a frame of them asks: what
 * would this tell a subscriber that it does not already hold.
 *
 * The same question suppression asks of a whole value, asked of one element
 * (M5). It lives here, beside the mechanism's own, so that "is this new" has
 * one answer for every topic rather than one per producer — and it is answered
 * the same way: against the form stored when the row was last accounted for,
 * so what is compared is exactly what a subscriber received.
 *
 * What matches one row against another is the topic's own, handed in as the
 * kind: `peers` is matched by the session and `agents` by the process. */
export class Elements {
  /** Per key, the row as it stands and the form it was stored as. */
  readonly #held = new Map<string, { row: ElementRow; wire: string }>();

  constructor(private readonly kind: ElementKind = PEER_ROWS) {}

  /** Every row held, which is what an opening frame of the topic carries. */
  rows(): ElementRow[] {
    return [...this.#held.values()].map((held) => held.row);
  }

  /** The whole list restated: the rows that differ from what is held, and a
   * removal for each row the list no longer has. What is returned is taken as
   * sent — a caller that states it is by definition what the subscriber will
   * hold next. */
  diff(rows: readonly ElementRow[]): ElementRow[] {
    const changed: ElementRow[] = [];
    const present = new Set<string>();
    for (const row of rows) {
      const key = this.kind.key(row);
      if (key === undefined) continue;
      present.add(key);
      const wire = JSON.stringify(row);
      if (this.#held.get(key)?.wire === wire) continue;
      this.#held.set(key, { row, wire });
      changed.push(row);
    }
    const gone: { key: string; row: ElementRow }[] = [];
    for (const [key, held] of this.#held) {
      if (!present.has(key)) gone.push({ key, row: held.row });
    }
    for (const { key, row } of gone) {
      this.#held.delete(key);
      changed.push(this.kind.removal(row));
    }
    return changed;
  }

  /** One row restated: the row itself when it differs from what is held, and
   * nothing when it does not.
   *
   * What a producer that knows *which* row moved says, instead of handing the
   * whole list over to be compared. The rows it does not name are left as they
   * are — which is the same thing a frame of elements does to the value a
   * subscriber holds. */
  diffRow(row: ElementRow): ElementRow[] {
    const key = this.kind.key(row);
    if (key === undefined) return [];
    const wire = JSON.stringify(row);
    if (this.#held.get(key)?.wire === wire) return [];
    this.#held.set(key, { row, wire });
    return [row];
  }

  /** Take these rows as stated: what an opening frame carries is what its
   * subscriber now holds, so the difference after it is taken against them.
   *
   * Without this a row that has only ever travelled in a snapshot would be a
   * row no later frame can say anything about — it is not in the list of what
   * was sent, so its removal would compare against nothing and never go out,
   * leaving the subscriber holding a session that is gone. */
  stated(rows: readonly ElementRow[]): readonly ElementRow[] {
    this.#held.clear();
    for (const row of rows) {
      const key = this.kind.key(row);
      if (key !== undefined) this.#held.set(key, { row, wire: JSON.stringify(row) });
    }
    return rows;
  }

  /** A frame's worth of changes folded in, answering with the part of it that
   * said something. A row equal to the one held, or a removal of a row that is
   * not there, tells a subscriber nothing and goes no further. */
  merge(elements: readonly ElementRow[]): ElementRow[] {
    const news: ElementRow[] = [];
    for (const element of elements) {
      if (typeof element?.instance !== "string") continue;
      const key = this.kind.key(element);
      if (key === undefined) continue;
      if (element.removed === true) {
        if (this.#held.delete(key)) news.push(element);
        continue;
      }
      const wire = JSON.stringify(element);
      if (this.#held.get(key)?.wire === wire) continue;
      this.#held.set(key, { row: element, wire });
      news.push(element);
    }
    return news;
  }
}
