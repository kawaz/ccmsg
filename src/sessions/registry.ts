import { realpathSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import {
  type AgentInfo,
  type Capability,
  type HelloArgs,
  type HelloResult,
  type Endpoint,
  type InstanceId,
  type InstanceInfo,
  type LastLiveSession,
  type PeerInfo,
  PROTOCOL_VERSION,
  type SessionState,
  type SessionStoppingResult,
  type Sid,
  type Timestamp,
} from "@ccmsg/protocol";
import { type HandlerInput, OpError, type Requester } from "../dispatch/index.ts";
import { within } from "../files/index.ts";
import { HARNESS, type Harness } from "../harness/index.ts";
import type { TranscriptFacts } from "../transcript/index.ts";
import type { TopicValue, UpstreamResource } from "../topics/index.ts";
import { classify, type SessionInputs } from "./classify.ts";
import { isWaiting, type OwnSessions, ownSessions } from "./harness.ts";
import { LastLiveStore, type StoredEntry } from "./last-live.ts";
import { stoppedOn } from "./status.ts";
import { TerminalCache, type TerminalReader } from "./terminals.ts";

/** What the harness says at one instant: the rows it reports, and which
 * sessions it says are there (§3.8).
 *
 * Two readings of one moment, passed together so a caller answering several
 * questions about that moment reads once. They are the same set for a harness
 * that reports a row per session and differ for one that reports none, which
 * is why the classification reads `present` and never the rows' keys. */
interface Own {
  readonly rows: ReadonlyMap<Sid, AgentInfo>;
  readonly present: ReadonlySet<Sid>;
}

/** What the sessions domain needs from the instance around it. */
export interface SessionsDeps {
  /** Which harness this config home runs (§3.8). It decides what says a
   * session is there and, through that, what `agents` can report. */
  readonly harness: Harness;
  readonly self: InstanceId;
  /** Where this instance says it is reached, which `hello` states beside the
   * id: the caller got here by some URL of its own — a proxy's, an alias — and
   * what a peer is to dial is neither that nor derivable from the id. Absent on
   * an instance reached by the unix socket alone, which has no URL to state. */
  readonly endpoint?: Endpoint;
  /** When the connection's authorization runs out, on one an access token
   * opened (DR-0001 §2.5). Absent on the unix socket, where reaching the
   * instance is itself the permission, and on a mesh link. */
  readonly authExpiresAt?: (conn: Requester) => Timestamp | undefined;
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
  /** What the transcript fold says about a session (§5.1). Absent while
   * nothing folds transcripts, in which case the two values it settles are
   * simply unknown and every rule that reads them behaves as it does for a
   * session whose transcript has said nothing. */
  readonly transcript?: TranscriptSource;
  /** What the gateway has seen of a session (§5.1). Absent on an instance with
   * no gateway configured, which costs the classification one of its five
   * inputs and none of its states. */
  readonly gateway?: GatewaySource;
  /** The sessions this instance speaks about, or what the fold says about one,
   * has changed. What rests on either — the topics whose value is derived from
   * the same fold, and the tails they keep running (§6.3) — is told to catch
   * up. Absent when nothing does. */
  readonly onChanged?: () => void;
  /** How often the confirmation poll runs, for a test that cannot wait. */
  readonly pollMs?: number;
  /** Where this domain says what it declined to act on. A greeting whose
   * `transcript_path` this instance will not read is answered `ok` all the
   * same — the field is simply absent from what `peers` says of the session —
   * and the reason it is absent is operational rather than contractual, so it
   * is written here for `ccmsg daemon log` to answer with. Absent where
   * nothing collects it. */
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
  /** How the terminal a session runs in is read from its process. Absent on a
   * host where no process's environment can be read, where every row's
   * terminal stays unknown — which is a state the classification has. */
  readonly terminals?: TerminalReader;
  /** The mesh, on an instance that has one. It answers the one greeting this
   * domain cannot judge: a peer's, whose claim is settled by an exchange of its
   * own rather than by anything a session says (§7.2). */
  readonly mesh?: MeshSource;
  /** Where a person opens the terminal a session runs in, which `hello` states
   * as `terminal_gateway`. The same value that gates the `terminal` capability
   * (`sessionCapabilities`), so a client told the capability is on is told
   * where to reach it in the same greeting. Absent on an instance with no
   * gateway configured. */
  readonly terminalGateway?: string;
}

/** What `hello` needs of the mesh: verify the greeting of a peer, and say which
 * instances there are and which of them can be reached (§7.5). */
export interface MeshSource {
  greet(conn: Requester, claim: MeshClaim): Promise<void>;
  instances(): InstanceInfo[];
}

/** The mesh claim a peer greets with, as the contract states it. */
type MeshClaim = NonNullable<HelloArgs["mesh"]>;

/** The fold, as the sessions domain reads it: two values about one session,
 * asked for when a payload is built rather than copied here when they change
 * (§3.3 — the current value lives with whoever owns it). */
export interface TranscriptSource {
  facts(sid: Sid): TranscriptFacts;
}

/** The gateway, as the sessions domain reads it: when it last saw inference
 * for one session, asked for when a payload is built (§3.3). */
export interface GatewaySource {
  activeAt(sid: Sid): Timestamp | undefined;
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
  readonly #harness: OwnSessions;
  readonly #terminals: TerminalCache | undefined;
  readonly #lastLive: LastLiveStore;
  /** Sessions seen live since the last recompute, kept so the moment one stops
   * being live is what writes its `last_live` entry. */
  #live = new Map<Sid, StoredEntry>();
  /** The topic names currently subscribed. Both topics rest on the same
   * directory watch, so it runs while either has a listener (§6.3). */
  readonly #wanted = new Set<string>();
  /** What a session said about itself when it last greeted, kept for as long
   * as the harness still names the session.
   *
   * A greeting is one instant and a connection is shorter than a session: a
   * session-start hook says where it works and leaves, and every client process
   * of the session comes and goes. What it said does not stop being true when
   * the process that said it exits, so holding it only while a connection is
   * open would mean the instance forgetting a session's repository the moment
   * it stopped being told it — and then writing it down as gone with nothing
   * but a sid on the entry.
   *
   * What bounds it is the harness: the words are kept while `sessions/` still
   * names the sid, and dropped in the same breath as the `last_live` entry that
   * spends them. Nothing here is written to disk (M4) — a restart forgets it,
   * and the next greeting says it again. */
  readonly #stated = new Map<Sid, SessionMeta>();
  /** Sessions that have said they are about to go, and when they said it.
   *
   * Held here rather than written to `last_live`, because the declaration
   * arrives while the session is still connected and `last_live` holds what is
   * gone: the entry is written when the connection closes, and this is what
   * stamps it then (contract, `session_stopping`). A session that declares and
   * then carries on stays connected and keeps its declaration, which is spent
   * whenever it does leave. */
  readonly #stopping = new Map<Sid, Timestamp>();

  constructor(private readonly deps: SessionsDeps) {
    this.#harness = ownSessions(
      deps.harness,
      deps.configHome,
      deps.self,
      () => this.changed(),
      deps.pollMs,
    );
    this.#lastLive = new LastLiveStore(join(deps.stateDir, "last-live.json"), deps.self);
    this.#lastLive.load();
    this.#terminals =
      deps.terminals === undefined
        ? undefined
        : new TerminalCache(deps.terminals, () => this.changed());
    this.#live = this.#liveNow(Date.now(), this.#own());
    this.#reclaim(this.#live);
  }

  /** Drop the `last_live` entry of every session that is live, which is what
   * keeps one session off both lists.
   *
   * Registering is one way a session comes back and is handled where it
   * happens; the harness naming it again is the other, and it is the only one
   * on a restart — nothing greets a daemon that was not there when the session
   * started. */
  #reclaim(live: ReadonlyMap<Sid, StoredEntry>): void {
    for (const sid of live.keys()) this.#lastLive.remove(sid);
  }

  /** `hello`, which is where a session becomes something this instance can
   * speak about, and where everything this instance knows about where that
   * session lives comes from.
   *
   * What registers a session is the greeting naming a sid, not the role it
   * claims: the sid is the session it speaks for, and reading the role here
   * would put the contract's "a session names its sid" rule in a second place
   * (M1). */
  hello = (input: HandlerInput): HelloResult | Promise<HelloResult> => {
    const args = input.args as unknown as HelloArgs;
    // A role is set once and fixed for the connection's life (contract, `Role`),
    // so a second greeting is not a re-identification: it is a request to be
    // somebody else on a connection that already is somebody.
    if (input.conn.identity.state === "settled") {
      throw new OpError("bad_request", "a connection greets once, and this one already has");
    }
    if (args.protocol_version !== PROTOCOL_VERSION) {
      throw new OpError("bad_request", `this instance speaks protocol ${PROTOCOL_VERSION}`);
    }
    if (args.role === "instance") {
      // A peer's greeting is answered only once the connection has been proven
      // to be the endpoint it names. The verification rejects when it is not,
      // and the connection stays anonymous because nothing settles an identity
      // but a reply (mesh-peer-auth §5, daemon-v2 §3.2 step 7). This is the one
      // greeting that has to wait for something, which is why it is the one
      // that answers with a promise.
      if (args.mesh === undefined) {
        throw new OpError("invalid_args", "an instance greets with its mesh claim");
      }
      const mesh = this.deps.mesh;
      if (mesh === undefined) {
        throw new OpError(
          "capability_unavailable",
          "this instance has no mesh, so no peer connection can be proven",
        );
      }
      return mesh.greet(input.conn, args.mesh).then(() => this.#greeted(args, input));
    }
    return this.#greeted(args, input);
  };

  /** What every greeting answers, once whatever had to be settled has been. */
  #greeted(args: HelloArgs, input: HandlerInput): HelloResult {
    const expiresAt = this.deps.authExpiresAt?.(input.conn);
    const sid = requiredSid(args);
    if (sid !== undefined) {
      this.register(sid, args);
      input.conn.onClose(() => this.release(sid));
    }
    return {
      protocol_version: PROTOCOL_VERSION,
      instance: this.deps.self,
      ...(this.deps.endpoint === undefined ? {} : { endpoint: this.deps.endpoint }),
      // Without a mesh the cluster is this instance alone, and it says so:
      // an instance serving the unix socket alone has no URL to be dialed at,
      // which is a row without an endpoint rather than no row (contract,
      // `InstanceInfo`).
      instances: this.deps.mesh?.instances() ?? [
        {
          id: this.deps.self,
          ...(this.deps.endpoint === undefined ? {} : { endpoint: this.deps.endpoint }),
          host: hostname(),
          reachable: true,
        },
      ],
      capabilities: [...this.deps.capabilities],
      version: this.deps.version,
      started_at: this.deps.startedAt,
      ...(this.deps.terminalGateway === undefined
        ? {}
        : { terminal_gateway: this.deps.terminalGateway }),
      ...(expiresAt === undefined ? {} : { auth_expires_at: expiresAt }),
    };
  }

  /** Where a session stands (§5.2). Undefined for a sid this instance has
   * never seen live and does not hold in `last_live`. */
  classify(
    sid: Sid,
    now: Timestamp = Date.now(),
    own: Own = this.#own(),
  ): SessionState | undefined {
    return classify(this.inputs(sid, own), now);
  }

  /** The harness's sessions as they are at this instant. One read serves one
   * question, and a caller answering several about the same instant passes the
   * result on rather than reading again. */
  #own(): Own {
    const rows = this.#harness.rows();
    const terminals = this.#terminals;
    if (terminals === undefined) return { rows, present: this.#harness.present() };
    // What the scan found is what exists: a pid that has left it is one whose
    // terminal is no longer anybody's, and one that has arrived is read once.
    terminals.observe([...rows.values()].map((row) => row.pid));
    const named = new Map<Sid, AgentInfo>();
    for (const [sid, row] of rows) {
      const terminal = terminals.get(row.pid);
      named.set(
        sid,
        terminal === undefined
          ? row
          : {
              ...row,
              terminal_id: terminal.id,
              ...(terminal.namespace === undefined
                ? {}
                : { terminal_namespace: terminal.namespace }),
            },
      );
    }
    return { rows: named, present: this.#harness.present() };
  }

  /** Everything the classification of one session reads, exposed so the rule
   * and its inputs can be tested apart from each other.
   *
   * The harness's rows are read here rather than taken from the watch. Which
   * sessions the harness has is a fact about this config home, true whether or
   * not anybody subscribed to hear about it (§5.1) — the watch of §6.3 exists
   * to push a change to subscribers, and reading its cache instead would make
   * "a session exists" mean "somebody is listening", which is how a live
   * session becomes `session_not_found` to a sender and how a session that is
   * still running is written into `last_live` as gone. */
  inputs(sid: Sid, own: Own = this.#own()): SessionInputs {
    const row = own.rows.get(sid);
    const present = own.present.has(sid);
    const stored = this.#lastLive.get(sid);
    const facts = this.deps.transcript?.facts(sid);
    const gatewayActiveAt = this.#gatewayActiveAt(sid, present);
    return {
      connected: this.#connected.has(sid),
      ...(gatewayActiveAt === undefined ? {} : { gateway_active_at: gatewayActiveAt }),
      ...(facts === undefined || stoppedOn(facts) === undefined ? {} : { api_error_stopped: true }),
      ...(!present
        ? {}
        : {
            harness: {
              waiting: row !== undefined && isWaiting(row),
              ...(row?.terminal_id === undefined ? {} : { terminal_id: row.terminal_id }),
            },
          }),
      ...(stored === undefined ? {} : { last_live: { stopped_at: stored.stopped_at } }),
    };
  }

  /** The sessions holding a connection to us. Whoever follows their
   * transcripts needs the set, and a greeting is what puts a session in it. */
  connectedSids(): Sid[] {
    return [...this.#connected.keys()];
  }

  /** Note that a session asked for something. `last_activity_at` is the most
   * recent request on any of its connections, so every request restamps the one
   * row all of them share.
   *
   * Nothing is published here. The value travels on the next `peers` payload
   * whatever caused it, and publishing per request would put a frame on the
   * wire for every call a session makes — a row that changed only in its clock
   * is not news a subscriber asked for. */
  touch(sid: Sid, at: Timestamp = Date.now()): void {
    const held = this.#connected.get(sid);
    if (held !== undefined) held.last_activity_at = at;
  }

  /** Where a session's transcript is, as it announced it (§5.1). Whoever
   * follows one needs the path, and the greeting is the only thing that
   * states it. */
  transcriptPath(sid: Sid): string | undefined {
    return this.#stated.get(sid)?.transcript_path;
  }

  /** Where a session works, as it greeted: the container its files are reached
   * through, and the directory it runs in. Both are stated only by a greeting,
   * so a session that named neither is one no path is admitted for. */
  where(sid: Sid): { root?: string; cwd?: string } {
    const meta = this.#connected.get(sid)?.meta;
    const cwd = meta?.cwd ?? this.#own().rows.get(sid)?.cwd;
    // The container when the session named one, the working directory
    // otherwise — the same order `repo_root` is meant in (§4.2).
    const root = meta?.repo_root ?? cwd;
    return {
      ...(root === undefined || root === "" ? {} : { root }),
      ...(cwd === undefined || cwd === "" ? {} : { cwd }),
    };
  }

  /** The harness's sessions as they are right now, read rather than taken
   * from the watch's cache. What acts on a session's process resolves its pid
   * through this: the watch runs only while somebody is subscribed (§6.3), and
   * a pid from a poll that has not run is a number belonging to nobody. */
  rowsNow(): ReadonlyMap<Sid, AgentInfo> {
    return this.#own().rows;
  }

  /** Drop one entry from `last_live`, which is what
   * `session_last_live_remove` asks for. The removal touches that list alone:
   * the session stays resumable by every other route. */
  forget(sid: Sid): boolean {
    const removed = this.#lastLive.remove(sid);
    if (removed) this.changed();
    return removed;
  }

  /** Recompute and state both topics. What the fold settles is an input to the
   * classification and to `peers`, so a fold that changed says so here. */
  refresh(): void {
    this.changed();
  }

  /** `session_stopping`: a session saying it is about to go, which is what
   * makes it Paused rather than Disappeared once it is gone (§5.2).
   *
   * Nothing is recorded now and nothing is published: the session is still
   * here, and the list this changes is the one it is not on yet. What the
   * declaration does is wait for the disconnection that follows it. */
  stopping = (input: HandlerInput): SessionStoppingResult => {
    const sid = input.identity?.sid;
    if (sid === undefined) {
      throw new OpError(
        "bad_request",
        "a session says it is stopping, and this greeting named none",
      );
    }
    const at = Date.now();
    this.#stopping.set(sid, at);
    return { stopped_at: at };
  };

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
    const own = this.#own();
    const data = topic === "agents" ? this.agents(own) : this.peers(Date.now(), own);
    return [{ instance: this.deps.self, data }];
  }

  /** Whether the directory watch is running, which is what "the subscription
   * drives the resource" means in practice. */
  get watching(): boolean {
    return this.#harness.running;
  }

  /** The `peers` payload: what is live now, and what was live when this
   * instance last saw it. Both travel together because coming back is exactly
   * what moves a session from the second list to the first.
   *
   * Live is not the same as connected (§5.2). A session the harness names is
   * live whether or not it ever greeted us, and it has to be on this list for
   * the same reason it is classified at all: a restart forgets every greeting,
   * and a list that showed only what had greeted this daemon would show a host
   * full of running sessions as empty.
   *
   * Every row states its `state` and its `pinned`. The contract lets an
   * instance leave them out, and a client then shows a session it cannot group
   * — this instance is one that classifies, so it says so on every row rather
   * than on the rows it happens to have an answer for.
   *
   * `instances` is the same view `hello` answers with, restated here so that a
   * link going down reaches a subscriber on the topic it is already on rather
   * than only on its next greeting (§7.5). It is this instance's view: what a
   * peer relayed here carries the peer's own, and neither is folded into the
   * other. An instance with no mesh states none, which is a different thing
   * from stating that nothing is reachable. */
  peers(
    now: Timestamp = Date.now(),
    own: Own = this.#own(),
  ): { peers: PeerInfo[]; last_live: LastLiveSession[]; instances?: InstanceInfo[] } {
    const instances = this.deps.mesh?.instances();
    return {
      peers: [
        ...[...this.#connected.values()].map((session) => this.#peer(session, now, own)),
        ...[...own.present]
          .filter((sid) => !this.#connected.has(sid))
          .map((sid) => this.#unconnected(sid, now, own)),
      ],
      last_live: this.#lastLive.entries(now).map((entry) => ({
        ...entry,
        state: this.classify(entry.sid, now, own) ?? "disappeared",
        pinned: this.#pinned(entry.sid),
      })),
      ...(instances === undefined ? {} : { instances }),
    };
  }

  /** The `agents` payload: the harness's own view, as it stated it.
   *
   * `polled_at` is left out. Stating when the read behind the list ran would
   * make every confirmation poll a value the list did not have before, so the
   * one suppression every topic shares (M5) would let a five-second heartbeat
   * through for a directory that had not changed. */
  agents(own: Own = this.#own()): { agents: AgentInfo[] } {
    return { agents: [...own.rows.values()] };
  }

  /** Bind a session to this instance, and take what it says about itself. Its
   * entry in `last_live` goes the moment it registers, which is the whole of
   * "an entry leaves the list when its session comes back".
   *
   * What a greeting names is taken field by field, and not naming a field
   * means it is unchanged rather than withdrawn. One session reaches this
   * instance as a run of short-lived processes — a session-start hook, a
   * `post`, a session-end hook — and none of them knows every field: only the
   * hooks are told where the transcript is, and only a command running in the
   * session's own directory can work out the repository. A greeting that took
   * silence for a retraction would let each of them erase what the last one
   * knew, and the session would be described by whichever process spoke most
   * recently rather than by everything it has said. */
  private register(sid: Sid, args: HelloArgs): void {
    const now = Date.now();
    const held = this.#connected.get(sid);
    const meta = {
      ...this.#stated.get(sid),
      ...metaOf(this.deps, args, (refused) => {
        this.deps.log?.("transcript_path not taken", { sid, path: args.transcript_path, refused });
      }),
    };
    this.#connected.set(sid, {
      sid,
      connected_at: held?.connected_at ?? now,
      protocol_version: args.protocol_version,
      ...(args.client_version === undefined ? {} : { client_version: args.client_version }),
      meta,
      last_activity_at: now,
      conns: (held?.conns ?? 0) + 1,
    });
    this.#stated.set(sid, meta);
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
    const own = this.#own();
    const live = this.#liveNow(now, own);
    for (const [sid, entry] of this.#live) {
      if (live.has(sid)) continue;
      // The declaration came first and the departure has now arrived, which is
      // the order the two are one event in (contract, `session_stopping`).
      const stoppedAt = this.#stopping.get(sid);
      this.#stopping.delete(sid);
      this.#lastLive.record({
        ...entry,
        last_seen_at: now,
        ...(stoppedAt === undefined ? {} : { stopped_at: stoppedAt }),
      });
      // The words are spent: the entry just written carries them, and the
      // session they were about is one the harness no longer names. A sid that
      // comes back says them again.
      this.#stated.delete(sid);
    }
    this.#reclaim(live);
    this.#live = live;
    this.deps.publish("peers", this.peers(now, own));
    this.deps.publish("agents", this.agents(own));
    this.deps.onChanged?.();
  }

  /** Every session live right now, in the form its `last_live` entry takes if
   * it stops being live. */
  #liveNow(now: Timestamp, own: Own): Map<Sid, StoredEntry> {
    const live = new Map<Sid, StoredEntry>();
    for (const sid of this.#connected.keys()) live.set(sid, this.#entry(sid, now, own));
    for (const sid of own.present) live.set(sid, this.#entry(sid, now, own));
    return live;
  }

  #entry(sid: Sid, now: Timestamp, own: Own): StoredEntry {
    const held = this.#connected.get(sid);
    const row = own.rows.get(sid);
    // What answered last, not what the session named when it greeted: the
    // greeting is one instant and `/model` moves afterwards, so the fold is
    // asked first and the greeting only fills in for a transcript that has
    // said nothing yet.
    const answered = this.deps.transcript?.facts(sid);
    const stated = this.#stated.get(sid);
    const model = answered?.model ?? stated?.model;
    const effort = answered?.model === undefined ? stated?.effort : answered.effort;
    return {
      sid,
      instance: this.deps.self,
      // The harness knows a title for a session that stated none itself, so
      // it goes first and what the session named overrides it.
      ...(row?.name === undefined ? {} : { title: row.name }),
      ...this.#where(sid, own),
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
      ...(held === undefined ? {} : { connected_at: held.connected_at }),
      last_seen_at: now,
    };
  }

  #peer(session: Connected, now: Timestamp, own: Own): PeerInfo {
    // The two "last activity" values are different questions (§5.3): the one
    // above moves on every request the session makes, this one only when a
    // person speaks, and the fold is the only place that knows the second.
    const userInput = this.deps.transcript?.facts(session.sid).last_user_input_at;
    // What the gateway last saw run for this session: an attribute of the row
    // beside the classification, not folded into it (§5.1). Absent from an
    // instance with no gateway, where nothing observes inference at all.
    const gatewayActiveAt = this.#gatewayActiveAt(session.sid, own.present.has(session.sid));
    return {
      sid: session.sid,
      instance: this.deps.self,
      ...this.#where(session.sid, own),
      state: this.classify(session.sid, now, own) ?? "live",
      pinned: this.#pinned(session.sid),
      connected_at: session.connected_at,
      last_activity_at: session.last_activity_at,
      ...(userInput === undefined ? {} : { last_user_input_at: userInput }),
      ...(gatewayActiveAt === undefined ? {} : { gateway_active_at: gatewayActiveAt }),
      ...(session.client_version === undefined ? {} : { client_version: session.client_version }),
      protocol_version: session.protocol_version,
    };
  }

  /** A session the harness names that holds no connection here (§5.1).
   *
   * It is on the same list as the connected ones because it is live in the same
   * sense: the classification is what separates them, and a client groups on
   * that field alone (§5.2). What it cannot carry is everything a greeting
   * states — the session never said where it works, so the working directory
   * comes from the harness's own row and the display names it does not know are
   * simply absent.
   *
   * The connection fields go with the connection: `connected_at`,
   * `last_activity_at` and the client's build and generation are things about a
   * client of this session, and there is none. */
  #unconnected(sid: Sid, now: Timestamp, own: Own): PeerInfo {
    const row = own.rows.get(sid);
    const userInput = this.deps.transcript?.facts(sid).last_user_input_at;
    const gatewayActiveAt = this.#gatewayActiveAt(sid, true);
    return {
      sid,
      instance: this.deps.self,
      // The harness knows a title for a session that stated none itself, and
      // what the session said about itself overrides it.
      ...(row?.name === undefined ? {} : { title: row.name }),
      ...this.#where(sid, own),
      state: this.classify(sid, now, own) ?? "live",
      pinned: this.#pinned(sid),
      ...(userInput === undefined ? {} : { last_user_input_at: userInput }),
      ...(gatewayActiveAt === undefined ? {} : { gateway_active_at: gatewayActiveAt }),
    };
  }

  /** When the gateway last saw inference for a session, for a session this
   * instance knows (§5.1).
   *
   * The gateway sits above every config home and its events name only a session
   * id, so what it reports is not by itself evidence about *this* instance's
   * sessions: a session id belonging to another config home would otherwise
   * classify as live here, put a row on this instance's `peers`, and make
   * `message_send` accept a message for a session that has no inbox here and
   * never will. So the reading is narrowed to the sids this instance knows —
   * one that has greeted us, still connected or remembered in `last_live`, or
   * one the harness's own `sessions/` names. The events themselves are not
   * dropped: `llm_requests` carries what the gateway saw whoever it was for,
   * because that topic is a view of the gateway rather than of this instance's
   * sessions. */
  #gatewayActiveAt(sid: Sid, inHarness: boolean): Timestamp | undefined {
    const known = inHarness || this.#connected.has(sid) || this.#lastLive.get(sid) !== undefined;
    return known ? this.deps.gateway?.activeAt(sid) : undefined;
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
    own: Own,
  ): Pick<PeerInfo, "repo" | "ws" | "cwd" | "transcript_path" | "repo_root" | "branch" | "title"> {
    const meta = this.#stated.get(sid) ?? {};
    const cwd = meta.cwd ?? own.rows.get(sid)?.cwd ?? "";
    return {
      repo: meta.repo ?? "",
      ws: meta.ws ?? "",
      cwd,
      ...(meta.transcript_path === undefined ? {} : { transcript_path: meta.transcript_path }),
      ...(meta.repo_root === undefined ? {} : { repo_root: meta.repo_root }),
      ...(meta.branch === undefined ? {} : { branch: meta.branch }),
      ...(meta.title === undefined ? {} : { title: meta.title }),
    };
  }
}

