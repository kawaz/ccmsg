import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type LlmStatsReadResult,
  type LlmUsageReadResult,
  OP_SCHEMAS,
  PROTOCOL_VERSION,
  validationErrors,
} from "@ccmsg/protocol";
import { type Env, type Instance, isRunning, start } from "../src/instance/index.ts";
import { connectUds, type LineClient } from "./client.ts";

const NOW = 1_800_000_000_000;

/** The gateway's own spelling of a quota reading (`reset`, `window_seconds`,
 * `login_path`), which is what the conversion at the boundary is about. */
const USAGE = {
  generated_at: NOW,
  credentials: [
    {
      name: "personal",
      type: "claude_oauth",
      support: "observed",
      auth: {
        status: "relogin_required",
        reason: "log in again",
        login_path: "/llm-gateway/login/personal/start",
        observed_at: NOW - 10_000,
      },
      snapshot: {
        observed_at: NOW - 10_000,
        overage: { status: "disabled", disabled_reason: "no credits" },
        "5h": {
          utilization: 0.71,
          status: "allowed",
          reset: NOW + 3_600_000,
          window_seconds: 18_000,
        },
        "7d": { utilization: 0.34, status: "allowed", expired: true },
        // Not a window: it carries neither figure, so it is dropped rather than
        // drawn as an empty bar.
        note: { something: "else" },
      },
      limits: [
        { kind: "opus", percent: 12.5, severity: "ok", resets_at: NOW, window_seconds: 604_800 },
        { kind: "broken" },
      ],
      probe_error: "the provider refused the probe",
    },
    // No name: nothing could label it, so it is not a row.
    { support: "observed" },
  ],
};

const STATS = {
  generated_at: NOW,
  days: {
    "2026-09-07": {
      credentials: {
        personal: {
          "claude-opus-5": { requests: 3, input_tokens: 10, usd: 0.25, unknown_counter: 7 },
        },
      },
      total_usd: 0.25,
    },
  },
};

const running: Instance[] = [];
const clients: LineClient[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const instance of running.splice(0)) await instance.stop();
  for (const server of servers.splice(0)) await server.stop(true);
});

/** A gateway answering its three endpoints, recording what was asked of it. */
function fakeGateway(): { url: string; asked: () => string[] } {
  const asked: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      asked.push(`${url.pathname}${url.search}`);
      if (url.pathname === "/llm-gateway/usage") return Response.json(USAGE);
      if (url.pathname === "/llm-gateway/stats") return Response.json(STATS);
      if (url.pathname === "/llm-gateway/status") {
        return Response.json({ overall: { severity: "ok", service_counts: {} }, services: [] });
      }
      return new Response("Not Found", { status: 404 });
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, asked: () => asked };
}

async function greet(gatewayUrl?: string): Promise<LineClient> {
  const root = mkdtempSync(join(tmpdir(), "ccmsg-llm-"));
  mkdirSync(join(root, "home", "sessions"), { recursive: true });
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(
    join(root, "config", "config.json"),
    JSON.stringify(gatewayUrl === undefined ? {} : { upstream: { gateway_url: gatewayUrl } }),
  );
  const env: Env = {
    CLAUDE_CONFIG_DIR: join(root, "home"),
    CCMSG_STATE_DIR: join(root, "state"),
    CCMSG_CONFIG_DIR: join(root, "config"),
  };
  const outcome = await start({ env, echoLog: false });
  if (!isRunning(outcome)) throw new Error("another instance holds this config home");
  running.push(outcome);
  const client = await connectUds(outcome.socketPath);
  clients.push(client);
  client.send({ op: "hello", request_id: "h", role: "user", protocol_version: PROTOCOL_VERSION });
  await client.next();
  return client;
}

/** One op, answered and held to its own response schema (§11.1). */
async function ask(
  client: LineClient,
  op: "llm_usage_read" | "llm_stats_read",
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  client.send({ op, request_id: op, ...args });
  const answer = await client.next();
  if (answer["ok"] === true) {
    expect(validationErrors(OP_SCHEMAS[op].response, answer)).toEqual([]);
  }
  return answer;
}

