import { hostname } from "node:os";
import { join } from "node:path";
import {
  type AgentInfo,
  type Capability,
  type HelloArgs,
  type HelloResult,
  type InstanceId,
  type LastLiveSession,
  type PeerInfo,
  PROTOCOL_VERSION,
  type SessionState,
  type Sid,
  type Timestamp,
} from "@ccmsg/protocol";
import { type HandlerInput, OpError } from "../dispatch/index.ts";
import type { TopicValue, UpstreamResource } from "../topics/index.ts";
import { classify, type SessionInputs } from "./classify.ts";
import { HarnessSessions, isWaiting } from "./harness.ts";
import { LastLiveStore, type StoredEntry } from "./last-live.ts";

/** What the sessions domain needs from the instance around it. */
export interface SessionsDeps {
  readonly self: InstanceId;
  /** The one config home this instance answers for (§8.2). Its `sessions/` is
   * the only directory read, and no other config home is ever looked for (M6). */
  readonly configHome: string;
  /** Where `last_live` is written. Derived from the config home by the caller,
   * which is where every per-instance path is decided (§8.1). */
  readonly stateDir: string;
  readonly capabilities: readonly Capability[];
  /** The daemon build, reported by `hello` for display. */
  readonly version: string;
  readonly startedAt: Timestamp;
  /** The one way a value reaches subscribers (§6.1). */
  readonly publish: (topic: string, data: unknown) => void;
  /** How often the confirmation poll runs, for a test that cannot wait. */
  readonly pollMs?: number;
}

/** What a session said about itself when it greeted.
 *
 * The contract states these fields once and every place that describes a
 * session refers to them, so what a greeting carries and what `peers` repeats
 * are the same fields under the same names — nothing is renamed on the way
 * through, and nothing is invented for a field the session left unsaid. */
type SessionMeta = Pick<
  HelloArgs,
  "repo" | "ws" | "cwd" | "transcript_path" | "repo_root" | "branch" | "title" | "model" | "effort"
>;

const META_FIELDS = [
  "repo",
  "ws",
  "cwd",
  "transcript_path",
  "repo_root",
  "branch",
  "title",
  "model",
  "effort",
] as const;

/** One session holding a connection to us. */
interface Connected {
  readonly sid: Sid;
  readonly connected_at: Timestamp;
  readonly protocol_version: number;
  readonly client_version?: string;
  readonly meta: SessionMeta;
  /** The most recent request on any of its connections. Distinct from when a
   * person last spoke to it, which is folded out of the transcript and is the
   * one an attention-ordered list wants (§5.3). */
  last_activity_at: Timestamp;
  /** More than one client process of a session may hold a connection. */
  conns: number;
}

/** The sessions this instance can speak about, and the two topics that carry
 * them.
 *
 * The current value lives here rather than in the topic mechanism (§3.3): what
 * is connected is held in memory and dies with the process, what the harness
 * reports is re-read from `sessions/`, and only `last_live` survives a restart.
 * The classification of §5.2 is derived from those three whenever a payload is
 * built, and never stored (M4). */
export class Sessions implements UpstreamResource {
  readonly #connected = new Map<Sid, Connected>();
  readonly #harness: HarnessSessions;
  readonly #lastLive: LastLiveStore;
  /** Sessions seen live since the last recompute, kept so the moment one stops
   * being live is what writes its `last_live` entry. */
  #live = new Map<Sid, StoredEntry>();
  /** The topic names currently subscribed. Both topics rest on the same
   * directory watch, so it runs while either has a listener (§6.3). */
  readonly #wanted = new Set<string>();

