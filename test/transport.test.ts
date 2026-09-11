import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type HelloResult,
  MAX_FRAME_BYTES,
  OP_NAMES,
  opAttributes,
  PROTOCOL_VERSION,
  validationErrors,
  OP_SCHEMAS,
} from "@ccmsg/protocol";
import { dispatch, type Handlers, type Requester } from "../src/dispatch/index.ts";
import {
  BaseConn,
  type Conn,
  ConnRegistry,
  createDriver,
  listenUds,
  Transport,
  serveWs,
  WriteQueue,
} from "../src/transport/index.ts";
import { connectUds, connectWs, type LineClient } from "./client.ts";
import { frameFor, SELF, SELF_ENDPOINT } from "./frames.ts";

/** `hello` answers with the contract's own result type, so the reply that
 * settles the identity is the reply the contract describes. The instance has
 * nothing to report yet, which the empty lists say honestly. */
const HELLO_RESULT: HelloResult = {
  protocol_version: PROTOCOL_VERSION,
  instance: SELF,
  endpoint: SELF_ENDPOINT,
  instances: [],
  capabilities: [],
  version: "0.0.1",
  started_at: 1_757_000_000_000,
};

/** An op that needs an identity, is open to the role the fixture's `hello`
 * claims, and stays on this instance — read from the attribute table so it
 * follows the table rather than a copy of it. */
const NEEDS_HELLO_OP = OP_NAMES.find((op) => {
  const attrs = opAttributes(op);
  return (
    attrs.needs_hello &&
    attrs.roles.includes("user") &&
    attrs.capability === undefined &&
    attrs.locality === "cluster"
  );
});

function handlers(): Handlers {
  const entries = OP_NAMES.map((op) => [
    op,
    () => (op === "hello.user" ? HELLO_RESULT : { handled: op }),
  ]);
  return Object.fromEntries(entries) as Handlers;
}

function handle(frame: unknown, conn: Requester) {
  return dispatch(frame, conn, {
    self: SELF,
    capabilities: new Set(),
    resolveInstance: () => undefined,
    handlers: handlers(),
  });
}

interface Bound {
  connect(): Promise<LineClient>;
  conns: ConnRegistry;
  seen: Conn[];
  transport: Transport;
}

const running: Transport[] = [];

afterEach(async () => {
  for (const transport of running.splice(0)) await transport.close();
});

describe("the driver answers what the handler could not", () => {
  /** A connection whose lines are collected instead of written to a socket. */
  function collecting(): { conn: Conn; sent: Record<string, unknown>[] } {
    const sent: Record<string, unknown>[] = [];
    const conn = new BaseConn(1, { send: (line) => sent.push(JSON.parse(line)), close: () => {} });
    return { conn, sent };
  }

  test("a handler that rejects is internal_error, on the request it was asked", async () => {
    const { conn, sent } = collecting();
    const rejected = Promise.reject(new Error("the handler gave up"));
    const driver = createDriver(conn, () => rejected);
    driver.line(JSON.stringify(frameFor("instance.ping")));
    await rejected.catch(() => {});
    await Promise.resolve();
    expect(sent[0]).toMatchObject({
      ok: false,
      request_id: "1",
      error: { code: "internal_error" },
    });
  });
});

function bindUds(): Bound {
  const conns = new ConnRegistry();
  const seen: Conn[] = [];
  const path = join(mkdtempSync(join(tmpdir(), "ccmsg-transport-")), "ccmsg.sock");
  const transport = new Transport();
  transport.add(listenUds({ path, conns, handle, onConn: (conn) => seen.push(conn) }));
  running.push(transport);
  return { connect: () => connectUds(path), conns, seen, transport };
}

function bindWs(): Bound {
  const conns = new ConnRegistry();
  const seen: Conn[] = [];
  const transport = new Transport();
  const listener = transport.add(
    serveWs({ port: 0, conns, handle, onConn: (conn) => seen.push(conn) }),
  );
  running.push(transport);
  return { connect: () => connectWs(listener.address), conns, seen, transport };
}

const TRANSPORTS: [string, () => Bound][] = [
  ["uds", bindUds],
  ["ws", bindWs],
];

