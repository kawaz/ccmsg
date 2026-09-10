import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  directDeliveryReplyLine,
  type InboxMessage,
  parseDirectDelivery,
  type Sid,
} from "@ccmsg/protocol";
import {
  ClaudeCodeSocketRoute,
  Delivery,
  Inbox,
  inboxPath,
  messagingHandlers,
  Notify,
  PEER_PROTOCOL,
} from "../src/messaging/index.ts";
import { connAs, OTHER_SID, SELF, SID } from "./frames.ts";

/** A stand-in for the harness's messaging socket: it speaks the same framing
 * (one JSON object per line) and records what arrived, and it is never a real
 * session — writing to one of those would put a message into somebody's turn.
 *
 * What it does about a message it will not take is what the harness does
 * (2.1.263): nothing comes back on the connection the message arrived on —
 * that direction measured zero bytes on a real send — and the receipt is
 * written to the address the frame's `from` names, as a `peer_message_status`
 * answering the `msg_id` it was sent with. A message it accepts gets no
 * receipt at all, because the harness raises one only where it turns a message
 * away, parks it or loses it. */
class FakeHarness {
  readonly lines: string[] = [];
  #buffer = "";
  #server: ReturnType<typeof Bun.listen> | undefined;

  constructor(
    readonly path: string,
    /** The status to report for every message, or nothing to take them all. */
    private readonly status?: string,
  ) {}

  listen(): void {
    this.#server = Bun.listen({
      unix: this.path,
      socket: {
        data: (_socket, chunk) => {
          this.#buffer += Buffer.from(chunk).toString("utf8");
          const parts = this.#buffer.split("\n");
          this.#buffer = parts.pop() ?? "";
          this.lines.push(...parts);
          for (const line of parts) void this.#report(line);
        },
        open: () => {},
        close: () => {},
        error: () => {},
      },
    });
  }

  frames(): Record<string, unknown>[] {
    return this.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  stop(): void {
    this.#server?.stop(true);
    this.#server = undefined;
  }

  /** The receipt, on the socket the sender offered. */
  async #report(line: string): Promise<void> {
    if (this.status === undefined) return;
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const from = frame["from"];
    const original = frame["msg_id"];
    if (typeof from !== "string" || !from.startsWith("uds:") || typeof original !== "string")
      return;
    const receipt = `${JSON.stringify({
      type: "control",
      action: "peer_message_status",
      status: this.status,
      orig_msg_id: original,
      from: `uds:${this.path}`,
    })}\n`;
    try {
      const socket = await Bun.connect({
        unix: from.slice(4),
        socket: { open: (conn) => void conn.write(Buffer.from(receipt, "utf8")), data: () => {} },
      });
      setTimeout(() => socket.end(), 50);
    } catch {
      // The sender offered an address nothing is listening on, which is what a
      // sender that has already exited leaves behind.
    }
  }
}

