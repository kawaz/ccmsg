import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type LlmRequestInfo,
  type LlmStatusReport,
  PROTOCOL_VERSION,
  TOPIC_SCHEMAS,
  validationErrors,
} from "@ccmsg/protocol";
import { type Env, type Instance, isRunning, start } from "../src/instance/index.ts";
import { GATEWAY_LIVE_WINDOW_MS } from "../src/sessions/index.ts";
import {
  Gateway,
  LlmRequests,
  type LlmRequestObservation,
  parseGatewayItem,
  reportOf,
} from "../src/upstream/index.ts";
import { connectWs, type LineClient } from "./client.ts";
import { SELF, SID } from "./frames.ts";

const TOKEN = "webhook-secret-0123456789";
const SOURCE = "llm-gateway";
const NOW = 1_800_000_000_000;

/** One forwarding notice, in the gateway's own spelling (DR-0012): instants as
 * plain numbers of Unix milliseconds, the session under `session_id`, and the
 * three chain instants without the suffix this contract requires. */
function requestEvent(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ts: NOW,
    session_id: SID,
    ns: "personal",
    model: "claude-opus-5",
    credential: "claude-one",
    status: 200,
    prefix: "2cf24dba",
    origin: "main",
    cache_ttl_secs: 3600,
    cache_expires_at: NOW + 3_600_000,
    cache_paused: false,
    cache_since: NOW,
    cache_count: 0,
    next_keepalive_at: NOW + 3_300_000,
    cache_until: NOW + 33_300_000,
    cache_until_count: 9,
    cache_breakeven_until: NOW + 69_300_000,
    cache_breakeven_count: 20,
    ...extra,
  };
}

/** The same notice, read into what the topic holds. */
function observation(ts: number): LlmRequestObservation {
  const item = parseGatewayItem(requestEvent({ ts, cache_expires_at: ts + 3_600_000 }));
  if (item?.kind !== "request") throw new Error("the request event no longer reads as one");
  return item.info;
}

/** The answer's own notice, which names its kind. */
function responseEvent(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "response",
    ts: NOW + 12_000,
    request_ts: NOW,
    session_id: SID,
    prefix: "2cf24dba",
    ns: "personal",
    model: "claude-opus-5",
    credential: "claude-one",
    origin: "main",
    status: 200,
    stop_reason: "end_turn",
    aborted: false,
    ...extra,
  };
}

const REPORT = {
  schema_version: 2,
  generated_at: NOW,
  overall: { severity: "critical", service_counts: { ok: 1, critical: 1 } },
  services: [
    {
      id: "anthropic",
      name: "Anthropic",
      severity: "critical",
      routes: ["claude-one"],
      official: {
        state: "major_outage",
        source: "statuspage_v2",
        source_url: "https://status.example/",
        observed_at: NOW - 20_000,
        stale: false,
        components: [{ id: "c1", name: "Claude API", state: "partial_outage" }],
        incidents: [{ id: "i1", name: "Elevated errors", state: "investigating" }],
      },
      observed: {
        state: "failing",
        observed_at: NOW - 28_000,
        last_failure: { at: NOW, status: 529 },
      },
    },
  ],
};

const running: Instance[] = [];
const clients: LineClient[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const instance of running.splice(0)) await instance.stop();
  for (const server of servers.splice(0)) await server.stop(true);
});

/** A gateway that answers its status endpoint, and counts the reads. */
function fakeGateway(report: unknown = REPORT): { url: string; reads: () => number } {
  let reads = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname !== "/llm-gateway/status") {
        return new Response("Not Found", { status: 404 });
      }
      reads += 1;
      return Response.json(report);
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, reads: () => reads };
}

interface Started {
  instance: Instance;
  address: string;
  /** The config home, for a test that puts a harness session in it. */
  home: string;
  post(body: unknown, init?: { token?: string; path?: string }): Promise<Response>;
}

