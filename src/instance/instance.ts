import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import {
  type Capability,
  type InstanceId,
  type InstancePingResult,
  type RestartingEvent,
  type Sid,
  type Timestamp,
} from "@ccmsg/protocol";
import {
  dispatch,
  type DispatchResult,
  failure,
  type Handlers,
  type Requester,
} from "../dispatch/index.ts";
import {
  ClaudeCodeSocketRoute,
  Delivery,
  DisabledDirectRoute,
  inboxPath,
  messagingHandlers,
} from "../messaging/index.ts";
import { Inbox } from "../messaging/inbox.ts";
import { Sessions, SessionStatus } from "../sessions/index.ts";
import { topicHandlers, Topics } from "../topics/index.ts";
import { Transcripts } from "../transcript/index.ts";
import {
  ConnRegistry,
  type EntryPolicy,
  listenUds,
  serveWs,
  Transport,
} from "../transport/index.ts";
import { type InstanceConfig, loadConfig } from "./config.ts";
import { completeHandlers } from "./handlers.ts";
import { acquireLock, type Held, isHeldByUs, type Lock } from "./lock.ts";
import { Log } from "./log.ts";
import { prepareSocketDir, publishSocket, sweepOrphanSockets } from "./socket.ts";
import { type Env, type InstancePaths, resolvePaths } from "./paths.ts";

/** The daemon build, as `hello` and `instance_ping` report it. */
const VERSION = "0.0.1";

export interface StartOptions {
  readonly env?: Env;
  /** Mirror the log to stderr. A foreground run wants it; a test does not. */
  readonly echoLog?: boolean;
  /** Overrides the confirmation poll of the sessions watch, for tests. */
  readonly pollMs?: number;
}

/** Startup found another instance already serving this config home. Nothing
 * was created and nothing has to be undone (§8.3 step 2). */
export interface AlreadyRunning {
  readonly kind: "already_running";
  readonly pid: number;
}

export type StartOutcome = Instance | AlreadyRunning;

export function isRunning(outcome: StartOutcome): outcome is Instance {
  return outcome instanceof Instance;
}

/** Start one instance, in the order of §8.3.
 *
 * The order is the point of this function: the lock before anything is
 * created, the config before anything is derived from it, the pid before the
 * listeners so a file naming this process exists by the time anything can
 * connect to it, and the dial last. */
export async function start(options: StartOptions = {}): Promise<StartOutcome> {
  // 1. paths, and the directory the rest of them live in
  const paths = resolvePaths(options.env ?? process.env);
  mkdirSync(paths.stateDir, { recursive: true });

  // 2. the single instance. A previous run's file with nobody behind it is
  // taken over inside `acquireLock`; a live holder ends the start here.
  const lock = acquireLock(paths.lockFile);
  if (!isHeldByUs(lock)) {
    return { kind: "already_running", pid: (lock as Held).pid };
  }

  const log = new Log(paths.logFile, options.echoLog ?? true);
  try {
    // 3. the config. A broken one ends the start rather than turning the
    // setting it carried silently off (DV-Q9).
    const config = loadConfig(paths.configFile);
    // 4-7 are the instance's own construction and listen.
    const instance = new Instance(paths, config, lock, log, options.pollMs);
    await instance.listen();
    return instance;
  } catch (cause) {
    log.write("startup failed", { error: String(cause) });
    lock.release();
    throw cause;
  }
}

/** One running instance: the layers wired together, and the two lifecycle
 * orders of §8.3 and §8.5. */
export class Instance {
  readonly self: InstanceId;
  readonly startedAt: Timestamp = Date.now();
  readonly #conns = new ConnRegistry();
  readonly #transport = new Transport();
  readonly #topics: Topics;
  readonly #sessions: Sessions;
  readonly #status: SessionStatus;
  readonly #transcripts: Transcripts;
  readonly #delivery: Delivery;
  readonly #handlers: Handlers;
  readonly #capabilities: ReadonlySet<Capability>;
  /** Set the moment shutdown starts, which is the re-entry guard of §8.5 step
   * 1: a request arriving after it is refused rather than half-served. */
  #stopping = false;
  #stopped: Promise<void> | undefined;
  /** Resolved once the stop order has run to the end, so a foreground run has
   * something to wait on that does not depend on what asked it to stop. */
  readonly #done = Promise.withResolvers<void>();