describe("what quota is left (llm_usage_read)", () => {
  test("the gateway's document arrives under this contract's names (§3.5)", async () => {
    const gateway = fakeGateway();
    const client = await greet(gateway.url);
    const answer = (await ask(client, "llm_usage_read")) as unknown as LlmUsageReadResult;
    expect(answer.generated_at).toBe(NOW);
    expect(answer.credentials.length).toBe(1);
    const credential = answer.credentials[0];
    expect(credential?.name).toBe("personal");
    expect(credential?.support).toBe("observed");
    expect(credential?.probe_error).toBe("the provider refused the probe");
    // `reset` and `window_seconds` are the two the gateway spells its own way.
    expect(credential?.snapshot?.windows["5h"]).toEqual({
      utilization: 0.71,
      status: "allowed",
      reset_at: NOW + 3_600_000,
      window_secs: 18_000,
    });
    expect(credential?.snapshot?.windows["7d"]?.expired).toBe(true);
    expect(credential?.snapshot?.windows["note"]).toBeUndefined();
    expect(credential?.snapshot?.overage).toEqual({
      status: "disabled",
      disabled_reason: "no credits",
    });
    // A limit that names no figure is not one.
    expect(credential?.limits?.length).toBe(1);
    expect(credential?.limits?.[0]?.window_secs).toBe(604_800);
  });

  test("the login path becomes an address on the gateway's own origin", async () => {
    const gateway = fakeGateway();
    const client = await greet(gateway.url);
    const answer = (await ask(client, "llm_usage_read")) as unknown as LlmUsageReadResult;
    expect(answer.credentials[0]?.auth?.login_url).toBe(
      `${gateway.url}/llm-gateway/login/personal/start`,
    );
    // Resolved against the configured endpoint, so the link does not carry the
    // probe's own query along.
    expect(answer.credentials[0]?.auth?.login_url).not.toContain("refresh");
  });

  test("a probe is asked for only when the caller asked for one", async () => {
    const gateway = fakeGateway();
    const client = await greet(gateway.url);
    await ask(client, "llm_usage_read");
    await ask(client, "llm_usage_read", { refresh: true });
    expect(gateway.asked().filter((path) => path.startsWith("/llm-gateway/usage"))).toEqual([
      "/llm-gateway/usage",
      "/llm-gateway/usage?refresh=true",
    ]);
  });

  test("a gateway that cannot be read is the op's failure, not an empty answer", async () => {
    // An address nothing answers on: the read fails, and answering with no
    // credentials would read as "this host has none".
    const client = await greet("http://127.0.0.1:1");
    const answer = await ask(client, "llm_usage_read");
    expect(answer["ok"]).toBe(false);
    expect((answer["error"] as { code: string }).code).toBe("internal_error");
  });
});

describe("what it cost (llm_stats_read)", () => {
  test("the days are the gateway's own, with the counters it reported", async () => {
    const gateway = fakeGateway();
    const client = await greet(gateway.url);
    const answer = (await ask(client, "llm_stats_read")) as unknown as LlmStatsReadResult;
    expect(Object.keys(answer.days)).toEqual(["2026-09-07"]);
    const day = answer.days["2026-09-07"];
    expect(day?.total_usd).toBe(0.25);
    expect(day?.credentials["personal"]?.["claude-opus-5"]).toEqual({
      requests: 3,
      input_tokens: 10,
      usd: 0.25,
    });
  });

  test("a window the caller named is passed on, and one it did not is not", async () => {
    const gateway = fakeGateway();
    const client = await greet(gateway.url);
    await ask(client, "llm_stats_read");
    await ask(client, "llm_stats_read", { days: 3 });
    expect(gateway.asked().filter((path) => path.startsWith("/llm-gateway/stats"))).toEqual([
      "/llm-gateway/stats",
      "/llm-gateway/stats?days=3",
    ]);
  });
});

describe("an instance with no gateway", () => {
  test("names neither capability and refuses both ops", async () => {
    const client = await greet();
    for (const op of ["llm_usage_read", "llm_stats_read"] as const) {
      const answer = await ask(client, op);
      expect(answer["ok"]).toBe(false);
      expect((answer["error"] as { code: string }).code).toBe("capability_unavailable");
    }
  });
});