/** What a greeting said about the session, and nothing more: the fields the
 * contract shares between `hello` and `peers`, copied across under their own
 * names.
 *
 * `transcript_path` is the exception, because it is the one field that is not
 * only displayed: it names a file this instance then reads and follows. What is
 * taken is a path under this config home's transcript tree, resolved, and nothing
 * else — a session naming a file elsewhere is a session that named nothing,
 * which is what a session that stayed silent already is (M6). It is not an
 * error: how a session describes itself is its own business, and the instance
 * simply does not act on a description it cannot stand behind. Why a path was
 * not taken is told to `refused`, which is the operator's answer to a field
 * that is simply absent from what `peers` says. */
function metaOf(
  deps: Pick<SessionsDeps, "configHome" | "harness">,
  args: HelloArgs,
  refused: (reason: string) => void,
): SessionMeta {
  const meta: Record<string, string> = {};
  for (const field of META_FIELDS) {
    const value = args[field];
    if (value === undefined) continue;
    if (field === "transcript_path") {
      const taken = ownTranscript(value, deps);
      if (typeof taken === "string") meta[field] = taken;
      else refused(taken.refused);
      continue;
    }
    meta[field] = value;
  }
  return meta as SessionMeta;
}

/** A transcript path this instance will read, or nothing.

 * The test is where the file would be, not whether it is there. M6 is a
 * boundary on what this instance reads, and a path inside the tree stays
 * inside it whether or not anything has been written there yet — a session
 * greeting at its very start names a transcript the harness has created
 * neither the file nor the directory for, and refusing it would mean the one
 * greeting that says where a session's transcript is is the one greeting whose
 * answer is thrown away. Nothing is read early by accepting it: the tail
 * starts when somebody follows the session, and a file that is not there yet
 * is one it waits for.
 *
 * As much of the path as exists is resolved, so a path spelled through a
 * symlink and one spelled directly are the same path, and a link anywhere
 * along it that leads out of the tree lands outside and is refused. What is
 * already there must be a file: a directory by that name is not a transcript.
 *
 * The tree itself is settled the same way, so a config home whose first
 * session has yet to write anything is a boundary all the same: the directory
 * that is there is followed, the part that is not is taken as spelled, and the
 * comparison is between two paths resolved by one rule. The config home is not
 * treated that way — an instance answers for a home it is running out of, and
 * one that is not there names no tree to be inside of. */