/** An instance with the gateway its `upstream` names, or none at all.
 *
 * The token file is written first and handed to the caller, because what the
 * config points at and what the gateway wrote have to be the same file. */
async function startWith(
  upstream?: (tokenFile: string) => Record<string, string>,
): Promise<Started> {
  const root = mkdtempSync(join(tmpdir(), "ccmsg-gateway-"));
  const home = join(root, "home");
  mkdirSync(join(home, "sessions"), { recursive: true });
  const tokenFile = join(root, "webhook.token");
  writeFileSync(tokenFile, `${TOKEN}\n`);
  const config: Record<string, unknown> = { entry: { host: "127.0.0.1", port: 0 } };
  if (upstream !== undefined) config["upstream"] = upstream(tokenFile);
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config", "config.json"), JSON.stringify({ defaults: config }));
  const env: Env = {
    CLAUDE_CONFIG_DIR: home,
    CCMSG_STATE_DIR: join(root, "state"),
    CCMSG_CONFIG_DIR: join(root, "config"),
  };
  const outcome = await start({ env, echoLog: false });
  if (!isRunning(outcome)) throw new Error("another instance holds this config home");
  running.push(outcome);
  const address = outcome.http[0] ?? "";
  return {
    instance: outcome,
    address,
    home,
    post: (body, init = {}) =>
      fetch(`http://${address}${init.path ?? `/webhook/${SOURCE}`}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${init.token ?? TOKEN}`,
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
  };
}

/** An access token for a person, minted by the instance under test.
 *
 * A WebSocket handshake presents one (DR-0001 §2.5), and a test has no browser
 * and no authenticator — so it asks the instance for a session directly, which
 * is what `/auth/assert` would have answered. */
function personToken(instance: Instance): string {
  return instance.auth.mint("test-person").session.access.value;
}

/** The upstream section of an instance wired to a gateway both ways. */
function wiredTo(gatewayUrl: string) {
  return (tokenFile: string): Record<string, string> => ({
    gateway_url: gatewayUrl,
    gateway_webhook_source: SOURCE,
    gateway_webhook_token_file: tokenFile,
  });
}

/** Greet as a person and subscribe, returning the reply to the subscribe. */
async function subscribe(started: Started, topic: string): Promise<LineClient> {
  const client = await connectWs(started.address, personToken(started.instance));
  clients.push(client);
  client.send({ op: "hello", request_id: "h", role: "user", protocol_version: PROTOCOL_VERSION });
  await client.next();
  client.send({ op: "topic_subscribe", request_id: "s", topic });
  return client;
}

/** The next frame on a topic, skipping the replies that arrive beside it. */
async function nextTopic(client: LineClient, topic: string): Promise<Record<string, unknown>> {
  for (;;) {
    const frame = await client.next();
    if (frame["ev"] === "topic" && frame["topic"] === topic) return frame;
  }
}

describe("what the gateway posts (§3.5, §5.1)", () => {
  test("a request event reaches `llm_requests` under this contract's names", async () => {
    const gateway = fakeGateway();
    const started = await startWith(wiredTo(gateway.url));
    const client = await subscribe(started, "llm_requests");
    // The snapshot: nothing has been posted yet.
    expect((await nextTopic(client, "llm_requests"))["data"]).toEqual([]);

    expect((await started.post([requestEvent()])).status).toBe(204);

    const frame = await nextTopic(client, "llm_requests");
    const [info] = frame["data"] as LlmRequestInfo[];
    expect(info).toEqual({
      received_at: NOW,
      sid: SID,
      instance: started.instance.self,
      main: true,
      prefix: "2cf24dba",
      origin: "main",
      ns: "personal",
      model: "claude-opus-5",
      credential: "claude-one",
      status: 200,
      cache_ttl_secs: 3600,
      cache_expires_at: NOW + 3_600_000,
      cache_paused: false,
      cache_count: 0,
      next_keepalive_at: NOW + 3_300_000,
      cache_until_count: 9,
      cache_breakeven_count: 20,
      // The three instants the gateway spells without the suffix.
      cache_since_at: NOW,
      cache_until_at: NOW + 33_300_000,
      cache_breakeven_until_at: NOW + 69_300_000,
    });
    expect(validationErrors(TOPIC_SCHEMAS["llm_requests"], frame)).toEqual([]);
  });

  test("the whole unexpired set travels, so a later subscriber sees the window", async () => {
    const gateway = fakeGateway();
    const started = await startWith(wiredTo(gateway.url));
    // Posted before anyone is listening: the countdown began without a witness.
    const now = Date.now();
    await started.post([requestEvent({ ts: now, cache_expires_at: now + 600_000 })]);

    const client = await subscribe(started, "llm_requests");
    const frame = await nextTopic(client, "llm_requests");
    expect(frame["snapshot"]).toBe(true);
    expect((frame["data"] as LlmRequestInfo[]).map((info) => info.received_at)).toEqual([now]);
  });

  test("a request and its answer both move when the session was last seen", async () => {
    const gateway = fakeGateway();
    const started = await startWith(wiredTo(gateway.url));
    const now = Date.now();
    await started.post([requestEvent({ ts: now, cache_expires_at: now + 600_000 })]);
    expect(started.instance.gatewayActiveAt(SID)).toBe(now);

    // The answer says nothing about the cache window the request opened, and
    // everything about the session still running.
    await started.post([responseEvent({ ts: now + 12_000, request_ts: now })]);
    expect(started.instance.gatewayActiveAt(SID)).toBe(now + 12_000);
  });

  test("a subagent's series does not become the session's own", async () => {
    const gateway = fakeGateway();
    const started = await startWith(wiredTo(gateway.url));
    const client = await subscribe(started, "llm_requests");
    await nextTopic(client, "llm_requests");

    // Both travel under the session's own id, with system prompts of their own.
    await started.post([
      requestEvent({ prefix: "sub-one", origin: "sub", ts: NOW + 1 }),
      requestEvent({ prefix: "own-one", origin: "main" }),
    ]);

    let rows: LlmRequestInfo[] = [];
    while (rows.length < 2)
      rows = (await nextTopic(client, "llm_requests"))["data"] as LlmRequestInfo[];
    expect(rows.filter((row) => row.main).map((row) => row.prefix)).toEqual(["own-one"]);
  });

  test("a delivery mixes kinds, and the ones nothing reads cost the others nothing", async () => {
    const gateway = fakeGateway();
    const started = await startWith(wiredTo(gateway.url));
    const client = await subscribe(started, "llm_requests");
    await nextTopic(client, "llm_requests");

    const answer = await started.post([
      { type: "cache_keepalive", ts: NOW, session_id: SID, prefix: "p", nonce: "n", deadline: NOW },
      { type: "keepalive_paused", session_id: SID, paused_at: NOW },
      "not an event at all",
      requestEvent(),
    ]);
    expect(answer.status).toBe(204);
    expect((await nextTopic(client, "llm_requests"))["data"]).toHaveLength(1);
  });
});

describe("what the sessions domain is told about inference (§5.1, §5.2)", () => {
  /** A `LlmRequests` on its own, with what it publishes and what it wakes
   * counted separately. */
  function requests(): {
    subject: LlmRequests;
    frames: () => number;
    woken: () => number;
  } {
    let frames = 0;
    let woken = 0;
    const subject = new LlmRequests({
      self: SELF,
      publish: () => {
        frames += 1;
      },
      onActivity: () => {
        woken += 1;
      },
    });
    return { subject, frames: () => frames, woken: () => woken };
  }

  test("a session seen again inside its window wakes nothing", () => {
    const { subject, frames, woken } = requests();
    const now = Date.now();
    for (let index = 0; index < 10; index += 1) {
      subject.record(observation(now + index * 100));
      subject.note(SID, now + index * 100 + 50);
    }
    // The window opened once, and the twenty events after it moved a clock.
    expect(woken()).toBe(1);
    // The countdown is still the topic's own value, so each request states it.
    expect(frames()).toBe(10);
  });

  test("a session the window had closed on wakes it again", () => {
    const { subject, woken } = requests();
    const now = Date.now();
    subject.record(observation(now - 2 * GATEWAY_LIVE_WINDOW_MS));
    subject.record(observation(now));

    expect(woken()).toBe(2);
  });

  /** One row without the attribute that moves on its own. */
  function shape(row: Record<string, unknown> | undefined): string {
    const { gateway_active_at: _clock, last_activity_at: _seen, ...rest } = row ?? {};
    return JSON.stringify(rest);
  }

  test("a run of events leaves `peers` where it was", async () => {
    const gateway = fakeGateway();
    const started = await startWith(wiredTo(gateway.url));
    // A session the harness names, so the gateway's word about it lands on a
    // row this instance publishes.
    writeFileSync(
      join(started.home, "sessions", `${process.pid}.json`),
      JSON.stringify({
        pid: process.pid,
        sessionId: SID,
        cwd: started.home,
        kind: "interactive",
        startedAt: NOW,
      }),
    );
    // The window is opened before anyone is listening, so what the subscriber
    // then sees is only what the events after it did.
    const now = Date.now();
    await started.post([requestEvent({ ts: now, cache_expires_at: now + 3_600_000 })]);

    const client = await subscribe(started, "peers");
    let row: Record<string, unknown> | undefined;
    while (row?.["gateway_active_at"] === undefined) {
      const frame = await nextTopic(client, "peers");
      row = (frame["data"] as { peers: Record<string, unknown>[] }).peers[0];
    }
    // The session appearing in the harness is a change of its own, and the
    // watch behind it reports the write in its own time. Counting starts once
    // that has gone quiet, so what is counted is what the events did.
    let last = shape(row);
    let repeats = 0;
    let counting = false;
    let quiet: (() => void) | undefined;
    void (async () => {
      for (;;) {
        const frame = await client.next();
        if (frame["ev"] !== "topic" || frame["topic"] !== "peers") continue;
        const seen = shape((frame["data"] as { peers: Record<string, unknown>[] }).peers[0]);
        // Frames whose only difference is the clock are the ones a run of
        // events must not produce. One carrying a structural change is another
        // matter, and the instance may send that whenever it has one.
        if (counting && seen === last) repeats += 1;
        last = seen;
        quiet?.();
      }
    })().catch(() => {});
    for (;;) {
      const heard = await new Promise<boolean>((settle) => {
        quiet = () => settle(true);
        setTimeout(() => settle(false), 200);
      });
      quiet = undefined;
      if (!heard) break;
    }
    counting = true;

    for (let index = 1; index <= 10; index += 1) {
      await started.post([requestEvent({ ts: now + index, cache_expires_at: now + 3_600_000 })]);
    }
    await Bun.sleep(150);

    // Each of them moved the row's clock and nothing else.
    expect(repeats).toBe(0);
  });
});

describe("the report the gateway is asked for (§6.2, whole value)", () => {
  test("subscribing reads it once, and the frame is the contract's", async () => {
    const gateway = fakeGateway();
    const started = await startWith(wiredTo(gateway.url));

    const client = await subscribe(started, "llm_status");
    const frame = await nextTopic(client, "llm_status");
    const report = frame["data"] as LlmStatusReport;
    expect(report.overall.severity).toBe("critical");
    expect(report.services[0]?.official?.state).toBe("major_outage");
    expect(report.services[0]?.observed?.state).toBe("failing");
    expect(validationErrors(TOPIC_SCHEMAS["llm_status"], frame)).toEqual([]);
    expect(gateway.reads()).toBe(1);
  });

  test("a vocabulary this contract cannot draw arrives as unknown", () => {
    const report = reportOf({
      overall: { severity: "catastrophic", service_counts: { ok: 1, bad: "2" } },
      services: [
        { id: "a", name: "A", severity: "ok", routes: ["r", 7], official: { state: "on_fire" } },
        { name: "no id" },
      ],
    });
    expect(report?.overall.severity).toBe("unknown");
    expect(report?.overall.service_counts).toEqual({ ok: 1 });
    // The service that could not be named at all is dropped rather than shown
    // with an invented id.
    expect(report?.services).toHaveLength(1);
    expect(report?.services[0]?.routes).toEqual(["r"]);
    expect(report?.services[0]?.official?.state).toBe("unknown");
  });

  test("an instant the gateway spelled as text does not travel as one", () => {
    const report = reportOf({
      generated_at: "2026-09-08T00:00:00Z",
      overall: { severity: "ok", service_counts: {} },
      services: [
        {
          id: "a",
          name: "A",
          severity: "ok",
          routes: [],
          official: { state: "operational", observed_at: "2026-09-08T00:00:00Z", updatedAt: NOW },
        },
      ],
    });
    expect(report).not.toHaveProperty("generated_at");
    expect(report?.services[0]?.official).not.toHaveProperty("observed_at");
    // A field renamed on the far side arrives as a field this contract does
    // not have, so it is not carried at all.
    expect(report?.services[0]?.official).not.toHaveProperty("updatedAt");
    expect(
      validationErrors(TOPIC_SCHEMAS["llm_status"], {
        ev: "topic",
        topic: "llm_status",
        instance: SELF,
        data: report,
      }),
    ).toEqual([]);
  });

  test("a refused request has the report re-read once, after the burst settles", async () => {
    const gateway = fakeGateway();
    const published: unknown[] = [];
    const instance = new Gateway({
      self: SELF,
      setup: { statusUrl: `${gateway.url}/llm-gateway/status` },
      publish: (_topic, data) => published.push(data),
      settleMs: 1,
    });
    instance.status?.start();
    await instance.status?.read();
    expect(gateway.reads()).toBe(1);

    // One upstream failure arrives as several refusals, one per route tried.
    for (let n = 0; n < 5; n += 1) instance.status?.noteRequestStatus(529);
    await Bun.sleep(60);
    expect(gateway.reads()).toBe(2);
    expect(published).toHaveLength(2);

    // A refusal that belongs to a credential rather than to the service is not
    // a reason to re-read.
    for (const status of [200, 401, 429, 500]) instance.status?.noteRequestStatus(status);
    await Bun.sleep(30);
    expect(gateway.reads()).toBe(2);
    instance.close();
  });
});

describe("who may post, and what an instance without a gateway has (§3.1, §5.2)", () => {
  test("a delivery without the gateway's secret is refused", async () => {
    const gateway = fakeGateway();
    const started = await startWith(wiredTo(gateway.url));

    expect((await started.post([requestEvent()], { token: "wrong" })).status).toBe(401);
    expect((await started.post([requestEvent()], { token: "" })).status).toBe(401);
    // A source this instance was not configured for does not exist, which is
    // also what keeps the answer from naming what could be turned on.
    expect((await started.post([requestEvent()], { path: "/webhook/other" })).status).toBe(404);
    expect((await started.post("{ not json", {})).status).toBe(400);
  });

  test("the source is read from the end of the path, whatever prefix it arrives under", async () => {
    // A gateway posts to whatever URL its operator gave it, which may sit under
    // a proxy's prefix. Which instance was meant is settled by the address the
    // proxy forwarded to; what still has to be right is the source and the
    // token (DR-0001 §2.7).
    const gateway = fakeGateway();
    const started = await startWith(wiredTo(gateway.url));
    expect(
      (await started.post([requestEvent()], { path: `/personal/webhook/${SOURCE}` })).status,
    ).toBe(204);
    expect((await started.post([requestEvent()], { path: `/a/b/webhook/${SOURCE}` })).status).toBe(
      204,
    );
    // The prefix does not smuggle a source in: the last marker is the one read.
    expect(
      (await started.post([requestEvent()], { path: `/webhook/${SOURCE}/webhook/other` })).status,
    ).toBe(404);
  });

  test("with no gateway configured there is no route and no capability", async () => {
    const started = await startWith();
    const client = await connectWs(started.address, personToken(started.instance));
    clients.push(client);
    client.send({ op: "hello", request_id: "h", role: "user", protocol_version: PROTOCOL_VERSION });
    const hello = await client.next();
    expect(hello["capabilities"]).toEqual([]);

    for (const topic of ["llm_requests", "llm_status"]) {
      client.send({ op: "topic_subscribe", request_id: topic, topic });
      const reply = await client.next();
      expect(reply["ok"]).toBe(false);
      expect((reply["error"] as { code: string }).code).toBe("capability_unavailable");
    }
    expect((await started.post([requestEvent()])).status).toBe(404);
  });

  test("each half of the config grants its own capability", async () => {
    const gateway = fakeGateway();
    const posted = await startWith((tokenFile) => ({
      gateway_webhook_source: SOURCE,
      gateway_webhook_token_file: tokenFile,
    }));
    const asked = await startWith(() => ({ gateway_url: gateway.url }));

    for (const [started, expected] of [
      [posted, ["llm_events"]],
      // The address is one setting and answers three questions, so it grants
      // the three capabilities together.
      [asked, ["llm_status", "llm_usage", "llm_stats"]],
    ] as const) {
      const client = await connectWs(started.address, personToken(started.instance));
      clients.push(client);
      client.send({
        op: "hello",
        request_id: "h",
        role: "user",
        protocol_version: PROTOCOL_VERSION,
      });
      const hello = await client.next();
      expect(hello["capabilities"]).toEqual([...expected]);
    }
  });

  test("a webhook source whose secret cannot be read ends the start (DV-Q9)", async () => {
    // The route it asked for would be silently absent otherwise, and an
    // instance nobody can post to looks exactly like one nobody is posting to.
    let refused: unknown;
    try {
      await startWith(() => ({
        gateway_webhook_source: SOURCE,
        gateway_webhook_token_file: "/nowhere/token",
      }));
    } catch (cause) {
      refused = cause;
    }
    expect(String(refused)).toMatch(/token file/);
  });
});

describe("reading one posted item", () => {
  test("an item that names a kind is never read as a request", () => {
    // A response carries a `session_id` and a `ts` of its own, so reading it by
    // position would restart the series' countdown from when its answer ended.
    expect(parseGatewayItem(responseEvent())).toEqual({
      kind: "response",
      info: { sid: SID, at: NOW + 12_000 },
    });
    expect(parseGatewayItem({ type: "something_new", ts: NOW, session_id: SID })).toBeUndefined();
  });

  test("an event the gateway could not attribute to a session is passed over", () => {
    // A call made by something that is not a session is the ordinary case, not
    // a schema that moved, so it must not be counted as unreadable.
    expect(parseGatewayItem(requestEvent({ session_id: null }))).toEqual({ kind: "ignored" });
    expect(parseGatewayItem(responseEvent({ session_id: null }))).toEqual({ kind: "ignored" });
    // An instant in a shape this wire does not use is a schema that moved.
    expect(parseGatewayItem(requestEvent({ ts: "2026-09-08T00:00:00Z" }))).toBeUndefined();
  });

  test("a field in a shape this contract does not state is left behind", () => {
    const item = parseGatewayItem(
      requestEvent({ cache_until: "later", status: "200", cache_paused: "no", prefix: 7 }),
    );
    expect(item?.kind).toBe("request");
    const info = (item as { info: Record<string, unknown> }).info;
    expect(info).not.toHaveProperty("cache_until_at");
    expect(info).not.toHaveProperty("status");
    expect(info).not.toHaveProperty("cache_paused");
    expect(info).not.toHaveProperty("prefix");
  });
});
