/** One bound address, and the way to give it up.
 *
 * `kind` exists for the stop order of daemon-v2 §8.5: the UDS is released after
 * everything else, because a client reads "the unix socket refuses" as the
 * instance having finished leaving, and a successor may take the resources it
 * sees freed before that. */
/** A Bun listener gets this long to settle after releasing its address. */
export const STOP_DEADLINE_MS = 250;

export interface Listener {
  readonly kind: "uds" | "ws";
  /** The socket path, or the bound `host:port` — resolved, so an ephemeral
   * port is readable here. */
  readonly address: string;
  close(): Promise<void>;
}

/** The listeners one instance holds, closed in the order §8.5 requires. */
export class Transport {
  readonly #listeners: Listener[] = [];

  add<T extends Listener>(listener: T): T {
    this.#listeners.push(listener);
    return listener;
  }

  get listeners(): readonly Listener[] {
    return this.#listeners;
  }

  /** Release every address, the unix socket last. Callers do the steps that
   * come before this one (§8.5 1-4: refuse new work, stop upstream watches,
   * tell the connections, settle what is persisted). */
  async close(): Promise<void> {
    const held = [...this.#listeners];
    this.#listeners.length = 0;
    // The order that matters is the unix socket coming last; among the rest
    // there is none, and closing them one after another would add up their
    // deadlines for no reason — two served listeners is a second of waiting
    // that nothing is waiting for.
    await Promise.all(held.filter((l) => l.kind !== "uds").map((l) => l.close()));
    for (const listener of held.filter((l) => l.kind === "uds")) await listener.close();
  }
}
