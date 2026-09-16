import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthRecord } from "@ccmsg/protocol";
import { recordsDir } from "../src/auth/index.ts";
import { add, type Child, CommandError, Supervisor } from "../src/daemon/index.ts";
import { type Env, type Instance, isRunning, start } from "../src/instance/index.ts";
import { SoftAuthenticator } from "./authenticator.ts";
import { Host, reapOrphans, trackRoot, writeInstanceHome } from "./harness.ts";
import { leasePort } from "./mesh.ts";

/** What a stop does about the work it finds under way (DR-0015 §2.5).
 *
 * An instance's stop order settles what is persisted before it lets go of the
 * config home, and a supervisor's start waits for the child its loop will
 * spawn. Both wait on something that was true when they were asked and may not
 * be by the time it matters: a request past the door has not asked for its
 * write yet, and a loop asked to leave spawns nothing. These tests hold each
 * one open across the moment the stop begins. */

const running: Instance[] = [];
const hosts: Host[] = [];
const supervisors: Supervisor[] = [];
const runs: Promise<void>[] = [];

afterEach(async () => {
  for (const instance of running.splice(0)) await instance.stop();
  for (const supervisor of supervisors.splice(0)) await supervisor.stop();
  await Promise.all(runs.splice(0));
  for (const one of hosts.splice(0)) one.release();
});

afterAll(async () => {
  expect(await reapOrphans()).toEqual([]);
});

/** How long a stop is given to run to its end on its own. Longer than the
 * whole of the stop order on an idle instance, which is the listeners closing
 * and the log flushing: a stop still pending after this is one being held. */
const STOP_GRACE_MS = 1_000;

