import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@ccmsg/protocol";
import { type Env, type Instance, isRunning, start } from "../src/instance/index.ts";
import { entryPath } from "../src/transport/index.ts";
import { connectWs, type LineClient } from "./client.ts";

/** Who may reach the WebSocket (daemon-v2 §3.1).
 *
 * Behaviour against a bound listener rather than against the policy function:
 * the checks are asked at two different moments of one handshake — the address
 * and the `Origin` before anything is done with the request, the upgrade
 * itself afterwards — and only a real handshake puts them in that order. */

const running: Instance[] = [];
const clients: LineClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const instance of running.splice(0)) await instance.stop();
});

/** An instance serving a WebSocket, with the entry section the test wants. */
async function serving(entry: Record<string, unknown> = {}): Promise<Instance> {
  const root = mkdtempSync(join(tmpdir(), "ccmsg-entry-"));
  mkdirSync(join(root, "home", "sessions"), { recursive: true });
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(
    join(root, "config", "config.json"),
    JSON.stringify({ defaults: { entry: { host: "127.0.0.1", port: 0, ...entry } } }),
  );
  const env: Env = {
    CLAUDE_CONFIG_DIR: join(root, "home"),
    CCMSG_STATE_DIR: join(root, "state"),
    CCMSG_CONFIG_DIR: join(root, "config"),
  };
  const outcome = await start({ env, echoLog: false });
  if (!isRunning(outcome)) throw new Error("another instance holds this config home");
  running.push(outcome);
  return outcome;
}

/** The handshake as a plain HTTP request, which is what lets a test set the
 * headers a WebSocket client would not let it set. A `101` means the upgrade
 * was accepted; anything else is the status of the refusal. */
function handshake(
  instance: Instance,
  init: { origin?: string; protocols?: string[]; path?: string } = {},
): Promise<Response> {
  const url = new URL(`http://${instance.http[0]}${init.path ?? "/ws"}`);
  const headers: Record<string, string> = {
    connection: "Upgrade",
    upgrade: "websocket",
    "sec-websocket-version": "13",
    "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
  };
  if (init.origin !== undefined) headers["origin"] = init.origin;
  if (init.protocols !== undefined) headers["sec-websocket-protocol"] = init.protocols.join(", ");
  return fetch(url, { headers });
}

describe("the handshake (§3.1)", () => {
  test("a person presents nothing, and is let in on the address alone", async () => {
    // What the person is will be a passkey (DR-0001); until it is, an instance
    // bound to loopback takes the connections that can reach it.
    const instance = await serving();
    expect((await handshake(instance)).status).toBe(101);
    const client = await connectWs(instance.http[0] ?? "");
    clients.push(client);
    client.send({ op: "hello", request_id: "1", role: "user", protocol_version: PROTOCOL_VERSION });
    expect(await client.next()).toMatchObject({ ok: true, request_id: "1" });
  });

  test("the reply names one of the subprotocols offered", async () => {
    // A browser fails a connection whose reply names none of what it asked
    // for, and one that offered nothing must not be answered with a name.
    const instance = await serving();
    const offered = await handshake(instance, { protocols: ["ccmsg.v1", "ccmsg.v2"] });
    expect(offered.status).toBe(101);
    expect(offered.headers.get("sec-websocket-protocol")).toBe("ccmsg.v1");
    const bare = await handshake(instance);
    expect(bare.status).toBe(101);
    expect(bare.headers.get("sec-websocket-protocol")).toBeNull();
  });
});

describe("the entry is matched at the end of the path (DR-0001 §2.7)", () => {
  test("a proxy's prefix reaches the same door, and a near miss does not", async () => {
    const instance = await serving();
    expect((await handshake(instance, { path: "/personal/ws" })).status).toBe(101);
    expect((await handshake(instance, { path: "/a/b/ws" })).status).toBe(101);
    expect((await handshake(instance, { path: "/notws" })).status).toBe(404);
    expect((await handshake(instance, { path: "/ws/more" })).status).toBe(404);
  });

  test("the boundary before the segment has to be a separator", () => {
    expect(entryPath("/ws", "/ws")).toBe(true);
    expect(entryPath("/personal/ws", "/ws")).toBe(true);
    expect(entryPath("/notws", "/ws")).toBe(false);
    expect(entryPath("/ws/more", "/ws")).toBe(false);
    expect(entryPath("/", "/ws")).toBe(false);
  });
});

describe("the two allowlists (§3.1)", () => {
  test("no configured origin admits no browser", async () => {
    // An empty list is not "anyone": a permission nobody was granted is not a
    // permission. A request carrying no `Origin` is not a browser's and has
    // nothing to be compared, so it is judged on the address alone.
    const instance = await serving();
    expect((await handshake(instance, { origin: "http://ui.example" })).status).toBe(403);
    expect((await handshake(instance)).status).toBe(101);
  });

  test("a configured origin admits that one and refuses the rest", async () => {
    const instance = await serving({ origins: ["http://ui.example"] });
    expect((await handshake(instance, { origin: "http://ui.example" })).status).toBe(101);
    expect((await handshake(instance, { origin: "http://elsewhere.example" })).status).toBe(403);
  });

  test("the address compared is the one the server saw, not the one a header claims", async () => {
    // The allowlist names an address nothing here connects from, so every
    // request is refused — and a forwarding header naming an allowed address
    // does not change that, since anyone who can reach the port can write one.
    const instance = await serving({ source_ips: ["10.11.12.13"] });
    expect((await handshake(instance)).status).toBe(403);
    const forged = await fetch(`http://${instance.http[0]}/ws`, {
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "x-forwarded-for": "10.11.12.13",
      },
    });
    expect(forged.status).toBe(403);
  });

  test("the address this host connects from is admitted when it is listed", async () => {
    const instance = await serving({ source_ips: ["127.0.0.1"] });
    expect((await handshake(instance)).status).toBe(101);
  });
});
