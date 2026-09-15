import type { Stats } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import {
  type AgentInfo,
  type Capability,
  type HelloInstanceArgs,
  type HelloResult,
  type HelloSessionArgs,
  type HelloUserArgs,
  type Endpoint,
  type AgentElement,
  type InstanceId,
  type InstanceInfo,
  type PeerElement,
  type PeerInfo,
  PROTOCOL_VERSION,
  type SessionRun,
  type SessionStatusStanding,
  type SessionStoppingResult,
  type Sid,
  type Timestamp,
} from "@ccmsg/protocol";
import { type HandlerInput, OpError, type Requester } from "../dispatch/index.ts";
import { within } from "../files/index.ts";
import { HARNESS, type Harness } from "../harness/index.ts";
import { meshView } from "../mesh/instances.ts";
import type { TranscriptFacts } from "../transcript/index.ts";
import { AGENT_ROWS, Elements, type TopicValue, type UpstreamResource } from "../topics/index.ts";
import { type OwnSessions, ownSessions } from "./harness.ts";
import { LastLiveStore, type StoredEntry } from "./last-live.ts";
import { duplicated, type ObservedRun, runsOf, statedTerminalId } from "./runs.ts";
import { TerminalCache, type TerminalReader } from "./terminals.ts";

/** What the harness says at one instant: the rows it reports, and which
 * sessions it says are there (DESIGN §4.1).
 *
 * Two readings of one moment, passed together so a caller answering several
 * questions about that moment reads once. They are the same set for a harness
 * that reports a row per session and differ for one that reports none, which
 * is why the classification reads `present` and never the rows' keys. */
interface Own {
  /** One entry per process, keyed by pid: two of them may name one session
   * (contract, `AgentInfo`). */
  readonly rows: ReadonlyMap<number, AgentInfo>;
  /** The same rows gathered by the session each one names, which is how a
   * session's runs are found. */
  readonly bySid: ReadonlyMap<Sid, readonly AgentInfo[]>;
  readonly present: ReadonlySet<Sid>;
}

/** One row of `agents` that no state file wrote: a process a launcher started,
 * before the harness has named a session for it. */
export interface LaunchedRun {
  readonly pid: number;
  readonly started_at: Timestamp;
  readonly cwd: string;
  readonly terminal_id?: string;
  /** The session a greeting has tied this process to, once one has. */
  readonly sid?: Sid;
}

/** The processes a launcher of this instance started, which are runs before
 * anything else can see them (DR-0001 §4). Absent on an instance with no
 * launcher, where every run is first seen in the harness's own directory. */
export interface LaunchSource {
  /** The ones still running, as they stand now. */
  running(): readonly LaunchedRun[];
  /** A greeting named the harness process it speaks for. Ties that process to
   * the session, which is what turns a row with no `sid` into one with it. */
  tie(pid: number, sid: Sid): void;
}

/** What the sessions domain needs from the instance around it. */
export interface SessionsDeps {
  /** Which harness this config home runs (DESIGN §4.1). It decides what says a
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
  /** The one config home this instance answers for (DESIGN §8.2). Its `sessions/` is
   * the only directory read, and no other config home is ever looked for (M6). */
  readonly configHome: string;
  /** Where `last_live` is written. Derived from the config home by the caller,
   * which is where every per-instance path is decided (DESIGN §8.1). */
  readonly stateDir: string;
  readonly capabilities: readonly Capability[];
  /** The daemon build, reported by `hello` for display. */
  readonly version: string;
  readonly startedAt: Timestamp;
  /** The one way a value reaches subscribers (DESIGN §6.1). */
  readonly publish: (topic: string, data: unknown) => void;
  /** What the transcript fold says about a session (DESIGN §4.2). Absent while
   * nothing folds transcripts, in which case the two values it settles are
   * simply unknown and every rule that reads them behaves as it does for a
   * session whose transcript has said nothing. */
  readonly transcript?: TranscriptSource;
  /** What the gateway has seen of a session (DESIGN §4.2). Absent on an instance with
   * no gateway configured, which costs the classification one of its five
   * inputs and none of its states. */
  readonly gateway?: GatewaySource;
  /** The sessions this instance speaks about, or what the fold says about one,
   * has changed. What rests on either — the topics whose value is derived from
   * the same fold, and the tails they keep running (DESIGN §6.3) — is told to catch
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
   * own rather than by anything a session says (DESIGN §7.2). */
  readonly mesh?: MeshSource;
  /** Where a person opens the terminal a session runs in, which `hello` states
   * as `terminal_gateway`. The same value that gates the `terminal` capability
   * (`sessionCapabilities`), so a client told the capability is on is told
   * where to reach it in the same greeting. Absent on an instance with no
   * gateway configured. */
  readonly terminalGateway?: string;
  /** The runs a launcher started, seen before the harness writes anything of
   * its own (DR-0001 §4). Absent on an instance with no launcher. */
  readonly launches?: LaunchSource;
}

