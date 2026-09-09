import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Capability,
  type Endpoint,
  type InstanceId,
  type InstancePingResult,
  type NetOnlineEvent,
  type RestartingEvent,
  type Sid,
  type Timestamp,
} from "@ccmsg/protocol";
import {
  callerOf,
  CallerError,
  callerOfIdentity,
  dispatch,
  type DispatchResult,
  failure,
  type Handlers,
  type Requester,
} from "../dispatch/index.ts";
import {
  Containment,
  fileHandlers,
  sandboxCapabilities,
  SandboxGrants,
  sandboxHandlers,
  type SessionRoots,
} from "../files/index.ts";
import {
  ClaudeCodeSocketRoute,
  Delivery,
  DisabledDirectRoute,
  type DirectRoute,
  inboxPath,
  messagingHandlers,
  Notify,
  sessionLabel,
} from "../messaging/index.ts";
import { Inbox } from "../messaging/inbox.ts";
import {
  hostProcessDeps,
  hostTerminalReader,
  sessionCapabilities,
  sessionHandlers,
  SessionProcesses,
  Sessions,
  sessionStatusOf,
  SessionStatus,
} from "../sessions/index.ts";
import { topicHandlers, Topics } from "../topics/index.ts";
import { TranscriptFiles, Transcripts } from "../transcript/index.ts";
import {
  ConnRegistry,
  type EntryPolicy,
  type Listener,
  listenUds,
  serveWs,
  Transport,
  type UpgradeDecision,
} from "../transport/index.ts";
import { Mesh, MESH_PROTOCOL } from "../mesh/index.ts";
import {
  Gateway,
  gatewayCapabilities,
  gatewayHandlers,
  type GatewaySetup,
  gatewaySetup,
} from "../upstream/index.ts";
import { KV_DIR, kvHandlers, KvStore } from "../kv/index.ts";
import { Launcher, launcherCapabilities, launcherHandlers } from "../launcher/index.ts";
import {
  Translate,
  translateCapabilities,
  translateHandlers,
  translateSetup,
} from "../translate/index.ts";
import { type EntryConfig, type InstanceConfig, loadConfig } from "./config.ts";
import { completeHandlers } from "./handlers.ts";
import { acquireLock, type Held, isHeldByUs, type Lock } from "./lock.ts";
import { Log } from "./log.ts";
import { prepareSocketDir, publishSocket, sweepOrphanSockets } from "./socket.ts";
import { instanceIdentity } from "./identity.ts";
import { type Env, type InstancePaths, resolvePaths } from "./paths.ts";
import { VERSION } from "../version.ts";

export interface StartOptions {
  readonly env?: Env;
  /** Mirror the log to stderr. A foreground run wants it; a test does not. */
  readonly echoLog?: boolean;
  /** Overrides the confirmation poll of the sessions watch, for tests. */
  readonly pollMs?: number;
  /** Overrides the mesh's own intervals, for a test that cannot wait out a
   * heartbeat or a reconnection backoff. */
  readonly meshTiming?: MeshTiming;
}

/** The mesh intervals a caller may shorten. The values themselves, and why they
 * are what they are, belong to the mesh (§8.2, §8.3). */
