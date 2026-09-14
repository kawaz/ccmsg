import { readdirSync, readFileSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  KvDeleteArgs,
  KvDeleteResult,
  InstanceId,
  KvEntry,
  KvReadArgs,
  KvReadResult,
  KvWriteArgs,
  KvWriteResult,
  Timestamp,
} from "@ccmsg/protocol";
import { type HandlerInput, OpError, type Requester } from "../dispatch/index.ts";
import { topicParam, type TopicValue, type UpstreamResource } from "../topics/index.ts";
import { expired, type Held } from "./merge.ts";

export const KV_DIR = "kv";

/** The values clients keep here, and the topic that shows them changing.
 *
 * Written down, unlike almost everything else this instance holds (DESIGN §2.5): a
 * value here was typed by a person and exists nowhere else — the theme a
 * browser is showing is a copy of it, not its source — so losing it on a
 * restart loses what they set. It is not a derived value, which is what M4
 * forbids persisting.
 *
 * One file per namespace, whole-file: a namespace holds a handful of small
 * values, and the whole of it is what both a snapshot and a reload state. The
 * write lands through a temporary and a rename, so a kill leaves either the
 * previous namespace or the new one.
 *
 * The files are read here, as the store is built — before this instance is
 * accepting anything, so nobody is waiting on the read (DR-0015). Reading them
 * when a namespace was first asked about would put the read inside the turn
 * that answers a `kv.read` or opens a `kv:<ns>` subscription, and a snapshot is
 * answered from what is held rather than from a promise. A namespace with no
 * file starts empty, which is the same thing a namespace written for the first
 * time after this starts from. */
export class KvStore implements UpstreamResource {
  readonly #namespaces = new Map<string, Map<string, Held>>();

  /** Per namespace, the writes already asked for, as one chain. */
  readonly #writing = new Map<string, Promise<void>>();

