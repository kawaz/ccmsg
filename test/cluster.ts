/** What a mesh test needs to stand several instances up and put one endpoint
 * under its own control.
 *
 * Shared rather than repeated: the two mesh test files exercise the same
 * cluster from different sides — the handshake that makes a link, and what
 * travels over it once there is one — and a second copy of "how an instance is
 * started" would let the two drift into testing different deployments. */
import { expect } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type InstanceId, PROTOCOL_VERSION } from "@ccmsg/protocol";
import { type Env, Instance, isRunning, start } from "../src/instance/index.ts";
import {
  EphemeralKey,
  type MeshJwk,
  MESH_PROTOCOL,
  MESH_VER,
  type ProofClaim,
} from "../src/mesh/index.ts";

const running: Instance[] = [];
const closing: (() => void)[] = [];

/** Let go of everything a test stood up.
 *
 * The instances go first, while the doubles they are linked to are still
 * there: that is the order §8.5 is about, and taking the far end away first
 * would be testing something else. */
export async function release(): Promise<void> {
  for (const instance of running.splice(0)) await instance.stop();
  for (const close of closing.splice(0)) close();
}

/** A port nothing is listening on.
 *
 * The peer list has to name the endpoints before any of them is bound, because
 * the whole point of §7.1 is that the list is written without knowing which
 * entry is whose — so the ports are picked first and handed to the instances. */
export function freePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = server.port as number;
  void server.stop(true);
  return port;
}

export function endpoint(port: number): InstanceId {
  return `ws://127.0.0.1:${port}`;
}

/** One instance's disposable home, configured to listen and to know the peers.
 *
 * The list is the same for every instance in a test, itself included, which is
 * exactly what §8.2 says a peer list is: one file that can go to all of them. */
export function homeFor(port: number, peers: readonly InstanceId[]): Env {
  const root = mkdtempSync(join(tmpdir(), "ccmsg-mesh-"));
  const home = join(root, "home");
  mkdirSync(join(home, "sessions"), { recursive: true });
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({ peers, entry: { host: "127.0.0.1", port } }),
  );
  return {
    CLAUDE_CONFIG_DIR: home,
    CCMSG_STATE_DIR: join(root, "state"),
    CCMSG_CONFIG_DIR: configDir,
  };
}

export interface Timing {
  readonly heartbeatMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly reconnectMinMs?: number;
}

/** A backoff long enough that no retry runs inside a test. A test that is about
 * reconnection sets its own. */
export const NO_RETRY: Timing = { reconnectMinMs: 60_000 };

export async function startAt(env: Env, timing: Timing = NO_RETRY): Promise<Instance> {
  const outcome = await start({ env, echoLog: false, meshTiming: timing });
  if (!isRunning(outcome)) throw new Error("another instance holds this config home");
  running.push(outcome);
  return outcome;
}

export function reachable(instance: Instance, peer: InstanceId): boolean {
  const found = instance.mesh?.instances(instance.self).find((one) => one.id === peer);
  return found?.reachable === true;
}

/** Wait for something the far end causes, by asking until it is true.
 *
 * Nothing on this side is notified when a peer finishes verifying us — the
 * event belongs to the other instance — so there is no handle to await. The
 * interval is a test's own and says nothing about the daemon. */
export async function eventually(
  what: () => boolean | Promise<boolean>,
  within = 5_000,
): Promise<void> {
  const until = Date.now() + within;
  while (Date.now() < until) {
    if (await what()) return;
    await Bun.sleep(5);
  }
  expect(await what()).toBe(true);
}

/** A peer under the test's control: it serves its own key endpoint, dials a
 * real instance, and says exactly what the case being tested wants said.
 *
 * It is the dialling side of mesh-peer-auth §5 with every value overridable,
 * which is what makes the refusals of §10.3 reachable — a correct
 * implementation cannot produce them. */
export class FakePeer {
  readonly key = new EphemeralKey();
  readonly id: InstanceId;
  readonly #server: ReturnType<typeof Bun.serve>;
  #ws: WebSocket | undefined;
  readonly #frames: Record<string, unknown>[] = [];
  #closeCode: number | undefined;
  /** What the greeting claims. Filled in by `greet` and overridable per case. */
  claim: Partial<{ ver: number; iss: InstanceId; aud: InstanceId; kid: string }> = {};
  /** What the proof asserts, over the defaults derived from the greeting. */
  claimOverride: Partial<ProofClaim> = {};
  /** The whole proof, when a case needs one no key could produce. */
  proof: ((claim: ProofClaim) => string) | undefined;
  /** The key served, when a case needs one that is not the signing key's. */
  jwk: (() => MeshJwk) | undefined;
  /** Called when the key is asked for, before the proof goes out. */
  onKeyAsked: (() => void) | undefined;