/** What `hello` needs of the mesh: verify the greeting of a peer, and say which
 * instances there are and which of them can be reached (DESIGN §7.5). */
export interface MeshSource {
  greet(conn: Requester, claim: MeshClaim): Promise<void>;
  instances(): InstanceInfo[];
}

/** The mesh claim a peer greets with, as the contract states it. */
type MeshClaim = HelloInstanceArgs["mesh"];

/** The fold, as the sessions domain reads it: two values about one session,
 * asked for when a payload is built rather than copied here when they change
 * (DESIGN §2.3 — the current value lives with whoever owns it). */
export interface TranscriptSource {
  facts(sid: Sid): TranscriptFacts;
  /** What the fold is worth, which the row states as `session_status` —
   * everything but `frozen`, which is a count of runs and is settled here. */
  standing(sid: Sid): SessionStatusStanding;
  /** Two or more processes are writing this session, or are no longer: while
   * they are, nothing of the file is read (DR-0001 §3). */
  duplicated(sid: Sid, now: boolean): void;
}

/** The gateway, as the sessions domain reads it: when it last saw inference
 * for one session, asked for when a payload is built (DESIGN §2.3). */
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
  HelloSessionArgs,
  "repo" | "ws" | "cwd" | "transcript_path" | "repo_root" | "branch" | "title" | "model" | "effort"
>;

/** What a row of `agents` says a process is while only the launcher has seen
 * it. `kind` is an open set, and no word of the harness's own is true of a
 * process it has not written a file for. */
const LAUNCHED = "launch";

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
   * one an attention-ordered list wants (DESIGN §4.4). */
  last_activity_at: Timestamp;
  /** More than one client process of a session may hold a connection. */
  conns: number;
  /** The harness processes the greetings on those connections named, counted
   * so that the last connection speaking for a run is what takes it out.
   *
   * A greeting is usually carried by something standing in for the session — a
   * hook, the CLI — which names the harness process it belongs to rather than
   * itself (contract, `HelloSessionArgs.pid`). That is what says which run a
   * connection belongs to, and a greeting that named none leaves the
   * connection unattributed. */
  readonly pids: Map<number, number>;
}