  constructor(
    private readonly dir: string,
    private readonly self: InstanceId,
    private readonly publish: (topic: string, data: unknown) => void,
  ) {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      // No directory yet, which is an instance nobody has written a value to.
      return;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      this.#namespaces.set(name.slice(0, -".json".length), read(join(this.dir, name)));
    }
  }

  read(args: KvReadArgs): KvReadResult {
    const held = this.#load(args.ns).get(args.key);
    // A removal that is still remembered is a key the namespace does not hold.
    if (held === undefined || held.deleted === true) {
      throw new OpError("not_found", `${args.ns} holds no ${args.key}`);
    }
    return { value: held.value, updated_at: held.updated_at };
  }

  /** Writes one value, unless what the key holds is newer.
   *
   * The instant decides, not the order of arrival: a caller states when the
   * write it is reporting happened, and one that happened while this instance
   * was unreachable must not displace what was written since. The answer is
   * what the key carries now — equal to what the caller stated when its write
   * stands, and later than it when an existing value did. */
  async write(args: KvWriteArgs, now: Timestamp = Date.now()): Promise<KvWriteResult> {
    const entries = this.#load(args.ns);
    const updatedAt = args.updated_at ?? now;
    const held = entries.get(args.key);
    // Older than what the key holds, so it does not displace it. A write that
    // arrived at the same instant does stand: two calls a millisecond apart
    // are not a disagreement between instances, and the second is the newer.
    if (held !== undefined && held.updated_at > updatedAt) {
      return { updated_at: held.updated_at };
    }
    entries.set(args.key, { value: args.value, updated_at: updatedAt });
    // Told to the subscribers once it is written down, so nobody is holding a
    // value this instance would not have after a restart.
    await this.#persist(args.ns, entries);
    this.publish(`kv:${args.ns}`, {
      entries: [{ key: args.key, value: args.value, updated_at: updatedAt }],
    });
    return { updated_at: updatedAt };
  }

  /** A key that was not there is no error: the caller wanted the namespace
   * without it, and it is. The removal is still announced, because a subscriber
   * that has the entry has to be told it is gone. */
  async delete(args: KvDeleteArgs, now: Timestamp = Date.now()): Promise<KvDeleteResult> {
    const entries = this.#load(args.ns);
    const before = entries.get(args.key);
    // A removal older than what the key holds undoes nothing, which is the
    // same rule a write is held to.
    if (before !== undefined && before.updated_at > now) return {};
    entries.set(args.key, { updated_at: now, deleted: true });
    await this.#persist(args.ns, entries);
    // A removal is announced only when something was there to remove: a
    // subscriber holding no entry has nothing to be told is gone.
    if (before !== undefined && before.deleted !== true) {
      this.publish(`kv:${args.ns}`, {
        entries: [{ key: args.key, updated_at: now, deleted: true }],
      });
    }
    return {};
  }

  /** Nothing to start or stop: the values are here whether anyone is watching
   * or not, and the files they live in were read as this was built. */
  start(): void {}
  stop(): void {}

  /** Every entry the namespace holds. A snapshot never carries a removal, since
   * what is not there is simply absent from a whole list. */
  snapshot(topic: string, _conn: Requester): readonly TopicValue[] {
    const ns = topicParam(topic);
    if (ns === undefined) return [];
    const entries: KvEntry[] = [...this.#load(ns)]
      .filter(([, held]) => held.deleted !== true)
      .map(([key, held]) => ({ key, value: held.value, updated_at: held.updated_at }));
    return [{ instance: this.self, data: { entries } }];
  }

  /** Settle once every write asked for so far has landed. What a stop waits on
   * before it lets go of the config home (DESIGN §8.5 step 4). */
  async flush(): Promise<void> {
    await Promise.allSettled(this.#writing.values());
  }

  /** What the namespace holds, dropping the removals nothing can still be
   * carrying an older write for. A name this store read no file for is a
   * namespace with nothing in it. */
  #load(ns: string, now: Timestamp = Date.now()): Map<string, Held> {
    const known = this.#namespaces.get(ns) ?? new Map<string, Held>();
    this.#namespaces.set(ns, known);
    return forget(known, now);
  }

  /** The namespace as it stands, written whole.
   *
   * The body is taken here, before anything is awaited, so what is written is
   * the namespace as it was when the write was answered. Writes to one
   * namespace are chained rather than started side by side: two of them would
   * otherwise be racing for one file, and the older could land last (DR-0015).
   * Namespaces do not wait on each other, having nothing in common but this
   * directory. */
  #persist(ns: string, entries: Map<string, Held>): Promise<void> {
    const file = this.#file(ns);
    const body: Record<string, Held> = {};
    for (const [key, held] of entries) body[key] = held;
    const written = (this.#writing.get(ns) ?? Promise.resolve()).then(async () => {
      await mkdir(this.dir, { recursive: true });
      const temporary = `${file}.ccmsg-${process.pid}-${Date.now()}`;
      await writeFile(temporary, JSON.stringify(body));
      try {
        await rename(temporary, file);
      } catch (cause) {
        await unlink(temporary);
        throw cause;
      }
    });
    // The chain carries the order, not the outcome: a write that failed is
    // answered to its own caller, and the ones behind it still go.
    this.#writing.set(
      ns,
      written.catch(() => {}),
    );
    return written;
  }

  /** The namespace's file. A namespace is an identifier, so its name is a file
   * name that cannot reach out of this directory. */
  #file(ns: string): string {
    return join(this.dir, `${ns}.json`);
  }
}

/** One namespace's file, as the entries it states.
 *
 * A file a kill damaged states nothing this instance can act on, and refusing
 * every read of the namespace would be worse than starting it empty: the next
 * write replaces the file. */
function read(file: string): Map<string, Held> {
  const entries = new Map<string, Held>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return entries;
  }
  if (typeof parsed !== "object" || parsed === null) return entries;
  for (const [key, held] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof held !== "object" || held === null) continue;
    const fields = held as Record<string, unknown>;
    const updatedAt = fields["updated_at"];
    if (typeof updatedAt !== "number") continue;
    entries.set(
      key,
      fields["deleted"] === true
        ? { updated_at: updatedAt, deleted: true }
        : { value: fields["value"], updated_at: updatedAt },
    );
  }
  return entries;
}

/** Drop the removals nothing can still be carrying an older write for.
 *
 * Done where the namespace is read rather than on a clock of its own: a timer
 * would have this instance touching a store nobody is asking about, and a
 * removal that outlives its window until the next read is one no read can see
 * anyway. The file keeps it until the namespace is next written, which is the
 * only moment the file is rewritten at all. */
function forget(entries: Map<string, Held>, now: Timestamp): Map<string, Held> {
  for (const [key, held] of entries) {
    if (expired(held, now)) entries.delete(key);
  }
  return entries;
}

export function kvHandlers(store: KvStore) {
  return {
    "kv.read": (input: HandlerInput): KvReadResult =>
      store.read(input.args as unknown as KvReadArgs),
    "kv.write": (input: HandlerInput): Promise<KvWriteResult> =>
      store.write(input.args as unknown as KvWriteArgs),
    "kv.delete": (input: HandlerInput): Promise<KvDeleteResult> =>
      store.delete(input.args as unknown as KvDeleteArgs),
  };
}