describe("the fixture", () => {
  test("an op that needs hello exists in the table", () => {
    expect(NEEDS_HELLO_OP).toBeDefined();
  });

  test("the hello result passes the contract", () => {
    expect(
      validationErrors(OP_SCHEMAS["hello.user"].response, {
        ok: true,
        request_id: "1",
        ...HELLO_RESULT,
      }),
    ).toEqual([]);
  });
});

for (const [kind, bind] of TRANSPORTS) {
  describe(`${kind}: one connection, both directions`, () => {
    test("hello is answered on the same connection", async () => {
      const bound = bind();
      const client = await bound.connect();
      client.send(frameFor("hello.user"));
      expect(await client.next()).toMatchObject({
        ok: true,
        request_id: "1",
        instance: SELF,
        protocol_version: PROTOCOL_VERSION,
      });
    });

    test("hello binds the identity, and the next op reaches its handler", async () => {
      const bound = bind();
      const client = await bound.connect();
      client.send(frameFor("hello.user"));
      await client.next();
      // The op is refused before hello and answered after it, which is the
      // whole of what the binding does at this layer.
      client.send(frameFor(NEEDS_HELLO_OP!, { request_id: "2" }));
      expect(await client.next()).toMatchObject({
        ok: true,
        request_id: "2",
        handled: NEEDS_HELLO_OP,
      });
      expect(bound.seen[0]!.identity.state).toBe("settled");
    });

    test("an op that needs hello is refused before it", async () => {
      const bound = bind();
      const client = await bound.connect();
      client.send(frameFor(NEEDS_HELLO_OP!));
      expect(await client.next()).toMatchObject({
        ok: false,
        request_id: "1",
        error: { code: "hello_required" },
      });
    });

    test("a line that is not JSON is refused without a request id", async () => {
      const bound = bind();
      const client = await bound.connect();
      client.sendRaw("not json at all\n");
      const answer = await client.next();
      expect(answer).toMatchObject({ ok: false, error: { code: "bad_request" } });
      expect(answer["request_id"]).toBeUndefined();
    });

    test("a line past the limit is refused and the connection survives it", async () => {
      const bound = bind();
      const client = await bound.connect();
      client.sendRaw(`${"x".repeat(MAX_FRAME_BYTES + 1)}\n`);
      expect(await client.next()).toMatchObject({
        ok: false,
        error: { code: "bad_request" },
      });
      client.send(frameFor("hello.user"));
      expect(await client.next()).toMatchObject({ ok: true, request_id: "1" });
    });

    test("closing the connection drops what the connection held", async () => {
      const bound = bind();
      const client = await bound.connect();
      client.send(frameFor("hello.user"));
      await client.next();
      const conn = bound.seen[0]!;
      // The close listener is the transport's own signal that the connection
      // is gone, so the test waits on it rather than on a delay.
      const released = new Promise<void>((resolve) => conn.onClose(resolve));
      await client.close();
      await released;
      expect(bound.conns.size).toBe(0);
    });
  });
}

describe("stopping", () => {
  test("the unix socket is released last", async () => {
    const transport = new Transport();
    const closed: string[] = [];
    transport.add(fakeListener("uds", closed));
    transport.add(fakeListener("ws", closed));
    await transport.close();
    expect(closed).toEqual(["ws", "uds"]);
  });
});

function fakeListener(kind: "uds" | "ws", closed: string[]) {
  return {
    kind,
    address: kind,
    close: async () => {
      closed.push(kind);
    },
  };
}

describe("the write queue", () => {
  test("a line the socket refuses holds the ones behind it", () => {
    const sent: string[] = [];
    let blocked = true;
    const queue = new WriteQueue<string>({
      encode: (line) => line,
      write: (chunk) => {
        if (blocked) return chunk;
        sent.push(chunk);
        return undefined;
      },
    });
    queue.push("a\n");
    queue.push("b\n");
    expect(sent).toEqual([]);
    blocked = false;
    queue.drain();
    expect(sent).toEqual(["a\n", "b\n"]);
  });

  test("a partial write resumes from the remainder", () => {
    const sent: string[] = [];
    let accept = 1;
    const queue = new WriteQueue<string>({
      encode: (line) => line,
      write: (chunk) => {
        sent.push(chunk.slice(0, accept));
        return chunk.length > accept ? chunk.slice(accept) : undefined;
      },
    });
    queue.push("abc");
    expect(sent).toEqual(["a"]);
    accept = 10;
    queue.drain();
    expect(sent).toEqual(["a", "bc"]);
  });
});
