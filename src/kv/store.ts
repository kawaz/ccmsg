import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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

export const KV_DIR = "kv";

interface Held {
  value: unknown;
  updated_at: Timestamp;
}

/** The values clients keep here, and the topic that shows them changing.
 *
 * Written down, unlike almost everything else this instance holds (§3.6): a
 * value here was typed by a person and exists nowhere else — the theme a
 * browser is showing is a copy of it, not its source — so losing it on a
 * restart loses what they set. It is not a derived value, which is what M4
 * forbids persisting.
 *
 * One file per namespace, whole-file: a namespace holds a handful of small
 * values, and the whole of it is what both a snapshot and a reload state. The
 * write lands through a temporary and a rename, so a kill leaves either the
 * previous namespace or the new one. */
export class KvStore implements UpstreamResource {
  readonly #namespaces = new Map<string, Map<string, Held>>();

  constructor(
    private readonly dir: string,
    private readonly self: InstanceId,
    private readonly publish: (topic: string, data: unknown) => void,
  ) {}

  read(args: KvReadArgs): KvReadResult {
    const held = this.#load(args.ns).get(args.key);
    if (held === undefined) {
      throw new OpError("not_found", `${args.ns} holds no ${args.key}`);
    }
    return { value: held.value, updated_at: held.updated_at };
  }

  write(args: KvWriteArgs, now: Timestamp = Date.now()): KvWriteResult {
    const entries = this.#load(args.ns);
    const updatedAt = args.updated_at ?? now;
    entries.set(args.key, { value: args.value, updated_at: updatedAt });
    this.#persist(args.ns, entries);
    this.publish(`kv:${args.ns}`, {
      entries: [{ key: args.key, value: args.value, updated_at: updatedAt }],
    });
    return { updated_at: updatedAt };
  }

  /** A key that was not there is no error: the caller wanted the namespace
   * without it, and it is. The removal is still announced, because a subscriber
   * that has the entry has to be told it is gone. */
  delete(args: KvDeleteArgs, now: Timestamp = Date.now()): KvDeleteResult {
    const entries = this.#load(args.ns);
    if (entries.delete(args.key)) {
      this.#persist(args.ns, entries);
      this.publish(`kv:${args.ns}`, {
        entries: [{ key: args.key, updated_at: now, deleted: true }],
      });
    }
    return {};
  }

  /** Nothing to start or stop: the values are here whether anyone is watching
   * or not, and the file they live in is read the first time the namespace is
   * touched. */
  start(): void {}
  stop(): void {}

  /** Every entry the namespace holds. A snapshot never carries a removal, since
   * what is not there is simply absent from a whole list. */
  snapshot(topic: string, _conn: Requester): readonly TopicValue[] {
    const ns = topicParam(topic);
    if (ns === undefined) return [];
    const entries: KvEntry[] = [...this.#load(ns)].map(([key, held]) => ({
      key,
      value: held.value,
      updated_at: held.updated_at,
    }));
    return [{ instance: this.self, data: { entries } }];
  }

  #load(ns: string): Map<string, Held> {
    const known = this.#namespaces.get(ns);
    if (known !== undefined) return known;
    const entries = new Map<string, Held>();
    let text: string;
    try {
      text = readFileSync(this.#file(ns), "utf8");
    } catch {
      this.#namespaces.set(ns, entries);
      return entries;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // A file a kill damaged states nothing this instance can act on, and
      // refusing every read of the namespace would be worse than starting it
      // empty: the next write replaces the file.
      parsed = undefined;
    }
    if (typeof parsed === "object" && parsed !== null) {
      for (const [key, held] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof held !== "object" || held === null) continue;
        const fields = held as Record<string, unknown>;
        const updatedAt = fields["updated_at"];
        if (typeof updatedAt !== "number") continue;
        entries.set(key, { value: fields["value"], updated_at: updatedAt });
      }
    }
    this.#namespaces.set(ns, entries);
    return entries;
  }

  #persist(ns: string, entries: Map<string, Held>): void {
    mkdirSync(this.dir, { recursive: true });
    const file = this.#file(ns);
    const body: Record<string, Held> = {};
    for (const [key, held] of entries) body[key] = held;
    const temporary = `${file}.ccmsg-${process.pid}-${Date.now()}`;
    writeFileSync(temporary, JSON.stringify(body));
    try {
      renameSync(temporary, file);
    } catch (cause) {
      unlinkSync(temporary);
      throw cause;
    }
  }

  /** The namespace's file. A namespace is an identifier, so its name is a file
   * name that cannot reach out of this directory. */
  #file(ns: string): string {
    return join(this.dir, `${ns}.json`);
  }
}

export function kvHandlers(store: KvStore) {
  return {
    kv_read: (input: HandlerInput): KvReadResult => store.read(input.args as unknown as KvReadArgs),
    kv_write: (input: HandlerInput): KvWriteResult =>
      store.write(input.args as unknown as KvWriteArgs),
    kv_delete: (input: HandlerInput): KvDeleteResult =>
      store.delete(input.args as unknown as KvDeleteArgs),
  };
}