describe("an instance's stop and a request already past the door", () => {
  /** An instance serving the WebSocket, so the authentication routes exist. */
  async function serving(inFlightStopMs?: number): Promise<{ instance: Instance; origin: string }> {
    const lease = leasePort();
    await lease.release();
    const port = lease.port;
    const origin = `http://127.0.0.1:${String(port)}`;
    const root = mkdtempSync(join(tmpdir(), "ccmsg-stop-crossing-"));
    trackRoot(root);
    mkdirSync(join(root, "home", "sessions"), { recursive: true });
    writeInstanceHome(join(root, "config"), join(root, "home"), {
      entry: { host: "127.0.0.1", port },
    });
    const env: Env = {
      CLAUDE_CONFIG_DIR: join(root, "home"),
      CCMSG_STATE_DIR: join(root, "state"),
      CCMSG_CACHE_DIR: join(root, "cache"),
      CCMSG_CONFIG_DIR: join(root, "config"),
    };
    const outcome = await start({
      env,
      echoLog: false,
      ...(inFlightStopMs === undefined ? {} : { inFlightStopMs }),
    });
    if (!isRunning(outcome)) throw new Error("another instance holds this config home");
    running.push(outcome);
    return { instance: outcome, origin };
  }

  /** One `/auth/*` request as the page would make it, put to the route rather
   * than to the socket so the test holds the request object itself. */
  function post(
    at: { instance: Instance; origin: string },
    route: string,
    body: string | ReadableStream<Uint8Array>,
  ): Promise<Response | undefined> {
    const request = new Request(`http://${at.instance.http[0] as string}/auth/${route}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: at.origin,
        "sec-fetch-site": "same-origin",
      },
      body,
    });
    return at.instance.route(request, "127.0.0.1");
  }

  test("a write still in flight when the stop begins lands before the lock goes", async () => {
    const at = await serving();
    const { instance } = at;
    const issued = instance.auth.issue({ endpoint: `http://${instance.http[0] as string}/` });
    const authenticator = new SoftAuthenticator(issued.rp_id);
    const challenge = (await (await post(at, "challenge", "{}"))?.json()) as {
      challenge: string;
    };
    const credential = await authenticator.create({
      challenge: challenge.challenge,
      origin: at.origin,
      userId: issued.user_id,
    });
    const token = issued.url.slice(issued.url.indexOf("#register=") + "#register=".length);
    const registration = JSON.stringify({
      token,
      code: issued.code,
      device_label: "the laptop",
      credential,
    });

    // The body is what the test holds: the route has read the headers and is
    // waiting for the rest, which is the window a peer's answer or WebCrypto
    // opens in the field. Everything after it — the verification, the record,
    // the write — has not happened yet.
    let release = (): void => undefined;
    const held = new ReadableStream<Uint8Array>({
      start(controller) {
        release = (): void => {
          controller.enqueue(new TextEncoder().encode(registration));
          controller.close();
        };
      },
    });
    const inFlight = post(at, "register", held);
    const stopped = instance.stop();

    // The stop does not run to its end while the request is out.
    const early = await Promise.race([
      stopped.then(() => "stopped"),
      Bun.sleep(STOP_GRACE_MS).then(() => "held"),
    ]);
    expect(early).toBe("held");
    expect(existsSync(instance.paths.lockFile)).toBe(true);
    expect(existsSync(instance.paths.pidFile)).toBe(true);

    // A request arriving after the stop began is refused at the door.
    const late = await post(at, "challenge", "{}");
    expect(late?.status).toBe(503);

    release();
    const response = await inFlight;
    expect(response?.status).toBe(200);
    await stopped;
    expect(existsSync(instance.paths.lockFile)).toBe(false);

    // What the request wrote is in the file the successor reads, and nothing
    // wrote it after the stop had let go.
    const records = JSON.parse(
      readFileSync(join(recordsDir(instance.paths.stateDir), "records.json"), "utf8"),
    ) as AuthRecord[];
    const written = records.filter((record) => record.body.kind === "credential");
    expect(written.map((record) => record.body.kind === "credential" && record.body.sub)).toEqual([
      issued.sub,
    ]);
  });

  test("a request that outlasts the bound is left behind by name, not waited out", async () => {
    const bound = 200;
    const at = await serving(bound);
    const { instance } = at;
    // The route answers for the pages this instance holds a registration URL
    // for (contract, DR-0029), and the request has to get past that to be the
    // one in flight this is about.
    instance.auth.issue({ endpoint: `http://${instance.http[0] as string}/` });

    // Held open for longer than the stop will wait. The supervisor's graceful
    // stage is what the bound protects: one request must not be able to spend
    // the budget the flush and the listeners need.
    let release = (): void => undefined;
    const held = new ReadableStream<Uint8Array>({
      start(controller) {
        release = (): void => {
          controller.enqueue(new TextEncoder().encode("{}"));
          controller.close();
        };
      },
    });
    const inFlight = post(at, "register", held).catch(() => undefined);

    const began = Date.now();
    const stopped = instance.stop();
    const outcome = await Promise.race([
      stopped.then(() => "stopped"),
      Bun.sleep(STOP_GRACE_MS).then(() => "held"),
    ]);
    expect(outcome).toBe("stopped");
    expect(Date.now() - began).toBeGreaterThanOrEqual(bound);
    expect(existsSync(instance.paths.lockFile)).toBe(false);

    // What it could not wait for is said, with the name of the route, rather
    // than passed over: the writes that request ends with may land after the
    // flush, which is what the wait exists to prevent.
    const lines = readFileSync(instance.paths.logFile, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const leftBehind = lines.filter((line) => line["message"] === "stop_left_behind");
    expect(leftBehind.length).toBe(1);
    expect(leftBehind[0]?.["count"]).toBe(1);
    expect(leftBehind[0]?.["ops"]).toEqual(["POST /auth/register"]);
    expect(leftBehind[0]?.["after_ms"]).toBe(bound);

    release();
    await inFlight;
  });

  test("a stop with nothing under way says nothing about what it left", async () => {
    const at = await serving(200);
    const { instance } = at;
    await instance.stop();
    const lines = readFileSync(instance.paths.logFile, "utf8");
    expect(lines).not.toContain("stop_left_behind");
  });
});

describe("a supervisor's start and the stop that overtakes it", () => {
  /** A child that exits when it is told to, so a test can end a run without a
   * process to wait for. */
  function fakeChild(pid: number): Child & { die(code: number): void } {
    let end: (code: number) => void = () => undefined;
    const exited = new Promise<number>((resolve) => {
      end = resolve;
    });
    return {
      pid,
      exited,
      kill: () => end(143),
      die: (code) => end(code),
    };
  }

  function host(): Host {
    const one = new Host("ccmsg-stop-crossing-");
    hosts.push(one);
    one.adopt();
    return one;
  }

  async function register(dir: string): Promise<void> {
    const lease = leasePort();
    await lease.release();
    await add(process.env, dir, { port: lease.port });
  }

  test("a start waiting on a loop that is asked to leave is answered, not left", async () => {
    const at = host();
    const home = at.home("one");
    await register(home);

    const children: (Child & { die(code: number): void })[] = [];
    let pauses = 0;
    const supervisor = new Supervisor({
      // A backoff no test waits out: the loop is parked in it, and what ends
      // the wait is the stop.
      backoff: { minMs: 60_000, maxMs: 60_000, steadyMs: 60_000 },
      log: (line) => {
        if (line["event"] === "restarting") pauses += 1;
      },
      spawn: () => {
        const child = fakeChild(1000 + children.length);
        children.push(child);
        return child;
      },
    });
    supervisors.push(supervisor);
    runs.push(supervisor.run());
    await waitFor(() => children.length === 1);
    (children[0] as (typeof children)[number]).die(1);
    await waitFor(() => pauses === 1);

    // Asked while the loop waits out the backoff: there is no child to answer
    // with yet, so the start waits for the one the loop will spawn next.
    const starting = supervisor.startOne(home);
    const stopping = supervisor.stop();
    const outcome = await Promise.race([
      starting.then(
        () => "started",
        (cause: unknown) => cause,
      ),
      Bun.sleep(STOP_GRACE_MS).then(() => "hung"),
    ]);
    expect(outcome).toBeInstanceOf(CommandError);
    expect((outcome as CommandError).code).toBe("instance_unreachable");
    expect((outcome as CommandError).message).toContain("停止中");
    await stopping;
    // Leaving spawned nothing for the start it answered.
    expect(children.length).toBe(1);
  });

  test("a start overtaken by a stop of that instance is told so, not that the start failed", async () => {
    const at = host();
    const home = at.home("one");
    await register(home);
    const later = at.home("two");

    const children: Child[] = [];
    const supervisor = new Supervisor({
      stopTimeoutMs: 50,
      log: () => undefined,
      spawn: () => {
        const child = fakeChild(2000 + children.length);
        children.push(child);
        return child;
      },
    });
    supervisors.push(supervisor);
    runs.push(supervisor.run());
    await waitFor(() => children.length === 1);

    // The second config home is spawned for and never publishes a socket, so
    // the start is waiting for it when the stop arrives and takes the child
    // down.
    const starting = supervisor.addOne(later);
    await waitFor(() => children.length === 2);
    await supervisor.stopOne(later);
    const outcome = await starting.then(
      () => "started",
      (cause: unknown) => cause,
    );
    expect(outcome).toBeInstanceOf(CommandError);
    expect((outcome as CommandError).code).toBe("instance_unreachable");
    expect((outcome as CommandError).message).not.toContain("起動に失敗");
  });
});

async function waitFor(ready: () => boolean, turns = 1000): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    if (ready()) return;
    await Bun.sleep(1);
  }
  throw new Error("what the test was waiting for did not happen");
}
