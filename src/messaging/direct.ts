import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DIRECT_DELIVERY_FROM,
  type InboxMessage,
  renderDirectDelivery,
  type Sid,
} from "@ccmsg/protocol";

/** What route (a) answered (§4.1).
 *
 * `unavailable` is every way the route does not apply — the flag is off, the
 * harness names no messaging socket, the generation is one we do not speak, the
 * key cannot be read, the acknowledgement did not come. §4.1 gives them one
 * outcome on purpose: the route either carried the message or it did not, and
 * route (b) is tried the same way in each case.
 *
 * `refused` is separate because it is not "the route does not apply": the
 * session is there and turned this message away for now, which is the one
 * outcome that reaches the sender as its own reason (§4.4). */
export type DirectOutcome = "delivered" | "unavailable" | "refused";

/** Route (a): the harness's own messaging socket. */
export interface DirectRoute {
  send(sid: Sid, message: InboxMessage): Promise<DirectOutcome>;
}

/** Route (a) turned off by config (§4.1 condition 0). Delivery is unchanged by
 * this: route (b) is the fallback, and a fallback that always runs is still the
 * same semantics (§4.1). */
export class DisabledDirectRoute implements DirectRoute {
  send(): Promise<DirectOutcome> {
    return Promise.resolve("unavailable");
  }
}

/** The `peerProtocol` generation this speaks. One value, because one is what
 * has been read off a running harness (2.1.263); any other generation is a
 * protocol nobody here has seen, which is condition 1 of §4.1. */
export const PEER_PROTOCOL = 1;

/** How long one attempt has to reach the point where the harness holds our
 * bytes: connect, then flush both frames.
 *
 * Provisional. No primary source states a budget for the sending side — the
 * only stated deadline is the receiver's own 30 s wait for a first complete
 * line, which is its tolerance and not ours. This is short enough that a
 * message falls to route (b) well inside the turn that sent it. */
export const DIRECT_ACK_MS = 2_000;

/** How long the connection is held open after the last byte, in case the
 * harness answers that it turned the message away (§4.4).
 *
 * Provisional, and short: nothing observed answers on this connection at all, a
 * send that is not refused waits this out before its caller hears anything, and
 * a drop the harness never states is one route (a) cannot report either way. */
export const DIRECT_SETTLE_MS = 50;

/** Why the harness declines a message it did receive, as read out of its flow
 * control (token bucket, duplicate window, hop and queue limits).
 *
 * These are matched against anything the harness writes back on our own
 * connection. Nothing observed writes there — a real send measured
 * SESSION→CLIENT as zero bytes, and status travels to the `from` inbox socket
 * instead, which is a socket this daemon does not offer (see `FROM`). So this
 * is the defensive half of §4.4: silence is delivery, and a drop is named only
 * if the harness ever names one to us. */
const DROP_REASONS = new Set([
  "rate-limited",
  "duplicate",
  "hop-loop",
  "hop-runaway",
  "queue-full",
]);

/** Who the message says it is from (§4.1: fixed by ccmsg, never caller input).
 *
 * The contract's, so the frame and the envelope inside it name the same sender.
 * Deliberately not a `uds:<path>` address: that form is the one the harness
 * answers to, and answering a socket that is not there ends the recipient's
 * turn in `state: "failed"` — measured with a sender that had already exited. */
const FROM = DIRECT_DELIVERY_FROM;

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
}

/** Route (a) against the harness's messaging socket (§4.1).
 *
 * The path is `sessions/<pid>.json` of this instance's own config home, which
 * is also the answer to condition 2: a key beside it that this uid can read is
 * exactly the same-uid, same-config-home boundary the instance already stands
 * on (A2 / A4). Nothing here searches another config home, and a session this
 * instance cannot see a state file for is simply not reachable this way.
 *
 * The directory is read per send rather than taken from the sessions domain's
 * watch: that watch runs only while a topic is subscribed (§6.3), and route (a)
 * exists precisely for the session that subscribes to nothing. */