  constructor(
    readonly paths: InstancePaths,
    readonly config: InstanceConfig,
    private readonly lock: Lock,
    private readonly log: Log,
    pollMs?: number,
  ) {
    // 5. `self`. §7.1 settles this by asking the peers who they cannot see,
    // and there is no mesh yet, so it is derived from where this instance
    // listens — unique per config home either way, which is what the rest of
    // the instance uses it for. The derivation is replaced, not extended, when
    // §7.1 lands.
    this.self = selfId(paths.key, config);
    // Nothing is configured that would grant one yet: every capability in the
    // contract rests on an upstream this instance does not reach.
    this.#capabilities = new Set();
    this.#topics = new Topics(this.self, this.#capabilities);

    // The transcript tails and their folds. Built before the sessions domain
    // and reading from it lazily: the fold is one of the sessions domain's
    // inputs (§5.1) while the path to follow is one of its outputs, and the
    // two meet at the moment a tail starts rather than at construction.
    this.#transcripts = new Transcripts({
      self: this.self,
      pathOf: (sid) => this.#sessions.transcriptPath(sid),
      publish: (topic, data) => {
        this.#topics.publish(topic, data);
      },
      onFacts: () => {
        this.#sessions.refresh();
      },
      ...(pollMs === undefined ? {} : { pollMs }),
    });

    // 4. `last_live`, read by the sessions domain as it is constructed.
    this.#sessions = new Sessions({
      self: this.self,
      configHome: paths.configHome,
      stateDir: paths.stateDir,
      capabilities: [...this.#capabilities],
      version: VERSION,
      startedAt: this.startedAt,
      publish: (topic, data) => {
        this.#topics.publish(topic, data);
      },
      transcript: this.#transcripts,
      onChanged: () => {
        this.#status.refresh();
      },
      ...(pollMs === undefined ? {} : { pollMs }),
    });

    // The topics whose value is the fold's error state, over the sessions the
    // instance holds. They are the other thing that keeps a tail running: a
    // subscriber watching the list of stopped sessions is watching every
    // session's fold, and the tails behind it run only while it does (§6.3).
    this.#status = new SessionStatus({
      self: this.self,
      sessions: () => this.#sessions.connectedSids(),
      facts: (sid) => this.#transcripts.facts(sid),
      hold: (sid) => {
        this.#transcripts.hold(sid);
      },
      release: (sid) => {
        this.#transcripts.release(sid);
      },
      publish: (topic, data) => {
        this.#topics.publish(topic, data);
      },
    });

    const inbox = new Inbox(inboxPath(paths.stateDir));
    inbox.load();
    this.#delivery = new Delivery({
      self: this.self,
      sessions: this.#sessions,
      inbox,
      direct: config.direct_delivery
        ? new ClaudeCodeSocketRoute({ configHome: paths.configHome })
        : new DisabledDirectRoute(),
      publish: (topic, data, instance, to) => {
        this.#topics.publish(topic, data, instance, to);
      },
      listeners: (topic, to) => this.#topics.subscriberCount(topic, to),
    });

    this.#topics.attach("peers", this.#sessions);
    this.#topics.attach("agents", this.#sessions);
    this.#topics.attach("inbox", this.#delivery);
    this.#topics.attach("transcript", this.#transcripts);
    this.#topics.attach("session_status", this.#status);
    this.#topics.attach("session_errors", this.#status);

    this.#handlers = completeHandlers({
      hello: this.#sessions.hello,
      ...topicHandlers(this.#topics),
      ...messagingHandlers(this.#delivery),
      instance_ping: (): InstancePingResult => this.ping(),
      instance_shutdown: () => {
        // The reply goes out when this handler's value reaches the driver, so
        // stopping is deferred past that turn of the loop rather than run
        // here — the caller is told the request was accepted, which is what
        // the contract says this op answers.
        setTimeout(() => void this.stop(), 0);
        return {};
      },
    });
  }

  /** 6-7 of §8.3: the pid, then the listeners with the unix socket first, then
   * the peers. */
  async listen(): Promise<void> {
    // Before any listener: a client that can connect can always find the
    // process behind the socket.
    writeFileSync(this.paths.pidFile, `${process.pid}\n`);
    prepareSocketDir(this.paths);
    // What a killed run left behind, cleared before this one adds its own.
    sweepOrphanSockets(this.paths);
    this.#transport.add(
      listenUds({
        path: this.paths.socketReal,
        conns: this.#conns,
        handle: (frame, conn) => this.handle(frame, conn),
      }),
    );
    // The address clients use, moved onto this process once it is accepting.
    publishSocket(this.paths);
    if (this.config.entry !== undefined) {
      this.#transport.add(
        serveWs({
          hostname: this.config.entry.host,
          port: this.config.entry.port,
          conns: this.#conns,
          handle: (frame, conn) => this.handle(frame, conn),
          entry: entryPolicy(this.config),
        }),
      );
    }
    // 7. Dialling the peers is the mesh's, and there is none: the endpoints
    // are read and held, and nothing connects to them.
    await Promise.resolve();
    this.log.write("started", {
      instance: this.self,
      pid: process.pid,
      socket: this.paths.socket,
      http: this.http,
      peers: this.config.peers.length,
    });
  }

  /** Every bound WebSocket address, as `host:port`. */
  get http(): string[] {
    return this.#transport.listeners.filter((l) => l.kind === "ws").map((l) => l.address);
  }

  get socketPath(): string {
    return this.paths.socket;
  }

  /** Whether the sessions watch is running. It is driven by subscription
   * (§6.3), so this is how "the upstream watches stopped" is observable from
   * outside the domain that owns them. */
  get watching(): boolean {
    return this.#sessions.watching;
  }

  /** A session said it was stopping, which is what makes it Paused rather than
   * Disappeared once it is gone (§5.2). Nothing on the wire says this yet;
   * the sessions domain is where it is recorded. */
  markStopped(sid: Sid): boolean {
    return this.#sessions.markStopped(sid);
  }

  ping(): InstancePingResult {
    return {
      instance: this.self,
      version: VERSION,
      pid: process.pid,
      started_at: this.startedAt,
      clients: this.#conns.size,
      exe: process.execPath,
      ...(process.argv[1] === undefined ? {} : { script: process.argv[1] }),
      http: this.http,
      // Nothing watches the host link yet, so the instance says it does not
      // know rather than reporting a state it never checked.
      network: "unknown",
    };
  }

  /** One frame, from either transport. The re-entry guard of §8.5 step 1 sits
   * here because this is the single door every request comes through. */
  handle(frame: unknown, conn: Requester): Promise<DispatchResult> {
    if (this.#stopping) {
      return Promise.resolve(
        failure(requestIdOf(frame), "bad_request", `${this.self} is shutting down`),
      );
    }
    return dispatch(frame, conn, {
      self: this.self,
      capabilities: this.#capabilities,
      // Nothing routes to another instance yet: every subject this instance
      // can name belongs to it, and the `peers` topic that would say otherwise
      // (§7.3) carries only its own sessions.
      resolveInstance: () => undefined,
      handlers: this.#handlers,
    });
  }

  /** Stop, in the order of §8.5. Repeating it waits for the first one. */
  stop(): Promise<void> {
    this.#stopped ??= this.#stop().finally(() => {
      this.#done.resolve();
    });
    return this.#stopped;
  }

  /** Resolves when this instance has finished leaving, however that was
   * asked for — the op, a signal, or a direct call. */
  whenStopped(): Promise<void> {
    return this.#done.promise;
  }

  async #stop(): Promise<void> {
    // 1. refuse new work
    this.#stopping = true;
    // 2. stop the upstream watches. They run only while something is
    // subscribed (§6.3), so dropping the subscriptions is what stops them.
    for (const conn of this.#conns) this.#topics.dropAll(conn);
    // A tail may also be held for a value this instance states rather than for
    // a subscriber, and those holds end here.
    this.#transcripts.stopAll();
    // 3. tell the connections, while they can still be told
    const restarting: RestartingEvent = { ev: "restarting", instance: this.self };
    for (const conn of this.#conns) conn.send(restarting);
    // 4. settle what is persisted. `last_live` and the inbox are written as
    // they change rather than at exit, so there is nothing held back to flush;
    // the log's writer is synchronous for the same reason (§3.6).
    this.log.write("stopping", { instance: this.self });
    // 5. let the resources go, the unix socket last. The pid and the lock go
    // before it, because a client reads a refusing socket as this instance
    // having finished leaving and a successor may claim what it sees free.
    remove(this.paths.pidFile);
    this.lock.release();
    // Closing takes the path this process bound, and only that one: the stable
    // address is a symlink nothing here touches, because a successor may have
    // already pointed it at itself (§8.5).
    await this.#transport.close();
  }
}

