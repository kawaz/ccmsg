import { randomBytes } from "node:crypto";
import { chmodSync, unlinkSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type InboxMessage, renderDirectDelivery, type Sid } from "@ccmsg/protocol";
import { HARNESS, HARNESSES } from "../harness/index.ts";

/** What route (a) answered (DESIGN §6.5).
 *
 * `unavailable` is every way the route does not apply — the flag is off, the
 * harness names no messaging socket, the generation is one we do not speak, the
 * key cannot be read, the acknowledgement did not come. DESIGN §6.5 gives them one
 * outcome on purpose: the route either carried the message or it did not, and
 * route (b) is tried the same way in each case.
 *
 * `refused` is separate because it is not "the route does not apply": the
 * session is there and turned this message away for now, which is the one
 * outcome that reaches the sender as its own reason (DESIGN §6.8). */
export type DirectOutcome = "delivered" | "unavailable" | "refused";

/** Route (a): the harness's own messaging socket. */
export interface DirectRoute {
  send(sid: Sid, message: InboxMessage): Promise<DirectOutcome>;
  /** Let go of what the route holds open. The status inbox below is a bound
   * socket with a name on disk, and it leaves when the instance does (DESIGN §8.5). */
  close(): void;
}

/** Route (a) turned off by config (DESIGN §6.5 condition 0). Delivery is unchanged by
 * this: route (b) is the fallback, and a fallback that always runs is still the
 * same semantics (DESIGN §6.5). */
export class DisabledDirectRoute implements DirectRoute {
  send(): Promise<DirectOutcome> {
    return Promise.resolve("unavailable");
  }

  close(): void {}
}

/** The `peerProtocol` generation this speaks. One value, because one is what
 * has been read off a running harness (2.1.263); any other generation is a
 * protocol nobody here has seen, which is condition 1 of DESIGN §6.5. */
export const PEER_PROTOCOL = 1;

/** How long one attempt has to reach the point where the harness holds our
 * bytes: connect, then flush both frames.
 *
 * Provisional. No primary source states a budget for the sending side — the
 * only stated deadline is the receiver's own 30 s wait for a first complete
 * line, which is its tolerance and not ours. This is short enough that a
 * message falls to route (b) well inside the turn that sent it. */
export const DIRECT_ACK_MS = 2_000;

/** How long the status inbox is watched for word about this message before the
 * send is taken to have landed (DESIGN §6.5 condition 3).
 *
 * Provisional. What is known from the harness (2.1.263) is where the receipt
 * is raised, not how long it takes to arrive: the receiving session decides a
 * peer message at its inbound gate and reports the outcome from that same
 * decision, so a receipt for a message we have finished writing is one connect
 * and one line away on a socket of this same host. A quarter second is far
 * more than that costs and far less than a person waits for `message.send` to
 * answer. Nothing measured stands behind the number itself. */
export const DIRECT_STATUS_MS = 250;

/** What the receiving session says about a message it did not simply take
 * (harness 2.1.263, `peer_message_status`).
 *
 * There is no word for the ordinary case. The receipt is raised where a peer
 * message is turned away, parked or lost, and a message the session accepts
 * passes its gate without anything being written back — so these are the whole
 * of what route (a) can hear, and hearing none of them within the window is
 * what "it arrived" looks like on this route.
 *
 * `held` is among them because a parked message is not delivered yet: it waits
 * on somebody's approval there, which is the same "there, and not taking it
 * now" that DESIGN §6.8 keeps in our inbox and offers again. */
const REFUSING = new Set(["refused", "denied", "dropped", "expired", "held"]);

/** The socket this daemon offers so the receiving session can say what became
 * of a message (DESIGN §6.5 condition 3).
 *
 * It lives in the directory the target's own socket is in, and not in this
 * instance's state directory, because the receiving harness vets the address it
 * would answer before it answers: a reply target outside its socket namespace
 * is dropped with `reply address unshaped or outside our socket namespace`
 * (2.1.263). A socket beside the one we are writing to is inside it, so this is
 * the one place a status can be heard from at all. The name is this process's
 * pid and eight random hex digits, which is a shape that namespace admits and
 * that no harness will ever bind for a session of its own.
 *
 * Bound once per directory and held for the life of the instance: binding per
 * send would race a receipt against its own socket going away. */