function ownTranscript(
  named: string,
  deps: Pick<SessionsDeps, "configHome" | "harness">,
): string | Refused {
  if (!isAbsolute(named)) return { refused: "not an absolute path" };
  let tree: string | undefined;
  try {
    const home = realpathSync(deps.configHome);
    tree = resolveAsFarAsItGoes(join(home, HARNESS[deps.harness].transcripts));
  } catch {
    return { refused: "the config home is not there" };
  }
  const settled = resolveAsFarAsItGoes(named);
  if (tree === undefined || settled === undefined || !within(settled, tree)) {
    return { refused: "outside this config home's transcript tree" };
  }
  const stat = statSync(settled, { throwIfNoEntry: false });
  if (stat !== undefined && !stat.isFile()) return { refused: "not a file" };
  return settled;
}

/** Why a stated path was not taken, in the words the log states it in. */
interface Refused {
  readonly refused: string;
}

/** The path with every segment of it that exists resolved.
 *
 * A segment that is there may be a link and is followed; a segment that is not
 * there cannot be a link to anywhere, because there is nothing at it, so it is
 * kept as it was spelled. The result is compared against the tree as a whole,
 * which is what makes a `..` among the unwritten segments land wherever it
 * actually points rather than pass for being spelled inside. */
function resolveAsFarAsItGoes(path: string): string | undefined {
  const unwritten: string[] = [];
  let at = path;
  for (;;) {
    try {
      return join(realpathSync(at), ...unwritten);
    } catch {
      const parent = dirname(at);
      // The root itself always resolves, so this is a path that named
      // something no filesystem root holds.
      if (parent === at) return undefined;
      unwritten.unshift(basename(at));
      at = parent;
    }
  }
}

/** What each role must and must not say when it greets.
 *
 * The sid is what registers a session, so which role is entitled to name one is
 * decided here rather than left to whoever reads the field: a `user` naming a
 * sid would be a person registering as the session, and a `session` without one
 * is a session this instance cannot speak about. */
function requiredSid(args: HelloArgs): Sid | undefined {
  switch (args.role) {
    case "session":
      if (args.sid === undefined) throw new OpError("invalid_args", "a session names its sid");
      return args.sid;
    case "user":
      if (args.sid !== undefined) {
        throw new OpError("invalid_args", "a sid is the greeting of a session, not of a person");
      }
      return undefined;
    case "instance":
      // A peer speaks for no session: what it is has already been settled by
      // the handshake, and a sid here would be it registering as one.
      if (args.sid !== undefined) {
        throw new OpError("invalid_args", "a sid is the greeting of a session, not of an instance");
      }
      return undefined;
  }
}