/** The instance's own id, until §7.1 derives it from the peers.
 *
 * A WebSocket URL because that is what an `InstanceId` is on the wire. When
 * this instance serves HTTP the bound address is the honest one; when it
 * serves only the unix socket there is no address to name, and the config
 * home's key stands in — unique per instance, which is what everything below
 * mesh needs it for. */
function selfId(key: string, config: InstanceConfig): InstanceId {
  const entry = config.entry;
  if (entry === undefined || entry.port === 0) return `ws://localhost/${key}`;
  return `ws://${entry.host}:${entry.port}`;
}

/** Who may reach the WebSocket at all (§3.1). Both lists come from config and
 * an empty one means "no restriction beyond the bind itself". */
function entryPolicy(config: InstanceConfig): EntryPolicy {
  const entry = config.entry;
  if (entry === undefined) return {};
  return {
    allowRequest(request: Request): boolean {
      const origin = request.headers.get("origin");
      if (entry.origins.length > 0 && (origin === null || !entry.origins.includes(origin))) {
        return false;
      }
      if (entry.source_ips.length === 0) return true;
      // Bun states the peer address on the request when it has one; a
      // connection whose address cannot be read is refused rather than let
      // through an allowlist it was never compared against.
      const source = sourceIp(request);
      return source !== undefined && entry.source_ips.includes(source);
    },
  };
}

function sourceIp(request: Request): string | undefined {
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim();
}

function requestIdOf(frame: unknown): string | undefined {
  if (typeof frame !== "object" || frame === null) return undefined;
  const id = (frame as Record<string, unknown>)["request_id"];
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function remove(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // Already gone.
  }
}