export class ClaudeCodeSocketRoute implements DirectRoute {
  readonly #sessionsDir: string;
  readonly #ackMs: number;

  constructor(options: SocketRouteOptions) {
    this.#sessionsDir = join(options.configHome, "sessions");
    this.#ackMs = options.ackMs ?? DIRECT_ACK_MS;
  }

  async send(sid: Sid, message: InboxMessage): Promise<DirectOutcome> {
    const target = await this.#target(sid);
    if (target === undefined) return "unavailable";
    const token = await this.#token(target.pid);
    if (token === undefined) return "unavailable";
    return await write(target.socketPath, frames(sid, token, message), this.#ackMs);
  }

  /** The state file naming this session, if it names a socket of a generation
   * we speak (§4.1 conditions 1). */
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

  /** The `peerToken` the harness wrote for this session (§4.1 condition 2).
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
 * into a message nobody receives rather than one the wrong session does. */
function frames(sid: Sid, token: string, message: InboxMessage): string {
  const auth = { type: "auth", token };
  const user = {
    type: "user",
    from: FROM,
    session_id: sid,
    msg_id: message.mid,
    message: { content: renderDirectDelivery(message) },
  };
  return `${JSON.stringify(auth)}\n${JSON.stringify(user)}\n`;
}

/** Connect, write, and decide what happened (§4.1 condition 3).
 *
 * The acknowledgement this route can have is the harness holding our bytes:
 * the connection opened and both frames flushed, with no error, inside the
 * budget. There is no reply to wait for — a real send measured zero bytes back
 * on this connection — so waiting for one would time out every delivery. What
 * the budget therefore covers is connect and flush, and anything the harness
 * does say before the connection ends is read only to catch a drop (§4.4). */
async function write(path: string, payload: string, ackMs: number): Promise<DirectOutcome> {
  const started = Date.now();
  const settled = Promise.withResolvers<DirectOutcome>();
  const bytes = Buffer.from(payload, "utf8");
  let written = 0;
  let flushed = false;
  let settle: ReturnType<typeof setTimeout> | undefined;

  /** The last byte is out. Whether that counts is the budget's question, and
   * what the harness might still say about it is the settle window's. */
  const done = (): void => {
    flushed = true;
    if (Date.now() - started >= ackMs) {
      settled.resolve("unavailable");
      return;
    }
    settle = setTimeout(() => settled.resolve("delivered"), DIRECT_SETTLE_MS);
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
        data: (_conn, chunk) => {
          if (dropped(chunk)) settled.resolve("refused");
        },
        // The connection ending before the last byte left is the message not
        // having reached anyone; after that it is the harness closing a
        // connection it has no more use for.
        close: () => settled.resolve(flushed ? "delivered" : "unavailable"),
        error: () => settled.resolve("unavailable"),
      },
    });
  } catch {
    // No socket at the path, or nothing listening on it: the session ended and
    // took its socket with it, or never had one (§4.1 condition 1).
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
    if (settle !== undefined) clearTimeout(settle);
    socket.end();
  }
}

/** Whether anything the harness wrote back names one of its drop reasons.
 *
 * Read loosely on purpose: the frame that would carry this has been named but
 * never seen, so what is matched is the reason itself wherever it appears in
 * the line, and a line that names none leaves the send as it was. */
function dropped(chunk: Uint8Array): boolean {
  const text = Buffer.from(chunk).toString("utf8");
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof frame !== "object" || frame === null) continue;
    for (const value of Object.values(frame as Record<string, unknown>)) {
      if (typeof value === "string" && DROP_REASONS.has(value)) return true;
    }
  }
  return false;
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const document: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof document !== "object" || document === null) return undefined;
    return document as Record<string, unknown>;
  } catch {
    // Missing, unreadable by this uid, or half written — all of them are
    // "route (a) does not apply here" (§4.1 conditions 1 and 2).
    return undefined;
  }
}
