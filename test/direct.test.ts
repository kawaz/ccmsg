import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  PEER_PROTOCOL,
} from "../src/messaging/index.ts";
import { connAs, OTHER_SID, SELF, SID } from "./frames.ts";

/** A stand-in for the harness's messaging socket: it speaks the same framing
 * (one JSON object per line) and records what arrived, and it is never a real
 * session — writing to one of those would put a message into somebody's turn. */
class FakeHarness {
  readonly lines: string[] = [];
  #buffer = "";
  #server: ReturnType<typeof Bun.listen> | undefined;

  constructor(
    readonly path: string,
    /** Written back on receipt, for the drop the harness answers with (§4.4). */
    private readonly reply?: string,
  ) {}

  listen(): void {
    this.#server = Bun.listen({
      unix: this.path,
      socket: {
        data: (socket, chunk) => {
          this.#buffer += Buffer.from(chunk).toString("utf8");
          const parts = this.#buffer.split("\n");
          this.#buffer = parts.pop() ?? "";
          this.lines.push(...parts);
          if (this.reply !== undefined) socket.write(`${this.reply}\n`);
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
}

const dirs: string[] = [];
const harnesses: FakeHarness[] = [];
afterEach(() => {
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
    reply?: string;
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
  const harness = new FakeHarness(socketPath, over.reply);
  harnesses.push(harness);
  if (over.listen !== false) harness.listen();
  return { configHome, sessionsDir, socketPath, harness };
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
    const { configHome, harness } = rig();
    const route = new ClaudeCodeSocketRoute({ configHome });

    expect(await route.send(SID, message("over the socket"))).toBe("delivered");

    const [auth, user] = await received(harness);
    expect(auth).toEqual({ type: "auth", token: TOKEN });
    const { message: body, ...frame } = user as { message: { content: string } };
    expect(frame).toEqual({
      type: "user",
      from: "ccmsg",
      session_id: SID,
      msg_id: `${SELF}/1`,
    });
    expect(parseDirectDelivery(body.content)?.text).toBe("over the socket");
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

  test("a session that names one of its drop reasons refused the message", async () => {
    const { configHome } = rig({
      reply: JSON.stringify({ type: "peer_message_status", status: "rate-limited" }),
    });
    const route = new ClaudeCodeSocketRoute({ configHome });
    expect(await route.send(SID, message())).toBe("refused");
  });

  test("a session that says something else has still received it", async () => {
    const { configHome } = rig({
      reply: JSON.stringify({ type: "peer_message_status", status: "delivered" }),
    });
    const route = new ClaudeCodeSocketRoute({ configHome });
    expect(await route.send(SID, message())).toBe("delivered");
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
      direct: new ClaudeCodeSocketRoute({ configHome }),
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
    const result = await messagingHandlers(target).message_send({
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