export interface MeshTiming {
  readonly heartbeatMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly reconnectMinMs?: number;
  readonly forwardTimeoutMs?: number;
  /** The clock the retention window of §7.5 is read against, so a test can
   * pass it without waiting a week. */
  readonly now?: () => Timestamp;
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
  const env = options.env ?? process.env;
  const paths = resolvePaths(env);
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
    const config = loadConfig(paths.configFile, paths.configHome);
    // What the config says of the gateway, resolved before anything is built
    // from it: a webhook source whose secret cannot be read ends the start
    // here, for the same reason a broken config does (DV-Q9).
    const gateway = gatewaySetup(config.upstream, paths.configFile, env);
    // The translation helper, checked the same way and for the same reason: a
    // program that was named and cannot be run is a setting that cannot be
    // honoured (DV-Q9).
    const helper = translateSetup(config.upstream, paths.configFile);
    // 4. this instance's identity, written the first time it is asked for.
    //
    // Before anything derived from it: `mid`, the store's keys and `last_live`
    // are all keyed by it, and a config home started here for the first time —
    // `daemon run` on one the shared file does not list — gets its id now
    // rather than from an `add` that never happened (DR-0001 §2.1).
    const id = instanceIdentity(paths.instanceIdFile);
    // 5. the endpoint list, for an instance that has a mesh.
    //
    // `self` is configured, so nothing has to be settled; what the probe does
    // is check it, and it has to arrive at a listener — so the WebSocket is
    // bound here and handed to the instance. A `self` that answers as somebody
    // else ends the start.
    const mesh = meshFor(id, config, log, options.meshTiming);
    const wiring = mesh === undefined ? undefined : await bindForMesh(config, mesh);
    // 6-8 are the instance's own construction and listen.
    const instance = new Instance(
      paths,
      config,
      id,
      lock,
      log,
      options.pollMs,
      gateway,
      helper,
      wiring,
    );
    wiring?.attach(instance);
    await instance.listen();
    return instance;
  } catch (cause) {
    log.write("startup failed", { error: String(cause) });
    lock.release();
    throw cause;
  }
}

/** The mesh, on an instance configured for one.
 *
 * Two things have to be true: peers to dial, and an address they can dial back.
 * An instance serving only the unix socket is reachable by nothing on another
 * host, so a peer list on one is a setting with no effect rather than a mesh. */
function meshFor(
  id: InstanceId,
  config: InstanceConfig,
  log: Log,
  timing?: MeshTiming,
): Mesh | undefined {
  if (config.peers.length === 0 || config.entry === undefined || config.self === undefined) {
    return undefined;
  }
  return new Mesh({
    id,
    self: config.self,
    peers: config.peers,
    conns: new ConnRegistry(),
    log: (msg, fields) => {
      log.write(msg, fields);
    },
    ...timing,
  });
}

/** What an instance is handed when its listener had to exist before it did.
 *
 * The connection registry is shared rather than copied: a connection accepted
 * during self-identification is one of the instance's, and two registries would
 * mean the stop order (§8.5 step 3) reaching only one of them. */
export interface MeshWiring {
  readonly conns: ConnRegistry;
  readonly ws: Listener;
  readonly mesh: Mesh;
  /** Point the listener at the instance, once there is one. */
  attach(instance: Instance): void;
}

/** Bind the WebSocket, settle `self` against the peer list, and hand both on.
 *
 * The listener answers the two pre-authentication routes from the moment it is
 * up — the probe of self-identification and the key of mesh-peer-auth §6 — and
 * refuses everything else until the instance exists, which is a window of one
 * round of probes. */
async function bindForMesh(config: InstanceConfig, mesh: Mesh): Promise<MeshWiring> {
  const entry = config.entry as EntryConfig;
  let instance: Instance | undefined;
  const ws = serveWs({
    hostname: entry.host,
    port: entry.port,
    conns: mesh.conns,
    handle: (frame, conn) =>
      instance === undefined
        ? Promise.resolve(failure(undefined, "internal_error", "this instance is still starting"))
        : instance.handle(frame, conn),
    entry: entryPolicy(config, true),
    route: async (request) => (await mesh.route(request)) ?? (await instance?.route(request)),
    onConn: (conn, info) => {
      mesh.accept(conn, info);
    },
  });
  try {
    await mesh.verify();
  } catch (cause) {
    // The listener is bound before the endpoint list is checked, so it is this
    // function's to release when the check refuses — nothing else holds it yet,
    // and a port left bound by a refused start is one the next start cannot
    // have.
    await ws.close();
    throw cause;
  }
  return {
    conns: mesh.conns,
    ws,
    mesh,
    attach(built: Instance): void {
      instance = built;
    },
  };
}

/** One running instance: the layers wired together, and the two lifecycle
 * orders of §8.3 and §8.5. */
