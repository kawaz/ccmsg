import type { Env } from "../instance/paths.ts";
import {
  type Child,
  registered,
  type SpawnInstance,
  spawnInstance,
  stop as askToStop,
  type Target,
} from "./registry.ts";

/** How long a restart waits, and how a run stops counting as a failure.
 *
 * The values are chosen rather than derived, so here is what each one is for:
 *
 * - `minMs` is the first wait. An instance that exits because its predecessor
 *   still holds the lock needs only the moment that takes, so the first retry
 *   is short enough to be invisible.
 * - `maxMs` bounds a spin. The failure this is really for is a config the
 *   instance refuses to start with (DV-Q9): it fails in milliseconds and will
 *   fail again identically until somebody edits the file, so the cap is the
 *   rate at which the supervisor is willing to say so in its log while waiting
 *   for that edit.
 * - `steadyMs` is how long a child has to stay up before its next exit is read
 *   as a new failure rather than a continuing one. It is longer than `maxMs`
 *   because a child that dies at the cap and is restarted must not have its
 *   own restart counted as recovery. */
export interface Backoff {
  readonly minMs: number;
  readonly maxMs: number;
  readonly steadyMs: number;
}

export const BACKOFF: Backoff = { minMs: 500, maxMs: 30_000, steadyMs: 60_000 };

export interface SuperviseOptions {
  readonly env?: Env;
  readonly spawn?: SpawnInstance;
  readonly backoff?: Backoff;
  /** Where the supervisor says what it did. */
  readonly log?: (line: Record<string, unknown>) => void;
}

/** The foreground supervisor: the instances the shared file lists, kept up.
 *
 * The list is read once, when this starts (DV-Q8). Changing which config homes
 * are supervised is `daemon add` / `daemon remove` followed by a restart of the
 * supervisor, which is the same "restart to apply" the instances themselves
 * have and for the same reason. */
export class Supervisor {
  readonly #env: Env;
  readonly #spawn: SpawnInstance;
  readonly #backoff: Backoff;
  readonly #log: (line: Record<string, unknown>) => void;
  readonly #targets: readonly Target[];
  readonly #children = new Map<string, Child>();
  readonly #waits = new Set<() => void>();
  #leaving = false;
  #ran: Promise<void> | undefined;

  constructor(options: SuperviseOptions = {}) {
    this.#env = options.env ?? process.env;
    this.#spawn = options.spawn ?? spawnInstance;
    this.#backoff = options.backoff ?? BACKOFF;
    this.#log = options.log ?? ((line) => process.stderr.write(`${JSON.stringify(line)}\n`));
    this.#targets = registered(this.#env);
  }

  /** The config homes this supervisor was told to keep up. */
  get targets(): readonly Target[] {
    return this.#targets;
  }

  /** Run until asked to leave. One child per config home, each restarted on its
   * own schedule: one instance failing is not a reason to disturb the others. */
  run(): Promise<void> {
    this.#ran ??= Promise.all(this.#targets.map((target) => this.#keep(target))).then(() => {
      // Nothing to return; what the caller waits for is every child having gone.
    });
    return this.#ran;
  }

  async #keep(target: Target): Promise<void> {
    let wait = this.#backoff.minMs;
    while (!this.#leaving) {
      const startedAt = Date.now();
      const child = this.#spawn(target.dir, this.#env);
      this.#children.set(target.dir, child);
      this.#log({ event: "started", dir: target.dir, pid: child.pid });
      const code = await child.exited;
      this.#children.delete(target.dir);
      if (this.#leaving) {
        this.#log({ event: "stopped", dir: target.dir, code });
        return;
      }
      // A child that stayed up is a run that ended, not a start that failed, so
      // the next attempt begins at the short wait again.
      wait = Date.now() - startedAt >= this.#backoff.steadyMs ? this.#backoff.minMs : wait;
      this.#log({ event: "restarting", dir: target.dir, code, in_ms: wait });
      await this.#pause(wait);
      wait = Math.min(wait * 2, this.#backoff.maxMs);
    }
  }

  /** Wait, unless the supervisor is asked to leave first: a pending restart is
   * not something a shutdown should have to sit through. */
  #pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#waits.delete(cancel);
        resolve();
      }, ms);
      const cancel = (): void => {
        clearTimeout(timer);
        this.#waits.delete(cancel);
        resolve();
      };
      this.#waits.add(cancel);
    });
  }

  /** Stop every child, and stop restarting them.
   *
   * Each one is asked over its own socket rather than signalled, so what runs
   * is the ordered shutdown of §8.5 — the same departure a client sees from an
   * `instance_shutdown`. A child that cannot be asked (its socket is already
   * gone, or it never got far enough to bind one) is signalled instead, because
   * the alternative is a supervisor that will not leave. */
  async stop(): Promise<void> {
    this.#leaving = true;
    for (const cancel of new Set(this.#waits)) cancel();
    await Promise.all(
      this.#targets.map(async (target) => {
        const child = this.#children.get(target.dir);
        if (child === undefined) return;
        try {
          await askToStop(target);
        } catch {
          child.kill("SIGTERM");
        }
        await child.exited;
      }),
    );
    await this.#ran;
  }
}