  constructor(private readonly deps: SessionsDeps) {
    this.#harness = new HarnessSessions(
      join(deps.configHome, "sessions"),
      deps.self,
      () => this.changed(),
      deps.pollMs,
    );
    this.#lastLive = new LastLiveStore(join(deps.stateDir, "last-live.json"));
    this.#lastLive.load();
    this.#live = this.#liveNow();
  }

  /** `hello`, which is where a session becomes something this instance can
   * speak about, and where everything this instance knows about where that
   * session lives comes from.
   *
   * What registers a session is the greeting naming a sid, not the role it
   * claims: the sid is the session it speaks for, and reading the role here
   * would put the contract's "a session names its sid" rule in a second place
   * (M1). */
  hello = (input: HandlerInput): HelloResult => {
    const args = input.args as unknown as HelloArgs;
    if (args.protocol_version !== PROTOCOL_VERSION) {
      throw new OpError("bad_request", `this instance speaks protocol ${PROTOCOL_VERSION}`);
    }
    const sid = args.sid;
    if (sid !== undefined) {
      this.register(sid, args);
      input.conn.onClose(() => this.release(sid));
    }
    return {
      protocol_version: PROTOCOL_VERSION,
      instance: this.deps.self,
      instances: [{ id: this.deps.self, host: hostname(), reachable: true }],
      capabilities: [...this.deps.capabilities],
      version: this.deps.version,
      started_at: this.deps.startedAt,
    };
  };

  /** Where a session stands (§5.2). Undefined for a sid this instance has
   * never seen live and does not hold in `last_live`. */
  classify(sid: Sid, now: Timestamp = Date.now()): SessionState | undefined {
    return classify(this.inputs(sid), now);
  }

  /** Everything the classification of one session reads, exposed so the rule
   * and its inputs can be tested apart from each other. */
  inputs(sid: Sid): SessionInputs {
    const row = this.#harness.rows.get(sid);
    const stored = this.#lastLive.get(sid);
    return {
      connected: this.#connected.has(sid),
      ...(row === undefined
        ? {}
        : {
            harness: {
              waiting: isWaiting(row),
              ...(row.terminal_id === undefined ? {} : { terminal_id: row.terminal_id }),
            },
          }),
      ...(stored === undefined ? {} : { last_live: { stopped_at: stored.stopped_at } }),
    };
  }

  /** Note that a session said it was stopping, which is what makes it Paused
   * rather than Disappeared once it is gone (§5.2). */
  markStopped(sid: Sid, at: Timestamp = Date.now()): boolean {
    const marked = this.#lastLive.markStopped(sid, at);
    if (marked) this.changed();
    return marked;
  }

  // --- UpstreamResource (§6.3): the directory is read while, and only while,
  // somebody is subscribed to a topic that rests on it.

  start(topic: string): void {
    this.#wanted.add(topic);
    this.#harness.start();
  }

  stop(topic: string): void {
    this.#wanted.delete(topic);
    if (this.#wanted.size === 0) this.#harness.stop();
  }

  snapshot(topic: string): readonly TopicValue[] {
    const data = topic === "agents" ? this.agents() : this.peers();
    return [{ instance: this.deps.self, data }];
  }

  /** Whether the directory watch is running, which is what "the subscription
   * drives the resource" means in practice. */
  get watching(): boolean {
    return this.#harness.running;
  }

  /** The `peers` payload: what is connected now, and what was connected when
   * this instance last saw it. Both travel together because registering is
   * exactly what moves a session from the second list to the first.
   *
   * Every row states its `state` and its `pinned`. The contract lets an
   * instance leave them out, and a client then shows a session it cannot group
   * — this instance is one that classifies, so it says so on every row rather
   * than on the rows it happens to have an answer for. */
  peers(now: Timestamp = Date.now()): { peers: PeerInfo[]; last_live: LastLiveSession[] } {
    return {
      peers: [...this.#connected.values()].map((session) => this.#peer(session, now)),
      last_live: this.#lastLive.entries(now).map((entry) => ({
        ...entry,
        state: this.classify(entry.sid, now) ?? "disappeared",
        pinned: this.#pinned(entry.sid),
      })),
    };
  }

  /** The `agents` payload: the harness's own view, as it stated it.
   *
   * `polled_at` is left out. Stating when the read behind the list ran would
   * make every confirmation poll a value the list did not have before, so the
   * one suppression every topic shares (M5) would let a five-second heartbeat
   * through for a directory that had not changed. */
  agents(): { agents: AgentInfo[] } {
    return { agents: [...this.#harness.rows.values()] };
  }

  /** Bind a session to this instance, and take what it says about itself. Its
   * entry in `last_live` goes the moment it registers, which is the whole of
   * "an entry leaves the list when its session comes back". */
  private register(sid: Sid, args: HelloArgs): void {
    const now = Date.now();
    const held = this.#connected.get(sid);
    const meta = metaOf(args);
    this.#connected.set(sid, {
      sid,
      connected_at: held?.connected_at ?? now,
      protocol_version: args.protocol_version,
      ...(args.client_version === undefined ? {} : { client_version: args.client_version }),
      // A reconnection restates everything, so the newer greeting wins field by
      // field and a session that stops naming something does not keep it.
      meta,
      last_activity_at: now,
      conns: (held?.conns ?? 0) + 1,
    });
    this.#lastLive.remove(sid);
    this.changed(now);
  }

  /** One of a session's connections closed. The session is only gone when its
   * last one is. */
  private release(sid: Sid): void {
    const held = this.#connected.get(sid);
    if (held === undefined) return;
    if (held.conns > 1) {
      this.#connected.set(sid, { ...held, conns: held.conns - 1 });
      return;
    }
    this.#connected.delete(sid);
    this.changed();
  }

  /** Recompute, record what stopped being live, and state both topics.
   *
   * Publishing is unconditional here because suppression belongs to the topic
   * mechanism and is written once for every topic (M5) — a payload equal to
   * the last one goes no further than that. */
  private changed(now: Timestamp = Date.now()): void {
    const live = this.#liveNow(now);
    for (const [sid, entry] of this.#live) {
      if (live.has(sid)) continue;
      this.#lastLive.record({ ...entry, last_seen_at: now });
    }
    this.#live = live;
    this.deps.publish("peers", this.peers(now));
    this.deps.publish("agents", this.agents());
  }

  /** Every session live right now, in the form its `last_live` entry takes if
   * it stops being live. */
  #liveNow(now: Timestamp = Date.now()): Map<Sid, StoredEntry> {
    const live = new Map<Sid, StoredEntry>();
    for (const sid of this.#connected.keys()) live.set(sid, this.#entry(sid, now));
    for (const sid of this.#harness.rows.keys()) live.set(sid, this.#entry(sid, now));
    return live;
  }

  #entry(sid: Sid, now: Timestamp): StoredEntry {
    const held = this.#connected.get(sid);
    const row = this.#harness.rows.get(sid);
    return {
      sid,
      instance: this.deps.self,
      ...this.#where(sid),
      // The harness knows a title the session may not have stated itself.
      ...(row?.name === undefined ? {} : { title: row.name }),
      ...(held?.meta.title === undefined ? {} : { title: held.meta.title }),
      ...(held?.meta.model === undefined ? {} : { model: held.meta.model }),
      ...(held?.meta.effort === undefined ? {} : { effort: held.meta.effort }),
      ...(held === undefined ? {} : { connected_at: held.connected_at }),
      last_seen_at: now,
    };
  }

  #peer(session: Connected, now: Timestamp): PeerInfo {
    return {
      sid: session.sid,
      instance: this.deps.self,
      ...this.#where(session.sid),
      state: this.classify(session.sid, now) ?? "live",
      pinned: this.#pinned(session.sid),
      connected_at: session.connected_at,
      last_activity_at: session.last_activity_at,
      ...(session.client_version === undefined ? {} : { client_version: session.client_version }),
      protocol_version: session.protocol_version,
    };
  }

  /** Whether a person has pinned this session. Nothing can set a pin yet, so
   * this is false for every session — stated rather than left out, because an
   * absent `pinned` and a false one mean the same thing to a client and this
   * instance states what it knows on every row. */
  #pinned(_sid: Sid): boolean {
    return false;
  }

  /** Where a session is, as the contract's shared fields.
   *
   * The session's own greeting is the source. The harness's row supplies the
   * working directory for a session that greeted without one, and for one that
   * never greeted at all — it is the only field the harness also knows.
   *
   * `repo` and `ws` have no fallback: they are display names for a layout this
   * instance has no stated way to read out of a path, so a session that does
   * not name them is shown without them rather than with a guess. The same
   * goes for `repo_root`, which §4.2 says to derive from `cwd` when it is not
   * given — no primary source states that derivation, so it is left unstated
   * until one does. */
  #where(
    sid: Sid,
  ): Pick<PeerInfo, "repo" | "ws" | "cwd" | "transcript_path" | "repo_root" | "branch"> {
    const meta = this.#connected.get(sid)?.meta ?? {};
    const cwd = meta.cwd ?? this.#harness.rows.get(sid)?.cwd ?? "";
    return {
      repo: meta.repo ?? "",
      ws: meta.ws ?? "",
      cwd,
      ...(meta.transcript_path === undefined ? {} : { transcript_path: meta.transcript_path }),
      ...(meta.repo_root === undefined ? {} : { repo_root: meta.repo_root }),
      ...(meta.branch === undefined ? {} : { branch: meta.branch }),
    };
  }
}

/** What a greeting said about the session, and nothing more: the fields the
 * contract shares between `hello` and `peers`, copied across under their own
 * names. */
function metaOf(args: HelloArgs): SessionMeta {
  const meta: Record<string, string> = {};
  for (const field of META_FIELDS) {
    const value = args[field];
    if (value !== undefined) meta[field] = value;
  }
  return meta as SessionMeta;
}