const dirs: string[] = [];
const harnesses: FakeHarness[] = [];
const routes: ClaudeCodeSocketRoute[] = [];
afterEach(() => {
  for (const route of routes.splice(0)) route.close();
  for (const harness of harnesses.splice(0)) harness.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PID = 424_242;
const TOKEN = "0123456789abcdef0123456789abcdef";

interface Rig {
  configHome: string;
  sessionsDir: string;
  socketPath: string;
  harness: FakeHarness;
}

/** A disposable config home holding one session's state file and key, and a
 * fake socket at the path that file names. */
function rig(
  over: {
    peerProtocol?: unknown;
    socketPath?: string;
    token?: string | null;
    listen?: boolean;
    status?: string;
    sid?: Sid;
  } = {},
): Rig {
  const configHome = mkdtempSync(join(tmpdir(), "ccmsg-direct-"));
  dirs.push(configHome);
  const sessionsDir = join(configHome, "sessions");
  mkdirSync(sessionsDir);
  // Short by construction: the socket path has to fit in `sun_path`, and a
  // temporary directory plus a name is already most of it.
  const socketDir = mkdtempSync(join(tmpdir(), "ccs-"));
  dirs.push(socketDir);
  const socketPath = over.socketPath ?? join(socketDir, `${PID}.sock`);
  writeFileSync(
    join(sessionsDir, `${PID}.json`),
    JSON.stringify({
      sessionId: over.sid ?? SID,
      pid: PID,
      cwd: "/repos/a-repo/main",
      kind: "interactive",
      startedAt: 1_757_000_000_000,
      messagingSocketPath: socketPath,
      peerProtocol: over.peerProtocol ?? PEER_PROTOCOL,
    }),
  );
  if (over.token !== null) {
    writeFileSync(
      join(sessionsDir, `${PID}.${"ab".repeat(32)}.key`),
      JSON.stringify({ peerToken: over.token ?? TOKEN }),
      { mode: 0o600 },
    );
  }
  const harness = new FakeHarness(socketPath, over.status);
  harnesses.push(harness);
  if (over.listen !== false) harness.listen();
  return { configHome, sessionsDir, socketPath, harness };
}

/** A route whose status socket is taken down with the rest of the rig. */
function track(route: ClaudeCodeSocketRoute): ClaudeCodeSocketRoute {
  routes.push(route);
  return route;
}

function message(text = "hi"): InboxMessage {
  return {
    mid: `${SELF}/1`,
    from: SID,
    from_label: "a-repo/main",
    text,
    sent_at: 1_757_000_000_000,
  };
}

/** Waits for the fake harness to have the frames, which is a separate event
 * loop turn from the send resolving: the route's acknowledgement is its own
 * write having flushed, not the receiver having read. */
async function received(harness: FakeHarness, lines = 2): Promise<Record<string, unknown>[]> {
  const until = Date.now() + 1_000;
  while (harness.lines.length < lines && Date.now() < until) await Bun.sleep(1);
  return harness.frames();
}

describe("route (a) over the messaging socket (§4.1)", () => {
  test("the message reaches the socket the state file names", async () => {
    const { configHome, harness, socketPath } = rig();
    const route = new ClaudeCodeSocketRoute({ configHome });
    routes.push(route);

    expect(await route.send(SID, message("over the socket"))).toBe("delivered");

    const [auth, user] = await received(harness);
    expect(auth).toEqual({ type: "auth", token: TOKEN });
    const {
      message: body,
      from,
      ...frame
    } = user as {
      message: { content: string };
      from: string;
    };
    expect(frame).toEqual({ type: "user", session_id: SID, msg_id: `${SELF}/1` });
    expect(parseDirectDelivery(body.content)?.text).toBe("over the socket");
    // The address the session answers to about this message, and the one place
    // it can be offered from: the receiving harness drops a reply target
    // outside its own socket namespace, so ours is bound beside its.
    expect(from.startsWith("uds:")).toBe(true);
    expect(dirname(from.slice(4))).toBe(dirname(socketPath));
  });

  test("the body is the contract's wording, and reads back as the message", async () => {
    const { configHome, harness } = rig();
    const route = new ClaudeCodeSocketRoute({ configHome });
    const sent = message("just this");

    await route.send(SID, sent);

    const user = (await received(harness))[1] as { message: { content: string } };
    // What the recipient holds is text, so what it can answer has to be
    // recoverable from that text alone (§4.1).
    expect(parseDirectDelivery(user.message.content)).toEqual({
      mid: sent.mid,
      from: sent.from,
      from_label: sent.from_label,
      text: "just this",
    });
    expect(user.message.content).toContain(directDeliveryReplyLine(sent.mid, sent.from));
  });

  test("a message from the person is delivered with nothing to send back to", async () => {
    const { configHome, harness } = rig();
    const route = new ClaudeCodeSocketRoute({ configHome });
    const sent: InboxMessage = { ...message("from the browser"), from: "user", from_label: "user" };

    await route.send(SID, sent);

    const user = (await received(harness))[1] as { message: { content: string } };
    expect(parseDirectDelivery(user.message.content)?.from).toBe("user");
    // `message_send` addresses a sid, so there is no sending back to a person:
    // the contract's wording drops the addressee rather than naming one.
    expect(user.message.content).toContain(directDeliveryReplyLine(sent.mid, sent.from));
    expect(user.message.content).not.toContain("--to");
  });

  test("what it answers rides along when the message answers something", async () => {
    const { configHome, harness } = rig();
    const route = new ClaudeCodeSocketRoute({ configHome });

    await route.send(SID, { ...message("answering"), reply_to: `${SELF}/7` });

    const user = (await received(harness))[1] as { message: { content: string } };
    expect(parseDirectDelivery(user.message.content)?.reply_to).toBe(`${SELF}/7`);
  });

  /** Each row is one of §4.1's conditions failing, and every one of them ends
   * the same way: no judgement, route (b) (§11.4). */
  const UNAVAILABLE: [string, Parameters<typeof rig>[0]][] = [
    ["nothing is listening on the socket", { listen: false }],
    [
      "the state file names no socket we can reach",
      { socketPath: "/nonexistent/ccmsg.sock", listen: false },
    ],
    ["the key cannot be read", { token: null }],
    ["the key holds no token", { token: "" }],
    ["the generation is not the one we speak", { peerProtocol: 2 }],
    ["the state file is another session's", { sid: "99999999-8888-4777-8666-555544443333" }],
  ];

  for (const [name, over] of UNAVAILABLE) {
    test(`${name}: unavailable`, async () => {
      const { configHome } = rig(over);
      const route = new ClaudeCodeSocketRoute({ configHome });
      expect(await route.send(SID, message())).toBe("unavailable");
    });
  }

  test("no config home at all: unavailable", async () => {
    const route = new ClaudeCodeSocketRoute({ configHome: join(tmpdir(), "ccmsg-absent-home") });
    expect(await route.send(SID, message())).toBe("unavailable");
  });

  test("a budget already spent is an acknowledgement that did not come", async () => {
    const { configHome } = rig();
    // Zero leaves nothing for connect and flush, which is the shape of the
    // acknowledgement arriving too late (§4.1 condition 3).
    const route = new ClaudeCodeSocketRoute({ configHome, ackMs: 0 });
    expect(await route.send(SID, message())).toBe("unavailable");
  });

  /** Every status the harness raises for a message it did not simply take. All
   * of them mean the same thing to §4.4: the session is there and this message
   * is not in its turn, so it stays in our inbox and is offered again. */
  for (const status of ["dropped", "refused", "denied", "expired", "held"]) {
    test(`a session reporting ${status} refused the message`, async () => {
      const { configHome } = rig({ status });
      const route = new ClaudeCodeSocketRoute({ configHome });
      routes.push(route);
      expect(await route.send(SID, message())).toBe("refused");
    });
  }

  test("a receipt about a different message leaves this one delivered", async () => {
    const { configHome } = rig({ status: "unrelated-frame" });
    const route = new ClaudeCodeSocketRoute({ configHome });
    routes.push(route);
    // The status is not one of the refusals, which is every frame that is not
    // this route's business: what it does not recognise, it does not act on.
    expect(await route.send(SID, message())).toBe("delivered");
  });

  test("a session that says nothing has taken the message", async () => {
    // The harness raises a receipt only where it turns a message away, so
    // silence is the ordinary case rather than an answer that went missing.
    const { configHome } = rig();
    const route = new ClaudeCodeSocketRoute({ configHome, statusMs: 60 });
    routes.push(route);
    const started = Date.now();
    expect(await route.send(SID, message())).toBe("delivered");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("the status socket goes when the route does", async () => {
    const { configHome, harness } = rig();
    const route = new ClaudeCodeSocketRoute({ configHome, statusMs: 30 });
    await route.send(SID, message());
    const user = (await received(harness))[1] as { from: string };
    const path = user.from.slice(4);
    expect(existsSync(path)).toBe(true);
    route.close();
    expect(existsSync(path)).toBe(false);
  });
});

describe("delivery over route (a)", () => {
  /** The sessions domain narrowed to what delivery asks it, so `message_send`
   * can run against the real route without the rest of the instance. */
  const sessions = {
    classify: () => "live" as const,
    peers: () => ({ peers: [], last_live: [] }),
  };

  function delivery(configHome: string, dir: string): Delivery {
    const inbox = new Inbox(inboxPath(dir));
    inbox.load();
    return new Delivery({
      self: SELF,
      sessions,
      inbox,
      direct: track(new ClaudeCodeSocketRoute({ configHome })),
      publish: () => {
        throw new Error("route (b) was taken");
      },
      listeners: () => 0,
    });
  }

  test("nothing is held for a session route (a) reached, and no topic is used", async () => {
    const { configHome, harness } = rig({ sid: OTHER_SID });
    const dir = mkdtempSync(join(tmpdir(), "ccmsg-direct-state-"));
    dirs.push(dir);
    const target = delivery(configHome, dir);

    const conn = connAs("session", SID);
    const result = await messagingHandlers(
      target,
      new Notify({ self: SELF, label: (sid) => sid, publish: () => "ok" }),
    ).message_send({
      op: "message_send",
      conn,
      args: { op: "message_send", request_id: "1", to: OTHER_SID, text: "straight there" },
      identity: conn.identity.state === "settled" ? conn.identity : undefined,
    });

    expect(result).toEqual({ delivered: true });
    const user = (await received(harness))[1] as { message: { content: string } };
    const delivered = parseDirectDelivery(user.message.content);
    expect(delivered?.text).toBe("straight there");
    expect(delivered?.from).toBe(SID);
  });
});