export class Instance {
  readonly startedAt: Timestamp = Date.now();
  readonly #conns: ConnRegistry;
  /** The mesh, on an instance configured for one (§7). */
  readonly #mesh: Mesh | undefined;
  /** The WebSocket listener, when it had to be bound before this instance
   * existed so that self-identification could reach it. */
  readonly #boundWs: Listener | undefined;
  readonly #transport = new Transport();
  readonly #topics: Topics;
  readonly #sessions: Sessions;
  readonly #status: SessionStatus;
  readonly #transcripts: Transcripts;
  readonly #gateway: Gateway;
  readonly #delivery: Delivery;
  readonly #direct: DirectRoute;
  readonly #notify: Notify;
  readonly #translate: Translate | undefined;
  readonly #handlers: Handlers;
  readonly #capabilities: ReadonlySet<Capability>;
  /** Set the moment shutdown starts, which is the re-entry guard of §8.5 step
   * 1: a request arriving after it is refused rather than half-served. */
  #stopping = false;
  #stopped: Promise<void> | undefined;
  /** The link state the last `net_online` announced, so the event marks a
   * change rather than repeating what every client already holds. */
  #announced: boolean | undefined;
  /** Resolved once the stop order has run to the end, so a foreground run has
   * something to wait on that does not depend on what asked it to stop. */
  readonly #done = Promise.withResolvers<void>();