  constructor(port: number) {
    this.id = endpoint(port);
    this.#server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: async (request, srv) => {
        const path = new URL(request.url).pathname;
        // A probe is answered so that a real instance counts this endpoint as
        // reachable; nothing is done with the token, because a peer replaying
        // one is a case of its own below.
        if (path === "/mesh/probe") return Response.json({});
        if (path.startsWith("/mesh/jwk/")) return await this.#serveKey(request);
        // The real instance dials us too. The connection is accepted and its
        // greeting refused, which leaves this peer's own dial the only link
        // under test.
        if (path === "/ws" && srv.upgrade(request, { data: undefined })) return undefined;
        return new Response("Not Found", { status: 404 });
      },
      websocket: {
        message(ws, message) {
          const fields = JSON.parse(String(message)) as Record<string, unknown>;
          ws.send(
            JSON.stringify({
              ok: false,
              request_id: fields["request_id"],
              error: { code: "forbidden", msg: "this peer is a test double" },
            }),
          );
        },
      },
    });
    closing.push(() => {
      this.#ws?.close();
      void this.#server.stop(true);
    });
  }

  async #serveKey(request: Request): Promise<Response> {
    const asked = (await request.json()) as { challenge?: string };
    this.onKeyAsked?.();
    const claim: ProofClaim = {
      ver: MESH_VER,
      iss: this.claim.iss as InstanceId,
      aud: this.claim.aud as InstanceId,
      challenge: asked.challenge ?? "",
      exp: Math.floor(Date.now() / 1000) + 10,
      ...this.claimOverride,
    };
    const jws = this.proof === undefined ? this.key.proof(claim) : this.proof(claim);
    this.#ws?.send(JSON.stringify({ mesh: "proof", jws }));
    return Response.json(this.jwk === undefined ? this.key.jwk() : this.jwk());
  }

  /** Dial the instance and greet it. Answers with the reply, whatever it is. */
  async greet(target: InstanceId): Promise<Record<string, unknown>> {
    const ws = new WebSocket(`${target}/ws`, [MESH_PROTOCOL]);
    this.#ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => {
        resolve();
      });
      ws.addEventListener("error", () => {
        reject(new Error("the peer was not let in"));
      });
    });
    ws.addEventListener("message", (event: MessageEvent) => {
      for (const line of String(event.data).split("\n")) {
        if (line.trim() !== "") this.#frames.push(JSON.parse(line) as Record<string, unknown>);
      }
    });
    ws.addEventListener("close", (event: CloseEvent) => {
      this.#closeCode = event.code;
    });
    const mesh = {
      ver: MESH_VER,
      iss: this.id,
      aud: target,
      kid: this.key.kid,
      ...this.claim,
    };
    this.claim = mesh;
    ws.send(
      `${JSON.stringify({
        op: "hello",
        request_id: "peer-hello",
        role: "instance",
        protocol_version: PROTOCOL_VERSION,
        mesh,
      })}\n`,
    );
    return await this.#reply("peer-hello");
  }

  send(frame: object): void {
    this.#ws?.send(`${JSON.stringify(frame)}\n`);
  }

  /** The reply to a request this peer wrote on the link. */
  async answer(requestId: string): Promise<Record<string, unknown>> {
    return await this.#reply(requestId);
  }

  get closed(): boolean {
    return this.#closeCode !== undefined;
  }

  async #reply(requestId: string, within = 5_000): Promise<Record<string, unknown>> {
    const until = Date.now() + within;
    while (Date.now() < until) {
      const found = this.#frames.find((frame) => frame["request_id"] === requestId);
      if (found !== undefined) return found;
      if (this.#closeCode !== undefined) return { ok: false, closed: this.#closeCode };
      await Bun.sleep(5);
    }
    throw new Error(`${requestId} was never answered`);
  }
}

/** A real instance with one endpoint under the test's control beside it. */
export async function withFakePeer(timing: Timing = NO_RETRY): Promise<{
  instance: Instance;
  peer: FakePeer;
}> {
  const realPort = freePort();
  const peerPort = freePort();
  const peers = [endpoint(realPort), endpoint(peerPort)];
  const peer = new FakePeer(peerPort);
  const instance = await startAt(homeFor(realPort, peers), timing);
  return { instance, peer };
}