class StatusInbox {
  readonly #waiting = new Map<string, (status: string) => void>();
  readonly #buffers = new Map<object, string>();
  #server: ReturnType<typeof Bun.listen> | undefined;
  readonly #path: string;

  constructor(directory: string) {
    this.#path = join(directory, `${process.pid}-${randomBytes(4).toString("hex")}.sock`);
  }

  /** The address to put in `from`, or nothing if the socket could not be
   * bound. Binding fails on a directory we cannot write, which costs the
   * route its status channel and nothing else: the message still goes, and
   * what the session says about it is simply not heard. */
  address(): string | undefined {
    if (this.#server !== undefined) return `uds:${this.#path}`;
    try {
      this.#server = Bun.listen({
        unix: this.#path,
        socket: {
          data: (socket, chunk) => this.#read(socket, chunk),
          open: () => {},
          close: (socket) => {
            this.#buffers.delete(socket);
          },
          error: () => {},
        },
      });
    } catch {
      return undefined;
    }
    // Same-uid by construction (A2 / A4), and stated rather than left to the
    // umask: what can be written here is what a session is told about.
    try {
      chmodSync(this.#path, 0o600);
    } catch {
      // The socket is bound and usable; a mode we could not set is not a
      // reason to give up the channel.
    }
    return `uds:${this.#path}`;
  }

  /** Watch for word about one message, for as long as the caller allows. The
   * answer is the status the session named, or nothing if it named none. */
  async status(mid: string, withinMs: number): Promise<string | undefined> {
    const settled = Promise.withResolvers<string | undefined>();
    this.#waiting.set(mid, settled.resolve);
    const deadline = setTimeout(() => settled.resolve(undefined), withinMs);
    try {
      return await settled.promise;
    } finally {
      clearTimeout(deadline);
      this.#waiting.delete(mid);
    }
  }

  close(): void {
    this.#server?.stop(true);
    this.#server = undefined;
    try {
      unlinkSync(this.#path);
    } catch {
      // Already gone, which is the state this is asking for.
    }
  }

  #read(socket: object, chunk: Uint8Array): void {
    const parts = ((this.#buffers.get(socket) ?? "") + Buffer.from(chunk).toString("utf8")).split(
      "\n",
    );
    this.#buffers.set(socket, parts.pop() ?? "");
    for (const line of parts) this.#line(line);
  }

  /** One frame from a session. Only the receipts are read: the address also
   * reaches the model as somewhere it could answer, so a reply may arrive here
   * as an ordinary message — and a reply belongs in the conversation the
   * contract routes it through, not in a socket that only settles sends. */
  #line(line: string): void {
    if (line.trim() === "") return;
    let frame: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null) return;
      frame = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    if (frame["action"] !== "peer_message_status") return;
    const status = frame["status"];
    if (typeof status !== "string") return;
    for (const mid of named(frame)) this.#waiting.get(mid)?.(status);
  }
}

/** Which of our messages a receipt is about: the one it answers, and any it
 * names as lost alongside (harness 2.1.263 reports a queue-full drop against
 * every message it shed). */
function named(frame: Record<string, unknown>): string[] {
  const original = frame["orig_msg_id"];
  const dropped = frame["dropped_msg_ids"];
  return [
    ...(typeof original === "string" ? [original] : []),
    ...(Array.isArray(dropped) ? dropped.filter((id): id is string => typeof id === "string") : []),
  ];
}

/** The state file of one session, as far as route (a) reads it. */
interface HarnessTarget {
  readonly pid: number;
  readonly socketPath: string;
}

export interface SocketRouteOptions {
  /** The one config home this instance answers for (M6). Its `sessions/` holds
   * both the state files and the keys. */
  readonly configHome: string;
  readonly ackMs?: number;
  /** How long a receipt has to arrive before the message counts as taken. */
  readonly statusMs?: number;
}