/** The sessions this instance can speak about, and the two topics that carry
 * them.
 *
 * The current value lives here rather than in the topic mechanism (DESIGN §2.3): what
 * is connected is held in memory and dies with the process, what the harness
 * reports is re-read from `sessions/`, and only `last_live` survives a restart.
 * The classification of DESIGN §4.3 is derived from those three whenever a payload is
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
   * directory watch, so it runs while either has a listener (DESIGN §6.3). */
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
   * stamps it then (contract, `session.stopping`). A session that declares and
   * then carries on stays connected and keeps its declaration, which is spent
   * whenever it does leave. */
  readonly #stopping = new Map<Sid, Timestamp>();
  /** What the last frame of each topic left every subscriber holding, kept
   * whether or not anybody is subscribed.
   *
   * A frame carries a difference, and the difference is taken against what was
   * sent — not against what the last listener happened to see. Which is also
   * what makes it right for a subscriber that arrives after a spell of nobody
   * listening: it is handed every row as a snapshot, and every frame after it
   * says what changed since the last one went out. */
  readonly #sentPeers = new Elements();
  readonly #sentAgents = new Elements(AGENT_ROWS);
  /** The connections whose greeting has been accepted and not yet answered.
   *
   * A connection greets once, and the identity that says it has greeted is
   * settled by the reply (DESIGN §2.1). A greeting that waits on a read before
   * it can be answered leaves a window between the two, and a second greeting
   * on the same connection arriving in that window would find it still
   * anonymous. So the claim is taken here, in the same synchronous step that
   * judges the greeting, and what is held is a token of the greeting that took
   * it — so that on the far side of the wait the greeting can tell whether the
   * claim is still its own (DR-0015 §2.5). A greeting that fails gives the
   * claim back, since a refused greeting must not leave the connection unable
   * to greet at all. */
  readonly #greeting = new WeakMap<Requester, object>();

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

  /** Settle the list of lost sessions on disk. The writes happen as sessions
   * come and go (DR-0015); this is for whoever has to see the file as it stands
   * rather than as it was a moment ago — a stop, or a reader of the file. */
  async flush(): Promise<void> {
    await this.#lastLive.flush();
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

  /** `hello.session`, which is where a session becomes something this instance
   * can speak about, and where everything this instance knows about where that
   * session lives comes from. The greeting names its sid because the op it
   * arrived under is the one whose schema asks for one. */
  helloSession = async (input: HandlerInput): Promise<HelloResult> => {
    const args = input.args as unknown as HelloSessionArgs;
    const claim = this.#greetable(input, args.protocol_version);
    try {
      await this.register(args.sid, args);
    } catch (cause) {
      this.#withdraw(input.conn, claim);
      throw cause;
    }
    // The claim was this greeting's before the read; the session it just
    // registered stands only if it still is.
    if (this.#greeting.get(input.conn) !== claim) {
      this.release(args.sid, args.pid);
      throw new OpError("bad_request", "a connection greets once, and this one already has");
    }
    input.conn.onClose(() => this.release(args.sid, args.pid));
    return this.#greeted(input);
  };

  /** `hello.user`. A person speaks for no session, so there is nothing to
   * register: the greeting settles a role and answers what the instance is. */
  helloUser = (input: HandlerInput): HelloResult => {
    const args = input.args as unknown as HelloUserArgs;
    this.#greetable(input, args.protocol_version);
    return this.#greeted(input);
  };

  /** `hello.instance`. A peer's greeting is answered only once the connection
   * has been proven to be the endpoint it names. The verification rejects when
   * it is not, and the connection stays anonymous because nothing settles an
   * identity but a reply (mesh-peer-auth §5, DESIGN §2.2 step 7). This is
   * the one greeting that has to wait for something, which is why it is the one
   * that answers with a promise. */
  helloInstance = (input: HandlerInput): Promise<HelloResult> => {
    const args = input.args as unknown as HelloInstanceArgs;
    const claim = this.#greetable(input, args.protocol_version);
    const mesh = this.deps.mesh;
    if (mesh === undefined) {
      this.#withdraw(input.conn, claim);
      throw new OpError(
        "capability_unavailable",
        "this instance has no mesh, so no peer connection can be proven",
      );
    }
    return mesh.greet(input.conn, args.mesh).then(
      () => this.#greeted(input),
      (cause: unknown) => {
        this.#withdraw(input.conn, claim);
        throw cause;
      },
    );
  };

  /** What each of the three greetings checks before it settles anything, and
   * the claim it takes on the connection once it has passed.
   *
   * A role is set once and fixed for the connection's life (contract, `Role`),
   * so a second greeting is not a re-identification: it is a request to be
   * somebody else on a connection that already is somebody — whether that
   * somebody has been settled by a reply already, or is about to be by the
   * greeting that holds the claim. */
  #greetable(input: HandlerInput, protocolVersion: number): object {
    if (input.conn.identity.state === "settled" || this.#greeting.has(input.conn)) {
      throw new OpError("bad_request", "a connection greets once, and this one already has");
    }
    if (protocolVersion !== PROTOCOL_VERSION) {
      throw new OpError("bad_request", `this instance speaks protocol ${PROTOCOL_VERSION}`);
    }
    const claim = {};
    this.#greeting.set(input.conn, claim);
    return claim;
  }

  /** Give a claim back, for a greeting that was accepted and then could not be
   * answered. Only the greeting that holds it can give it back. */
  #withdraw(conn: Requester, claim: object): void {
    if (this.#greeting.get(conn) === claim) this.#greeting.delete(conn);
  }

  /** What every greeting answers, once whatever had to be settled has been. */
  #greeted(input: HandlerInput): HelloResult {
    const expiresAt = this.deps.authExpiresAt?.(input.conn);
    return {
      protocol_version: PROTOCOL_VERSION,
      instance: this.deps.self,
      ...(this.deps.endpoint === undefined ? {} : { endpoint: this.deps.endpoint }),
      // The same view the `instances` topic carries, worked out in one place
      // so a greeting and a subscription cannot state two different meshs.
      instances: meshView(this.deps.self, this.deps.endpoint, this.deps.mesh),
      capabilities: [...this.deps.capabilities],
      version: this.deps.version,
      started_at: this.deps.startedAt,
      ...(this.deps.terminalGateway === undefined
        ? {}
        : { terminal_gateway: this.deps.terminalGateway }),
      ...(expiresAt === undefined ? {} : { auth_expires_at: expiresAt }),
    };
  }

  /** The row for one session, or nothing for a sid this instance has never
   * seen live and does not hold in `last_live`.
   *
   * Where a session stands is read off the row by the contract's own `liveness`
   * rather than stated here (DR-0001 §2): an instance and a client that each
   * wrote that arithmetic would show the same row two ways. */
  row(sid: Sid, now: Timestamp = Date.now(), own: Own = this.#own()): PeerInfo | undefined {
    return this.#peerRow(sid, now, own);
  }

  /** Whether two or more processes are running this session, which is what the
   * ops that would act on it refuse with `session_duplicated` (DR-0001 §3).
   *
   * False for a sid this instance has no row for: what such a call meets is
   * the session not being here, which is the answer its own op already has. */
  duplicated(sid: Sid, own: Own = this.#own()): boolean {
    return duplicated(this.#runs(sid, own));
  }

  /** The harness's sessions as they are at this instant. One read serves one
   * question, and a caller answering several about the same instant passes the
   * result on rather than reading again. */
  #own(): Own {
    const scanned = this.#harness.rows();
    const terminals = this.#terminals;
    let rows = scanned;
    if (terminals !== undefined) {
      // What the scan found is what exists: a pid that has left it is one whose
      // terminal is no longer anybody's, and one that has arrived is read once.
      terminals.observe(scanned.keys());
      const named = new Map<number, AgentInfo>();
      for (const [pid, row] of scanned) {
        const terminal = terminals.get(pid);
        named.set(
          pid,
          terminal === undefined
            ? row
            : {
                ...row,
                // The scheme is what tells a client how to open it, and the
                // bare handle is what this instance types into (contract,
                // `terminalUrl`).
                terminal_id: statedTerminalId(terminal.id),
                ...(terminal.namespace === undefined
                  ? {}
                  : { terminal_namespace: terminal.namespace }),
              },
        );
      }
      rows = named;
    }
    const bySid = new Map<Sid, AgentInfo[]>();
    for (const row of rows.values()) {
      if (row.sid === undefined) continue;
      const held = bySid.get(row.sid);
      if (held === undefined) bySid.set(row.sid, [row]);
      else held.push(row);
    }
    return { rows, bySid, present: this.#harness.present() };
  }

  /** Every run of one session this instance can see, as the row states them.
   *
   * Three sources, in the order they become observable: the harness's state
   * files, the processes a launcher started before the harness wrote one, and
   * the connections. A process the launcher started that the harness has since
   * written a file for is one run and not two, which is what the pid is the key
   * of (DR-0001 §1). */
  #runs(sid: Sid, own: Own): SessionRun[] {
    const observed: ObservedRun[] = [];
    const seen = new Set<number>();
    for (const row of own.bySid.get(sid) ?? []) {
      seen.add(row.pid);
      observed.push({
        pid: row.pid,
        started_at: row.started_at,
        ...(row.terminal_id === undefined ? {} : { terminal_id: row.terminal_id }),
      });
    }
    for (const launch of this.deps.launches?.running() ?? []) {
      if (launch.sid !== sid || seen.has(launch.pid)) continue;
      seen.add(launch.pid);
      observed.push({
        pid: launch.pid,
        started_at: launch.started_at,
        ...(launch.terminal_id === undefined ? {} : { terminal_id: launch.terminal_id }),
      });
    }
    const held = this.#connected.get(sid);
    return runsOf(observed, new Set(held?.pids.keys()), held !== undefined);
  }

  /** What the session's fold is worth, which is the fold's own standing except
   * while two runs are writing it (contract, `SessionStatusStanding`). */
  #standing(sid: Sid, runs: readonly SessionRun[]): SessionStatusStanding {
    if (duplicated(runs)) return "frozen";
    return this.deps.transcript?.standing(sid) ?? "absent";
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

  /** Where a session's transcript is, as it announced it (DESIGN §4.2). Whoever
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
    const cwd = meta?.cwd ?? this.#own().bySid.get(sid)?.[0]?.cwd;
    // The container when the session named one, the working directory
    // otherwise — the same order `repo_root` is meant in (DESIGN §6.6).
    const root = meta?.repo_root ?? cwd;
    return {
      ...(root === undefined || root === "" ? {} : { root }),
      ...(cwd === undefined || cwd === "" ? {} : { cwd }),
    };
  }

  /** The runs of one session as they are right now, read rather than taken
   * from the watch's cache. What acts on a session's process resolves its pid
   * through this: the watch runs only while somebody is subscribed (DESIGN §6.3), and
   * a pid from a poll that has not run is a number belonging to nobody. */
  runsNow(sid: Sid): readonly SessionRun[] {
    return this.#runs(sid, this.#own());
  }

  /** Drop one entry from `last_live`, which is what
   * `session.forget` asks for. The removal touches that list alone:
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

  /** `session.stopping`: a session saying it is about to go, which is what
   * makes it Paused rather than Disappeared once it is gone (DESIGN §4.3).
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

  // --- UpstreamResource (DESIGN §6.3): the directory is read while, and only while,
  // somebody is subscribed to a topic that rests on it.

  start(topic: string): void {
    this.#wanted.add(topic);
    this.#harness.start();
  }

  stop(topic: string): void {
    this.#wanted.delete(topic);
    if (this.#wanted.size === 0) this.#harness.stop();
  }

  /** What a fresh subscriber is handed: every row, connected and lost alike.
   *
   * A frame of either topic carries the rows that changed, so the opening one
   * has to carry all of them — it is the only frame that states the rows a
   * subscriber was not there for. Stating them is also what the difference
   * after it is taken against: these rows are what the subscriber now holds,
   * and they are the same rows every earlier subscriber was brought up to by
   * the frames it has had. */
  snapshot(topic: string): readonly TopicValue[] {
    const now = Date.now();
    const own = this.#own();
    const data =
      topic === "agents"
        ? { agents: this.#sentAgents.stated(this.agentRows(own)), polled_at: now }
        : { peers: this.#sentPeers.stated(this.peerRows(now, own)) };
    return [{ instance: this.deps.self, data }];
  }

  /** Whether the directory watch is running, which is what "the subscription
   * drives the resource" means in practice. */
  get watching(): boolean {
    return this.#harness.running;
  }

  /** Every row `peers` states: what is live now, and what was live when this
   * instance last saw it. One kind of row rather than two lists, because
   * coming back and going quiet are the same row changing its `state` — a
   * client that held two lists would have to move an entry between them to
   * follow one field.
   *
   * Running is not the same as connected. A session the harness names is
   * running whether or not it ever greeted us, and it has to be on this list
   * for the same reason its runs are stated at all: a restart forgets every
   * greeting, and a list that showed only what had greeted this daemon would
   * show a host full of running sessions as empty.
   *
   * A lost session is a row here rather than a list of its own: its entry in
   * the store holds what was observed, and the two fields a row derives —
   * where it stands now, and whether it is pinned — are worked out at read
   * time (M4). */
  peerRows(now: Timestamp = Date.now(), own: Own = this.#own()): PeerInfo[] {
    return [
      ...[...this.#connected.values()].map((session) => this.#peer(session, own)),
      ...[...own.present]
        .filter((sid) => !this.#connected.has(sid))
        .map((sid) => this.#unconnected(sid, own)),
      ...this.#lastLive.entries(now).map((entry) => this.#lost(entry, own)),
    ];
  }

  /** One row of `peers`, for a producer that knows which session moved.
   *
   * The same three sources the list is built from, asked about one sid: a
   * connection here, a session the harness names, an entry among the sessions
   * this instance has lost. A sid none of them holds is one this instance has
   * no row for, and it says so rather than inventing one. */
  #peerRow(sid: Sid, _now: Timestamp, own: Own): PeerInfo | undefined {
    const held = this.#connected.get(sid);
    if (held !== undefined) return this.#peer(held, own);
    if (own.present.has(sid)) return this.#unconnected(sid, own);
    const entry = this.#lastLive.get(sid);
    return entry === undefined ? undefined : this.#lost(entry, own);
  }

  /** A session this instance has lost, as a row: what was observed of it,
   * with the fields a row derives worked out at read time (M4). */
  #lost(entry: StoredEntry, own: Own): PeerInfo {
    const runs = this.#runs(entry.sid, own);
    return {
      ...entry,
      runs,
      session_status: this.#standing(entry.sid, runs),
      pinned: this.#pinned(entry.sid),
    };
  }

  /** The gateway saw inference for one session again (DESIGN §4.2).
   *
   * What moved is one attribute of one row, so that row is what goes out. The
   * sessions domain is not recomputed for it: which sessions there are has not
   * changed, and the whole of that work would be spent to restate a clock.
   *
   * A sid this instance has no row for publishes nothing. The gateway sits
   * above every config home and its events name only a session id, so one
   * belonging to another config home must not become a row here — the same
   * narrowing the row's own reading of the gateway makes. */
  gatewayMoved(sid: Sid): void {
    const now = Date.now();
    const row = this.#peerRow(sid, now, this.#own());
    if (row === undefined) return;
    const peers = this.#sentPeers.diffRow(row) as PeerElement[];
    if (peers.length > 0) this.deps.publish("peers", { peers });
  }

  /** Every row `agents` states: one per process.
   *
   * The harness's own view, as it stated it, and beside it the processes a
   * launcher started that the harness has not written a file for yet. Those
   * carry no `sid` — the run is there, and which session it is running is not
   * settled until the greeting names it (DR-0001 §4) — and they leave the list
   * as soon as the state file arrives, since the row is then the harness's own
   * under the same pid. */
  agentRows(own: Own = this.#own()): AgentInfo[] {
    const rows = [...own.rows.values()];
    for (const launch of this.deps.launches?.running() ?? []) {
      if (own.rows.has(launch.pid)) continue;
      rows.push({
        instance: this.deps.self,
        pid: launch.pid,
        cwd: launch.cwd,
        // The launcher's own word for a process whose session the harness has
        // not named. `kind` is an open set (contract, `AgentInfo`), and no
        // value of the harness's own would be true of this row yet.
        kind: LAUNCHED,
        started_at: launch.started_at,
        config_dir: this.deps.configHome,
        ...(launch.sid === undefined ? {} : { sid: launch.sid }),
        ...(launch.terminal_id === undefined ? {} : { terminal_id: launch.terminal_id }),
      });
    }
    return rows;
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
  private async register(sid: Sid, args: HelloSessionArgs): Promise<void> {
    const stated = await metaOf(this.deps, args, (refused) => {
      this.deps.log?.("transcript_path not taken", { sid, path: args.transcript_path, refused });
    });
    // Read after the path has been settled, so that what this writes is built
    // on the session as it stands now rather than as it stood before.
    const held = this.#connected.get(sid);
    const now = Date.now();
    const meta = { ...this.#stated.get(sid), ...stated };
    const pids = held?.pids ?? new Map<number, number>();
    if (args.pid !== undefined) {
      pids.set(args.pid, (pids.get(args.pid) ?? 0) + 1);
      // The run a launcher started and the session that greeted from it are one
      // thing, and this is the only moment the two are named together.
      this.deps.launches?.tie(args.pid, sid);
    }
    this.#connected.set(sid, {
      sid,
      connected_at: held?.connected_at ?? now,
      protocol_version: args.protocol_version,
      ...(args.client_version === undefined ? {} : { client_version: args.client_version }),
      meta,
      last_activity_at: now,
      conns: (held?.conns ?? 0) + 1,
      pids,
    });
    this.#stated.set(sid, meta);
    this.#lastLive.remove(sid);
    this.changed(now);
  }

  /** One of a session's connections closed. The session is only gone when its
   * last one is. */
  private release(sid: Sid, pid?: number): void {
    const held = this.#connected.get(sid);
    if (held === undefined) return;
    if (pid !== undefined) {
      const left = (held.pids.get(pid) ?? 0) - 1;
      if (left > 0) held.pids.set(pid, left);
      else held.pids.delete(pid);
    }
    if (held.conns > 1) {
      this.#connected.set(sid, { ...held, conns: held.conns - 1 });
      this.changed();
      return;
    }
    this.#connected.delete(sid);
    this.changed();
  }

  /** Recompute, record what stopped being live, and state what moved on both
   * topics.
   *
   * Both carry the rows that changed, so what is published is the difference
   * against what was last published rather than the whole list: a session
   * whose inference just ran is one row, and restating every row to say so
   * would send a list to report one field. A recompute that found nothing
   * different publishes nothing — the suppression every topic shares (M5) is
   * whole-value and cannot drop a frame of elements, so the diff is where a
   * repeat stops here. */
  private changed(now: Timestamp = Date.now()): void {
    const own = this.#own();
    const live = this.#liveNow(now, own);
    for (const [sid, entry] of this.#live) {
      if (live.has(sid)) continue;
      // The declaration came first and the departure has now arrived, which is
      // the order the two are one event in (contract, `session.stopping`).
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
    const rows = this.peerRows(now, own);
    // Whether a session is one two processes are writing is settled here, and
    // the reading of its transcript follows from it: while it is, nothing of
    // the file is read and the last value that could be trusted is what stands
    // (DR-0001 §3). Told before the rows go out, so what a subscriber reads as
    // `frozen` is a session whose fold has already stopped moving.
    for (const row of rows) this.deps.transcript?.duplicated(row.sid, duplicated(row.runs));
    const peers = this.#sentPeers.diff(rows) as PeerElement[];
    if (peers.length > 0) this.deps.publish("peers", { peers });
    const agents = this.#sentAgents.diff(this.agentRows(own)) as AgentElement[];
    if (agents.length > 0) this.deps.publish("agents", { agents, polled_at: now });
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
    const row = own.bySid.get(sid)?.[0];
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

  #peer(session: Connected, own: Own): PeerInfo {
    // The two "last activity" values are different questions (DESIGN §4.4): the one
    // above moves on every request the session makes, this one only when a
    // person speaks, and the fold is the only place that knows the second.
    const userInput = this.deps.transcript?.facts(session.sid).last_user_input_at;
    // What the gateway last saw run for this session: an attribute of the row
    // beside the runs, not folded into them (DESIGN §4.2). Absent from an
    // instance with no gateway, where nothing observes inference at all.
    const gatewayActiveAt = this.#gatewayActiveAt(session.sid, own.present.has(session.sid));
    const runs = this.#runs(session.sid, own);
    return {
      sid: session.sid,
      instance: this.deps.self,
      ...this.#where(session.sid, own),
      runs,
      session_status: this.#standing(session.sid, runs),
      pinned: this.#pinned(session.sid),
      connected_at: session.connected_at,
      last_activity_at: session.last_activity_at,
      ...(userInput === undefined ? {} : { last_user_input_at: userInput }),
      ...(gatewayActiveAt === undefined ? {} : { gateway_active_at: gatewayActiveAt }),
      ...(session.client_version === undefined ? {} : { client_version: session.client_version }),
      protocol_version: session.protocol_version,
    };
  }

  /** A session the harness names that holds no connection here (DESIGN §4.2).
   *
   * It is on the same list as the connected ones because it is running in the
   * same sense: what separates them is the `runs` each row states, and a client
   * reads that off the row (DR-0001 §2). What it cannot carry is everything a
   * greeting states — the session never said where it works, so the working
   * directory comes from the harness's own row and the display names it does
   * not know are simply absent.
   *
   * The connection fields go with the connection: `connected_at`,
   * `last_activity_at` and the client's build and generation are things about a
   * client of this session, and there is none. */
  #unconnected(sid: Sid, own: Own): PeerInfo {
    const row = own.bySid.get(sid)?.[0];
    const userInput = this.deps.transcript?.facts(sid).last_user_input_at;
    const gatewayActiveAt = this.#gatewayActiveAt(sid, true);
    const runs = this.#runs(sid, own);
    return {
      sid,
      instance: this.deps.self,
      // The harness knows a title for a session that stated none itself, and
      // what the session said about itself overrides it.
      ...(row?.name === undefined ? {} : { title: row.name }),
      ...this.#where(sid, own),
      runs,
      session_status: this.#standing(sid, runs),
      pinned: this.#pinned(sid),
      ...(userInput === undefined ? {} : { last_user_input_at: userInput }),
      ...(gatewayActiveAt === undefined ? {} : { gateway_active_at: gatewayActiveAt }),
    };
  }

  /** When the gateway last saw inference for a session, for a session this
   * instance knows (DESIGN §4.2).
   *
   * The gateway sits above every config home and its events name only a session
   * id, so what it reports is not by itself evidence about *this* instance's
   * sessions: a session id belonging to another config home would otherwise
   * classify as live here, put a row on this instance's `peers`, and make
   * `message.send` accept a message for a session that has no inbox here and
   * never will. So the reading is narrowed to the sids this instance knows —
   * one that has greeted us, still connected or remembered in `last_live`, or
   * one the harness's own `sessions/` names. The events themselves are not
   * dropped: `llm.requests` carries what the gateway saw whoever it was for,
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
   * goes for `repo_root`, which DESIGN §6.6 says to derive from `cwd` when it is not
   * given — no primary source states that derivation, so it is left unstated
   * until one does. */
  #where(
    sid: Sid,
    own: Own,
  ): Pick<PeerInfo, "repo" | "ws" | "cwd" | "transcript_path" | "repo_root" | "branch" | "title"> {
    const meta = this.#stated.get(sid) ?? {};
    const cwd = meta.cwd ?? own.bySid.get(sid)?.[0]?.cwd ?? "";
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
async function metaOf(
  deps: Pick<SessionsDeps, "configHome" | "harness">,
  args: HelloSessionArgs,
  refused: (reason: string) => void,
): Promise<SessionMeta> {
  const meta: Record<string, string> = {};
  for (const field of META_FIELDS) {
    const value = args[field];
    if (value === undefined) continue;
    if (field === "transcript_path") {
      const taken = await ownTranscript(value, deps);
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
async function ownTranscript(
  named: string,
  deps: Pick<SessionsDeps, "configHome" | "harness">,
): Promise<string | Refused> {
  if (!isAbsolute(named)) return { refused: "not an absolute path" };
  let tree: string | undefined;
  try {
    const home = await realpath(deps.configHome);
    tree = await resolveAsFarAsItGoes(join(home, HARNESS[deps.harness].transcripts));
  } catch {
    return { refused: "the config home is not there" };
  }
  const settled = await resolveAsFarAsItGoes(named);
  if (tree === undefined || settled === undefined || !within(settled, tree)) {
    return { refused: "outside this config home's transcript tree" };
  }
  const known = await stated(settled);
  if (known !== undefined && !known.isFile()) return { refused: "not a file" };
  return settled;
}

/** What is at a path, or nothing where there is nothing at it. */
async function stated(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path);
  } catch {
    return undefined;
  }
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
async function resolveAsFarAsItGoes(path: string): Promise<string | undefined> {
  const unwritten: string[] = [];
  let at = path;
  for (;;) {
    try {
      return join(await realpath(at), ...unwritten);
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