  constructor(
    readonly paths: InstancePaths,
    readonly config: InstanceConfig,
    /** What this instance is called, everywhere and to everyone (DR-0001
     * §2.1). Read from the state directory, so it survives the instance moving
     * to another host or another URL. */
    readonly self: InstanceId,
    private readonly lock: Lock,
    private readonly log: Log,
    pollMs?: number,
    setup: GatewaySetup = {},
    helper?: string,
    wiring?: MeshWiring,
  ) {
    this.#conns = wiring?.conns ?? new ConnRegistry();
    this.#mesh = wiring?.mesh;
    this.#boundWs = wiring?.ws;
    // Every capability rests on an upstream, so what is configured is what
    // this instance can name. A client is told before it subscribes, rather
    // than being refused when it does.
    this.#capabilities = new Set([
      ...gatewayCapabilities(setup),
      ...sandboxCapabilities(config.upstream.sandbox_origin),
      ...launcherCapabilities(config.upstream.launcher),
      ...translateCapabilities(helper),
      ...sessionCapabilities({
        fork_origin: config.fork_origin,
        ...(config.upstream.terminal_gateway === undefined
          ? {}
          : { terminal_gateway: config.upstream.terminal_gateway }),
      }),
    ]);
    // The mesh is the rest of the cluster as the topic mechanism sees it: what
    // the peers have stated, and where a local subscription has to travel to
    // (§7.4). An instance without one has no other instance to hear from.
    this.#topics = new Topics(this.self, this.#capabilities, this.#mesh);
    this.#mesh?.bind({
      handle: (frame, conn) => this.handle(frame, conn),
      publish: (topic, data, instance) => {
        this.#topics.publish(topic, data, instance);
      },
      // What `peers` says about the instances is this instance's own view, so
      // it is restated when that view moves (§7.5).
      changed: () => {
        this.#sessions.refresh();
        this.#linkMoved();
      },
    });

    // What the gateway saw. It feeds two topics and one input of the sessions
    // domain (§5.1), so it is built before both.
    this.#gateway = new Gateway({
      self: this.self,
      setup,
      publish: (topic, data) => {
        this.#topics.publish(topic, data);
      },
      onActivity: () => {
        this.#sessions.refresh();
      },
      log: (msg, fields) => {
        this.log.write(msg, fields);
      },
    });

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

    // 6. `last_live` and the inbox, read as the domains are constructed.
    this.#sessions = new Sessions({
      self: this.self,
      endpoint: selfEndpoint(paths.key, config),
      configHome: paths.configHome,
      stateDir: paths.stateDir,
      capabilities: [...this.#capabilities],
      version: VERSION,
      startedAt: this.startedAt,
      publish: (topic, data) => {
        this.#topics.publish(topic, data);
      },
      transcript: this.#transcripts,
      gateway: this.#gateway,
      terminals: hostTerminalReader(),
      ...(this.#mesh === undefined ? {} : { mesh: this.#mesh }),
      onChanged: () => {
        this.#status.refresh();
        // A session that is live again is one route (a) can be tried against,
        // which is what the inbox is waiting for (§4.3).
        void this.#delivery.retry();
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
      where: (sid) => this.#sessions.where(sid),
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
    this.#direct = config.direct_delivery
      ? new ClaudeCodeSocketRoute({ configHome: paths.configHome })
      : new DisabledDirectRoute();
    this.#delivery = new Delivery({
      self: this.self,
      sessions: this.#sessions,
      ...(this.#mesh === undefined ? {} : { cluster: this.#mesh }),
      inbox,
      direct: this.#direct,
      publish: (topic, data, instance, to) => {
        this.#topics.publish(topic, data, instance, to);
      },
      listeners: (topic, to) => this.#topics.subscriberCount(topic, to),
    });

    this.#notify = new Notify({
      self: this.self,
      label: (sid) => sessionLabel(this.#sessions, sid),
      publish: (topic, data, instance) => {
        this.#topics.publish(topic, data, instance);
      },
    });

    this.#topics.attach("peers", this.#sessions);
    this.#topics.attach("agents", this.#sessions);
    this.#topics.attach("inbox", this.#delivery);
    this.#topics.attach("notify", this.#notify);
    this.#topics.attach("transcript", this.#transcripts);
    this.#topics.attach("session_status", this.#status);
    this.#topics.attach("session_errors", this.#status);
    this.#topics.attach("llm_requests", this.#gateway.requests);
    this.#topics.attach("llm_status", this.#gateway.statusResource);

    // The one thing here that is written down and is nobody's derived value
    // (§3.6): what a person saved through a client, which no other party holds
    // a copy of. It owns `kv:<ns>` and is the only publisher of it.
    const kv = new KvStore(join(paths.stateDir, KV_DIR), this.self, (topic, data) => {
      this.#topics.publish(topic, data);
    });
    this.#topics.attach("kv", kv);

    // The upstreams that answer a question rather than hold a value. Each is
    // built only where its config named one, and dispatch has already refused
    // the ops for the capability this instance then does not have.
    const launcher =
      config.upstream.launcher === undefined ? undefined : new Launcher(config.upstream.launcher);
    this.#translate = helper === undefined ? undefined : new Translate(helper);

    // The one decision every file op starts from. The three allowlists it reads
    // are the session's own facts, gathered from where each is stated: the
    // greeting says where the session works, and the fold says which folders
    // its editor names and which files outside them its transcript named.
    const files = new Containment({
      roots: (sid): SessionRoots | undefined => {
        const where = this.#sessions.where(sid);
        if (where.root === undefined && where.cwd === undefined) return undefined;
        const status = sessionStatusOf(sid, this.#transcripts.facts(sid), where);
        return {
          ...where,
          workspace_folders: status.workspace_folders.map((folder) => folder.path),
          external_files: status.external_files.map((file) => file.path),
        };
      },
    });
    const origin = config.upstream.sandbox_origin;

    // Which transcript an op means, for the ops that read one rather than
    // follow one. Only this instance's config home is ever looked in (M6): a
    // session that greeted said where its transcript is, and one that never
    // greeted is looked for under that home and nowhere else.
    const transcriptFiles = new TranscriptFiles({
      configHome: paths.configHome,
      announced: (sid) => this.#sessions.transcriptPath(sid),
    });

    this.#handlers = completeHandlers({
      hello: this.#sessions.hello,
      session_stopping: this.#sessions.stopping,
      ...topicHandlers(this.#topics),
      ...messagingHandlers(this.#delivery, this.#notify),
      ...fileHandlers(files),
      ...sessionHandlers({
        self: this.self,
        configHome: paths.configHome,
        stateDir: paths.stateDir,
        files: transcriptFiles,
        processes: new SessionProcesses(
          hostProcessDeps(() => this.#sessions.rowsNow(), config.upstream.terminal_gateway),
        ),
        forget: (sid) => this.#sessions.forget(sid),
      }),
      // The sandbox ops answer only where an origin is configured. Without one
      // there is nothing to serve a minted URL, and dispatch already refuses
      // them for the capability this instance then does not have.
      ...(origin === undefined ? {} : sandboxHandlers(new SandboxGrants(files, origin))),
      ...(launcher === undefined ? {} : launcherHandlers(launcher)),
      ...(this.#translate === undefined ? {} : translateHandlers(this.#translate)),
      ...gatewayHandlers(setup),
      ...kvHandlers(kv),
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

  /** 7-8 of §8.3: the pid, then the listeners with the unix socket first, then
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
    if (this.#boundWs !== undefined) {
      // Already listening: it had to be, for self-identification to reach it.
      this.#transport.add(this.#boundWs);
    } else if (this.config.entry !== undefined) {
      this.#transport.add(
        serveWs({
          hostname: this.config.entry.host,
          port: this.config.entry.port,
          conns: this.#conns,
          handle: (frame, conn) => this.handle(frame, conn),
          entry: entryPolicy(this.config, false),
          // The gateway posts to the address this instance already serves,
          // behind the same entry check (§3.1).
          route: (request) => this.route(request),
        }),
      );
    }
    // 8. the peers. Every instance dials every one of them, and one that is not
    // there is retried rather than waited for (§7.2).
    this.#mesh?.connect();
    await Promise.resolve();
    this.log.write("started", {
      instance: this.self,
      pid: process.pid,
      socket: this.paths.socket,
      http: this.http,
      peers: this.config.peers.length,
    });
  }

  /** An HTTP request on the WebSocket's listener that is not the upgrade. The
   * gateway's webhook is the one such route this instance answers itself; the
   * mesh's two are answered before this is asked, because they are served
   * before anything is proven and this instance's own routes are not. */
  route(request: Request): Promise<Response | undefined> {
    return this.#gateway.route(request);
  }

  /** Every bound WebSocket address, as `host:port`. */
  get http(): string[] {
    return this.#transport.listeners.filter((l) => l.kind === "ws").map((l) => l.address);
  }

  get socketPath(): string {
    return this.paths.socket;
  }

  /** The mesh, on an instance that has one.
   *
   * Which peers are reachable is a fact about this instance that no op carries
   * on its own — `hello` states it to a client, and this is where it is
   * observable from inside the process, as `watching` is for the sessions
   * watch. */
  get mesh(): Mesh | undefined {
    return this.#mesh;
  }

  /** Whether the sessions watch is running. It is driven by subscription
   * (§6.3), so this is how "the upstream watches stopped" is observable from
   * outside the domain that owns them. */
  get watching(): boolean {
    return this.#sessions.watching;
  }

  /** When the gateway last saw inference for a session (§5.1).
   *
   * The one input of the classification that arrives from outside this host,
   * and the only place it is observable from: it is an attribute of a row
   * rather than a state (§5.2), so nothing on the wire carries it yet. */
  gatewayActiveAt(sid: Sid): Timestamp | undefined {
    return this.#gateway.activeAt(sid);
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
      network: this.network,
    };
  }

  /** What this instance can say about the host link.
   *
   * The mesh is the only thing here that reaches off the host, so it is what
   * the answer is read from: a peer that answers is the link working, and
   * every configured peer silent at once is the link gone. Nothing else is
   * probed — an instance does not dial the internet to have an opinion about
   * it, and the peers are already being dialled for their own reasons (§8.3).
   *
   * Two cases state no verdict rather than guessing one. `off` is an instance
   * with no mesh: nothing here watches the link at all. `unknown` is a mesh
   * whose peer list holds nobody but ourselves — the link is watched, and no
   * observation of it can be made. */
  get network(): InstancePingResult["network"] {
    if (this.#mesh === undefined) return "off";
    const peers = this.#mesh.peers;
    if (peers.length === 0) return "unknown";
    return peers.some((peer) => this.#mesh?.reachable(peer) === true) ? "online" : "offline";
  }

  /** A link came up or went down. Told to every client when it changes what
   * the instance would answer about the host link, and to nobody when the set
   * of reachable peers moved without changing that — a five-peer cluster
   * losing one is not this host going offline. */
  #linkMoved(): void {
    const network = this.network;
    if (network !== "online" && network !== "offline") return;
    const online = network === "online";
    if (this.#announced === online) return;
    this.#announced = online;
    const event: NetOnlineEvent = { ev: "net_online", instance: this.self, online };
    for (const conn of this.#conns) conn.send(event);
  }

  /** One frame, from either transport. The re-entry guard of §8.5 step 1 sits
   * here because this is the single door every request comes through. */
  async handle(frame: unknown, conn: Requester): Promise<DispatchResult> {
    if (this.#stopping) {
      return failure(requestIdOf(frame), "bad_request", `${this.self} is shutting down`);
    }
    // A frame that is not an op: the mesh handshake's own traffic, which the
    // op vocabulary has no name for (contract, `Plane`). It is taken here
    // because this is the one door, and it decides nothing — the judgement is
    // in the `hello` handler, which is the only thing that settles a peer.
    if (this.#mesh?.frame(conn, frame) === true) {
      return { kind: "none" };
    }
    if (this.#mesh !== undefined) {
      // Mid-handshake, an ordinary request is a protocol violation rather than
      // an early call: the peer must send nothing before the acknowledgement,
      // and one that does is dropped rather than buffered (mesh-peer-auth §5.8).
      if (this.#mesh.handshaking(conn)) {
        conn.close();
        return failure(
          requestIdOf(frame),
          "bad_request",
          "a peer waits for its acknowledgement before it speaks",
        );
      }
      // Let in as a peer rather than on the entry token, and still unproven:
      // the greeting is the one thing it was admitted to make.
      if (this.#mesh.unproven(conn) && opOf(frame) !== "hello") {
        conn.close();
        return failure(
          requestIdOf(frame),
          "hello_required",
          "a peer connection greets before anything else",
        );
      }
    }
    // What `last_activity_at` means on the `peers` row: the most recent request
    // on any of the session's connections. Here, because this is the one door
    // every request comes through, and a session with several connections has
    // one row for all of them.
    const identity = conn.identity;
    if (identity.state === "settled" && identity.sid !== undefined) {
      this.#sessions.touch(identity.sid);
    }
    // Who this request runs as. On a peer's link it is the caller the envelope
    // names, believed because the link is authenticated and refused as a
    // malformed request when the two fields disagree; on every other
    // connection it is the connection's own identity, and a `caller` written
    // there is a field the sender does not get to fill in.
    const fromPeer = this.#mesh?.isLink(conn) === true;
    const stated = fromPeer ? callerOf(frame) : undefined;
    if (stated instanceof CallerError) {
      return failure(requestIdOf(frame), "bad_request", stated.message);
    }
    const decided = await dispatch(frame, this.#mesh?.caller(conn, stated) ?? conn, {
      self: this.self,
      capabilities: this.#capabilities,
      resolveInstance: (_op, fields) => this.#owner(fields),
      handlers: this.#handlers,
    });
    if (decided.kind !== "forward") return decided;
    // The op belongs to another instance. Mesh carries it and brings the
    // answer back under the id the caller used (§7.3); without a mesh there is
    // nothing that can reach it, which the driver names.
    //
    // Who it is forwarded as is stated here rather than copied from the
    // request: a caller that came over a peer's link travels on unchanged, and
    // anyone else is named from the connection they are actually on.
    return this.#mesh === undefined
      ? decided
      : await this.#mesh.forward(decided.to, decided.frame, stated ?? callerOfIdentity(identity));
  }

  /** Which instance owns the subject of an instance-local op.
   *
   * The subject is the session an op names, and an op that names none is about
   * this instance and stays here. A session this instance holds is its own
   * whatever the cluster last said; one it does not hold is looked for in the
   * routing table the `peers` topic is (§7.3). */
  #owner(fields: Record<string, unknown>): InstanceId | undefined {
    const sid = fields["sid"];
    if (typeof sid !== "string" || this.#mesh === undefined) return undefined;
    if (this.#sessions.classify(sid as Sid) !== undefined) return undefined;
    return this.#mesh.ownerOf(sid as Sid);
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
    // The read the gateway's own events can ask for is one more thing that
    // outlives its subscribers if nothing drops it here.
    this.#gateway.close();
    // The translation helper is a process this instance started, so it leaves
    // with it rather than outliving the daemon that has its pipe.
    this.#translate?.stop();
    // Route (a) holds a socket of its own, bound where the sessions' sockets
    // are so their receipts can reach it (§4.1). It has a name on disk, so it
    // is taken down here rather than left for the next run to find.
    this.#direct.close();
    // The mesh's links and its timers, let go here for the same reason: they
    // are this instance's and do not outlive it (§7).
    this.#mesh?.stop();
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

/** Where this instance says it is reached, for a `hello` that has to state one.
 *
 * The config's `self` when there is one, which is the answer for anything with
 * a mesh. Without one there is no operator statement to read, so the bound
 * address stands in — and where even that is unknown (the unix socket alone, or
 * a port the kernel has yet to assign) the config home's key does, which is
 * unique per instance and reaches nothing. A client on the unix socket already
 * has the instance it is talking to. */
export function selfEndpoint(key: string, config: InstanceConfig): Endpoint {
  if (config.self !== undefined) return config.self;
  const entry = config.entry;
  if (entry === undefined || entry.port === 0) return `ws://localhost/${key}`;
  return `ws://${entry.host}:${entry.port}`;
}

/** Who may reach the WebSocket at all (§3.1): an Origin the operator named and
 * an address the operator named.
 *
 * The two config lists are read as allowlists in both directions. An empty
 * `origins` admits no browser: a permission that was never granted is not a
 * permission, and the one deployment that would want "any page may connect" is
 * the one that must say so. An empty `source_ips` leaves the addresses to the
 * bind, which for the default loopback host is this machine.
 *
 * These two are the whole of it until the person's own authentication lands
 * (DR-0001): the entry token they replaced only ever restated the uid boundary,
 * which on a tailnet nothing here can cross anyway, and a passkey is what will
 * answer "who came" rather than "could they read a file". */
function entryPolicy(config: InstanceConfig, mesh: boolean): EntryPolicy {
  const entry = config.entry;
  if (entry === undefined) return {};
  return {
    allowRequest(request: Request, source: string | undefined): boolean {
      const origin = request.headers.get("origin");
      // A request carrying no `Origin` is not a browser's, and there is nothing
      // to compare: it stands or falls on the address and the token below.
      if (origin !== null && !entry.origins.includes(origin)) return false;
      if (entry.source_ips.length === 0) return true;
      // The address the server observed, not one a header claims: a forwarding
      // header is written by whoever is in front of us, and anyone who can
      // reach the port can write it.
      return source !== undefined && entry.source_ips.includes(source);
    },
    allowUpgrade(request: Request): UpgradeDecision {
      const offered = protocolsOf(request);
      // A peer is let through unproven, and what it is is decided by the
      // handshake — the only place a claim can actually be checked.
      if (mesh && offered.includes(MESH_PROTOCOL)) {
        return { ok: true, protocol: MESH_PROTOCOL, mesh: true };
      }
      // The handshake echoes a subprotocol only when one was offered: a browser
      // fails a connection whose reply names none of what it asked for.
      const selected = offered[0];
      return selected === undefined ? { ok: true } : { ok: true, protocol: selected };
    },
  };
}

function protocolsOf(request: Request): string[] {
  const header = request.headers.get("sec-websocket-protocol");
  if (header === null) return [];
  return header
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
}

function opOf(frame: unknown): string | undefined {
  if (typeof frame !== "object" || frame === null) return undefined;
  const op = (frame as Record<string, unknown>)["op"];
  return typeof op === "string" ? op : undefined;
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
