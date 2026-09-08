import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@ccmsg/protocol";
import { type Env, type Instance, isRunning, resolvePaths, start } from "../src/instance/index.ts";
import { connectWs, type LineClient } from "./client.ts";

/** Who may reach the WebSocket (daemon-v2 §3.1).
 *
 * Behaviour against a bound listener rather than against the policy function:
 * the three checks are asked at three different moments of one handshake — the
 * address and the `Origin` before anything is done with the request, the token
 * as the upgrade itself — and only a real handshake puts them in that order. */

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
  init: { origin?: string; protocols?: string[]; token?: string } = {},
): Promise<Response> {
  const url = new URL(`http://${instance.http[0]}/ws`);
  if (init.token !== undefined) url.searchParams.set("token", init.token);
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

describe("the entry token (§3.1)", () => {
  test("it is written where only this uid can read it, and reused across starts", async () => {
    const instance = await serving();
    const token = instance.entryToken;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const file = resolvePaths({
      CLAUDE_CONFIG_DIR: instance.paths.configHome,
      CCMSG_STATE_DIR: instance.paths.stateDir,
    }).entryTokenFile;
    // 0600: the boundary A4 names is the uid and the file permission, and this
    // file is what stands on it.
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // A second run over the same state directory answers the same token, so a
    // client configured once survives a restart.
    await instance.stop();
    running.splice(running.indexOf(instance), 1);
    const again = await start({
      env: {
        CLAUDE_CONFIG_DIR: instance.paths.configHome,
        CCMSG_STATE_DIR: instance.paths.stateDir,
        CCMSG_CONFIG_DIR: instance.paths.configFile.replace("/config.json", ""),
      },
      echoLog: false,
    });
    if (!isRunning(again)) throw new Error("the successor did not start");
    running.push(again);
    expect(again.entryToken).toBe(token);
  });

  test("an instance serving only the unix socket has no token to present", async () => {
    const root = mkdtempSync(join(tmpdir(), "ccmsg-entry-"));
    mkdirSync(join(root, "home", "sessions"), { recursive: true });
    const outcome = await start({
      env: {
        CLAUDE_CONFIG_DIR: join(root, "home"),
        CCMSG_STATE_DIR: join(root, "state"),
        CCMSG_CONFIG_DIR: join(root, "config"),
      },
      echoLog: false,
    });
    if (!isRunning(outcome)) throw new Error("another instance holds this config home");
    running.push(outcome);
    expect(outcome.http).toEqual([]);
    expect(outcome.entryToken).toBeUndefined();
  });

  test("a handshake without the token is refused, and one carrying it is let in", async () => {
    const instance = await serving();
    expect((await handshake(instance)).status).toBe(401);
    expect((await handshake(instance, { token: "not-the-token" })).status).toBe(401);
    expect((await handshake(instance, { token: instance.entryToken })).status).toBe(101);
  });

  test("a browser carries it as a subprotocol, and is answered with one it offered", async () => {
    // A browser cannot put a header on the handshake, so the token travels in
    // the one list it can set — and the reply has to name one of the values it
    // offered or the browser fails the connection itself.
    const instance = await serving();
    const accepted = await handshake(instance, {
      protocols: ["ccmsg.v1", `ccmsg.token.${instance.entryToken}`],
    });
    expect(accepted.status).toBe(101);
    expect(accepted.headers.get("sec-websocket-protocol")).toBe("ccmsg.v1");
    // Offering only the token is answered with the token, since that is the
    // only value there is to select.
    const only = await handshake(instance, {
      protocols: [`ccmsg.token.${instance.entryToken}`],
    });
    expect(only.status).toBe(101);
    expect(only.headers.get("sec-websocket-protocol")).toBe(`ccmsg.token.${instance.entryToken}`);
    expect((await handshake(instance, { protocols: ["ccmsg.token.wrong"] })).status).toBe(401);
  });

  test("a connection carrying the token speaks the protocol it was let in for", async () => {
    const instance = await serving();
    const client = await connectWs(instance.http[0] ?? "", instance.entryToken);
    clients.push(client);
    client.send({ op: "hello", request_id: "1", role: "user", protocol_version: PROTOCOL_VERSION });
    expect(await client.next()).toMatchObject({ ok: true, request_id: "1" });
  });
});

describe("the two allowlists (§3.1)", () => {
  test("no configured origin admits no browser", async () => {
    // An empty list is not "anyone": a permission nobody was granted is not a
    // permission. A request carrying no `Origin` is not a browser's and has
    // nothing to be compared, so it stands on the token alone.
    const instance = await serving();
    expect((await handshake(instance, { origin: "http://ui.example" })).status).toBe(403);
    expect((await handshake(instance, { token: instance.entryToken })).status).toBe(101);
  });

  test("a configured origin admits that one and refuses the rest", async () => {
    const instance = await serving({ origins: ["http://ui.example"] });
    expect(
      (await handshake(instance, { origin: "http://ui.example", token: instance.entryToken }))
        .status,
    ).toBe(101);
    expect((await handshake(instance, { origin: "http://elsewhere.example" })).status).toBe(403);
  });

  test("the address compared is the one the server saw, not the one a header claims", async () => {
    // The allowlist names an address nothing here connects from, so every
    // request is refused — and a forwarding header naming an allowed address
    // does not change that, since anyone who can reach the port can write one.
    const instance = await serving({ source_ips: ["10.11.12.13"] });
    expect((await handshake(instance, { token: instance.entryToken })).status).toBe(403);
    const url = new URL(`http://${instance.http[0]}/ws`);
    url.searchParams.set("token", instance.entryToken ?? "");
    const forged = await fetch(url, {
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
    expect((await handshake(instance, { token: instance.entryToken })).status).toBe(101);
  });
});