/** Route (a) against the harness's messaging socket (DESIGN §6.5).
 *
 * The path is `sessions/<pid>.json` of this instance's own config home, which
 * is also the answer to condition 2: a key beside it that this uid can read is
 * exactly the same-uid, same-config-home boundary the instance already stands
 * on (A2 / A4). Nothing here searches another config home, and a session this
 * instance cannot see a state file for is simply not reachable this way.
 *
 * The directory is read per send rather than taken from the sessions domain's
 * watch: that watch runs only while a topic is subscribed (DESIGN §6.3), and route (a)
 * exists precisely for the session that subscribes to nothing. */
export class ClaudeCodeSocketRoute implements DirectRoute {
  readonly #sessionsDir: string;
  readonly #ackMs: number;
  readonly #statusMs: number;
  /** One status inbox per directory sessions' sockets live in. A host has one
   * such directory in practice; the map is what keeps that from being an
   * assumption. */
  readonly #inboxes = new Map<string, StatusInbox>();

  constructor(options: SocketRouteOptions) {
    this.#sessionsDir = join(options.configHome, "sessions");
    this.#ackMs = options.ackMs ?? DIRECT_ACK_MS;
    this.#statusMs = options.statusMs ?? DIRECT_STATUS_MS;
  }

  /** One send, and what the session made of it.
   *
   * The message is written, and then the receipt channel is watched for word
   * about it. What can arrive is a session saying it did not take the message
   * (DESIGN §6.8); what cannot is a session saying it did, because none is sent for
   * the ordinary case. So the outcome is refusal if it says so in time, and
   * delivery if it says nothing — which is the same shape as the acknowledged
   * send it stands in for, decided on a channel that carries the refusals
   * rather than on one that carries nothing at all. */
  async send(sid: Sid, message: InboxMessage): Promise<DirectOutcome> {
    const target = await this.#target(sid);
    if (target === undefined) return "unavailable";
    const token = await this.#token(target.pid);
    if (token === undefined) return "unavailable";
    const inbox = this.#inbox(target.socketPath);
    const from = inbox?.address();
    const watching = inbox === undefined ? undefined : inbox.status(message.mid, this.#statusMs);
    const written = await write(target.socketPath, frames(sid, token, message, from), this.#ackMs);
    if (written !== "delivered") return written;
    const status = await watching;
    return status !== undefined && REFUSING.has(status) ? "refused" : "delivered";
  }

  close(): void {
    for (const inbox of this.#inboxes.values()) inbox.close();
    this.#inboxes.clear();
  }

  /** The receipt channel for a target, bound beside its own socket. Absent
   * when nothing could be bound there, which leaves the route working and its
   * refusals unheard. */
  #inbox(socketPath: string): StatusInbox | undefined {
    const directory = dirname(socketPath);
    const held = this.#inboxes.get(directory);
    if (held !== undefined) return held;
    const inbox = new StatusInbox(directory);
    if (inbox.address() === undefined) return undefined;
    this.#inboxes.set(directory, inbox);
    return inbox;
  }

  /** The state file naming this session, if it names a socket of a generation
   * we speak (DESIGN §6.5 conditions 1). */
  async #target(sid: Sid): Promise<HarnessTarget | undefined> {
    let names: string[];
    try {
      names = await readdir(this.#sessionsDir);
    } catch {
      return undefined;
    }
    for (const name of names) {
      if (!/^\d+\.json$/.test(name)) continue;
      const row = await readJson(join(this.#sessionsDir, name));
      if (row === undefined || row["sessionId"] !== sid) continue;
      const pid = row["pid"];
      const socketPath = row["messagingSocketPath"];
      if (typeof pid !== "number" || typeof socketPath !== "string" || socketPath === "") {
        return undefined;
      }
      return row["peerProtocol"] === PEER_PROTOCOL ? { pid, socketPath } : undefined;
    }
    return undefined;
  }

  /** The `peerToken` the harness wrote for this session (DESIGN §6.5 condition 2).
   *
   * Found by the pid the key is named after rather than by rebuilding the rest
   * of the name: the digest in `<pid>.<digest>.key` is stated to be over the
   * socket path, but neither its input spelling nor its length has been checked
   * against a running harness, and a name we cannot rebuild is still a name we
   * can recognise. */
  async #token(pid: number): Promise<string | undefined> {
    const key = new RegExp(`^${pid}\\.[0-9a-f]+\\.key$`);
    let names: string[];
    try {
      names = await readdir(this.#sessionsDir);
    } catch {
      return undefined;
    }
    for (const name of names) {
      if (!key.test(name)) continue;
      const document = await readJson(join(this.#sessionsDir, name));
      const token = document?.["peerToken"];
      if (typeof token === "string" && token !== "") return token;
    }
    return undefined;
  }
}

/** How the Codex CLI is run, and what it answered. Named so a test can watch
 * what would be run without a thread of anybody's being written to. */
export type RunCodex = (args: readonly string[], env: Env) => Promise<{ code: number }>;

type Env = Record<string, string>;

/** What the CLI must not inherit from the daemon.
 *
 * A daemon carries whatever environment it was started in, which on a host
 * where somebody works in Claude Code names that config home and that session.
 * Passed through, they would tell the Codex CLI about a config home this
 * instance is not about and a session that is not the one being written to.
 * The home this route means is named explicitly, and the rest is dropped
 * (DESIGN §4.1). */
const DROPPED = HARNESSES.filter((harness) => harness !== "codex").flatMap((harness) => [
  HARNESS[harness].homeEnv,
  ...HARNESS[harness].sessionEnv,
]);

/** How long the CLI has to answer before the send is taken as not having gone
 * this way.
 *
 * `codex queue` is a request to a thread store and answers at once: against a
 * thread nobody has, it failed with the store's own error immediately, in a
 * config home that had never been used and a directory Codex had never been
 * told to trust (0.154.0, standard input closed, no terminal). Neither the
 * update notice nor the directory-trust question is asked on this path — both
 * belong to the interactive interface.
 *
 * The budget is here for what is not being predicted: a child that never
 * answers would hold `message.send` open for as long as it lived, and route
 * (b) exists exactly so a route that does not come through costs a message
 * nothing (DESIGN §6.5). It is generous next to a call that has been measured to
 * return at once. */
export const QUEUE_MS = 10_000;

const runCodex: RunCodex = async (args, env) => {
  let spawned: Bun.Subprocess<"ignore", "ignore", "ignore">;
  const inherited = { ...process.env } as Record<string, string | undefined>;
  for (const name of DROPPED) delete inherited[name];
  try {
    spawned = Bun.spawn({
      cmd: ["codex", ...args],
      env: { ...inherited, ...env } as Record<string, string>,
      // Nothing is read from us: a child holding the daemon's own standard
      // input could wait on somebody who is not there.
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch {
    // No `codex` on `PATH`, which is the same as the route not applying: the
    // message goes by route (b) and nothing about it is lost (DESIGN §6.5).
    return { code: 127 };
  }
  // The timer is held so it can be cleared: a send that answered in a
  // millisecond must not leave the loop something to wake up for ten seconds
  // later, which is what an instance shutting down would then wait on.
  const late = Promise.withResolvers<"late">();
  const timer = setTimeout(() => late.resolve("late"), QUEUE_MS);
  try {
    const finished = await Promise.race([spawned.exited, late.promise]);
    if (finished === "late") {
      spawned.kill();
      return { code: 124 };
    }
    return { code: finished };
  } finally {
    clearTimeout(timer);
  }
};

export interface QueueRouteOptions {
  /** The one config home this instance answers for (M6). It is named to the
   * CLI rather than inherited, because the daemon's own environment says which
   * config home it serves in its own words and Codex reads only its own. */
  readonly configHome: string;
  readonly run?: RunCodex;
}

/** Route (a) against a Codex thread's queue (DESIGN §6.5).
 *
 * Codex has no socket a message can be written to: what it has is a queue per
 * thread, held by the app-server the thread belongs to, and `codex queue` is
 * the way in that ccmsg does not have to reimplement. A queued message is
 * delivered when the thread is idle, after the current turn when it is busy,
 * and on resume when it is not loaded (codex-cli 0.153.4).
 *
 * So `delivered` here means the queue took it, which is the same promise route
 * (a) makes on the other harness: the receiving session holds the message, and
 * nothing says the model has read it. There is no receipt channel, so there is
 * no `refused` — a thread that turns a message away does so where nothing
 * reports back, and a queue that would not take it fails the command and falls
 * to route (b). */
export class CodexQueueRoute implements DirectRoute {
  readonly #run: RunCodex;

  readonly #env: Env;

  constructor(options: QueueRouteOptions) {
    this.#run = options.run ?? runCodex;
    this.#env = { CODEX_HOME: options.configHome };
  }

  async send(sid: Sid, message: InboxMessage): Promise<DirectOutcome> {
    const { code } = await this.#run(
      ["queue", "--thread", sid, "--message", renderDirectDelivery(message)],
      this.#env,
    );
    return code === 0 ? "delivered" : "unavailable";
  }

  close(): void {}
}

/** The two lines one send writes: the auth frame the harness's own senders
 * write first, then the message.
 *
 * The body is the contract's wording for this route. On it the recipient is
 * the model rather than a client: it reads one block of text and has no frame
 * to look at, so `mid` and `from` have to be in the text or nothing can be
 * answered. `<cross-session-message>` is what the harness's own senders embed
 * in `message.content` — measured on a real send, where it reached the model
 * literal rather than expanded — so sitting on it means the receiving harness
 * reads an origin it already knows. The wording is the contract's and this
 * route only carries it.
 *
 * `session_id` rides along because the harness checks it against its own and
 * drops a mismatch: a state file read a moment before the pid was reused turns
 * into a message nobody receives rather than one the wrong session does.
 *
 * `from` is the address of our own status inbox, and is fixed by ccmsg rather
 * than taken from the caller (DESIGN §6.5). It is what the receiving session answers
 * to about this message, and the message's `mid` is what it answers about — so
 * the two travel together, and a route with no inbox to offer sends neither
 * rather than naming an address nothing is listening on. */
function frames(sid: Sid, token: string, message: InboxMessage, from?: string): string {
  const auth = { type: "auth", token };
  const user = {
    type: "user",
    ...(from === undefined ? {} : { from }),
    session_id: sid,
    msg_id: message.mid,
    message: { content: renderDirectDelivery(message) },
  };
  return `${JSON.stringify(auth)}\n${JSON.stringify(user)}\n`;
}

/** Connect and write, and answer whether the harness holds our bytes (DESIGN §6.5
 * condition 3).
 *
 * That is the whole of what this can decide. The connection carries nothing
 * back — a real send measured zero bytes on it — so waiting here for an answer
 * would time out every delivery; what the session makes of the message travels
 * to our status inbox instead, and the caller waits for it there. What the
 * budget covers is connect and flush. */
async function write(path: string, payload: string, ackMs: number): Promise<DirectOutcome> {
  const started = Date.now();
  const settled = Promise.withResolvers<DirectOutcome>();
  const bytes = Buffer.from(payload, "utf8");
  let written = 0;
  let flushed = false;

  const done = (): void => {
    flushed = true;
    settled.resolve(Date.now() - started >= ackMs ? "unavailable" : "delivered");
  };

  const push = (socket: { write(data: Uint8Array): number }): void => {
    written += socket.write(bytes.subarray(written));
    if (written >= bytes.length && !flushed) done();
  };

  let socket: Awaited<ReturnType<typeof Bun.connect>>;
  try {
    socket = await Bun.connect({
      unix: path,
      socket: {
        open: push,
        drain: (conn) => {
          if (!flushed) push(conn);
        },
        data: () => {},
        // The connection ending before the last byte left is the message not
        // having reached anyone; after that it is the harness closing a
        // connection it has no more use for.
        close: () => settled.resolve(flushed ? "delivered" : "unavailable"),
        error: () => settled.resolve("unavailable"),
      },
    });
  } catch {
    // No socket at the path, or nothing listening on it: the session ended and
    // took its socket with it, or never had one (DESIGN §6.5 condition 1).
    return "unavailable";
  }

  const deadline = setTimeout(
    () => settled.resolve("unavailable"),
    Math.max(0, ackMs - (Date.now() - started)),
  );
  try {
    return await settled.promise;
  } finally {
    clearTimeout(deadline);
    socket.end();
  }
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const document: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof document !== "object" || document === null) return undefined;
    return document as Record<string, unknown>;
  } catch {
    // Missing, unreadable by this uid, or half written — all of them are
    // "route (a) does not apply here" (DESIGN §6.5 conditions 1 and 2).
    return undefined;
  }
}
