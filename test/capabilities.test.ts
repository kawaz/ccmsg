import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@ccmsg/protocol";
import { ConfigError, type Env, type Instance, isRunning, start } from "../src/instance/index.ts";
import { connectUds, type LineClient } from "./client.ts";

const running: Instance[] = [];
const clients: LineClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const instance of running.splice(0)) await instance.stop();
});

/** A config home with the config file this test wants, and a directory the
 * launcher may be pointed at. */
function disposable(config: (root: string) => Record<string, unknown> = () => ({})): {
  env: Env;
  root: string;
} {
  const root = mkdtempSync(join(tmpdir(), "ccmsg-caps-"));
  mkdirSync(join(root, "home", "sessions"), { recursive: true });
  mkdirSync(join(root, "config"), { recursive: true });
  mkdirSync(join(root, "repos"), { recursive: true });
  writeFileSync(join(root, "config", "config.json"), JSON.stringify(config(root)));
  return {
    root,
    env: {
      CLAUDE_CONFIG_DIR: join(root, "home"),
      CCMSG_STATE_DIR: join(root, "state"),
      CCMSG_CONFIG_DIR: join(root, "config"),
    },
  };
}

async function greet(env: Env): Promise<{ client: LineClient; capabilities: string[] }> {
  const outcome = await start({ env, echoLog: false });
  if (!isRunning(outcome)) throw new Error("another instance holds this config home");
  running.push(outcome);
  const client = await connectUds(outcome.socketPath);
  clients.push(client);
  client.send({ op: "hello", request_id: "h", role: "user", protocol_version: PROTOCOL_VERSION });
  const hello = await client.next();
  return { client, capabilities: hello["capabilities"] as string[] };
}

async function ask(
  client: LineClient,
  op: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  client.send({ op, request_id: op, ...args });
  for (;;) {
    const frame = await client.next();
    if (frame["request_id"] === op) return frame;
  }
}

/** A launcher config naming one recipe and one root. */
function launcher(root: string): Record<string, unknown> {
  return {
    upstream: {
      launcher: {
        root_dirs: [join(root, "repos")],
        templates: [{ name: "claude", command: "printf hi", params: [{ name: "MODEL" }] }],
      },
    },
  };
}

/** A program that speaks the helper's line protocol: one JSON line in, one
 * line out. It stands in for the host's translator, so what is exercised is the
 * pipe and the framing rather than any translation. */
function helperAt(root: string): string {
  const path = join(root, "translate-helper");
  writeFileSync(
    path,
    [
      "#!/usr/bin/env bun",
      "for await (const line of console) {",
      "  const batch = JSON.parse(line);",
      "  const results = batch.texts.map((text) => ({ ok: true, text: text.toUpperCase() }));",
      "  console.log(JSON.stringify({ id: batch.id, results }));",
      "}",
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return path;
}

describe("what an instance names, and what it refuses", () => {
  test("no launcher configured: the three ops are refused before they run", async () => {
    const { env } = disposable();
    const { client, capabilities } = await greet(env);
    expect(capabilities).not.toContain("launcher");
    for (const [op, args] of [
      ["launcher_config_read", {}],
      ["launcher_run", { cwd: "/tmp", params: {} }],
      ["dir_tree", { roots: ["/tmp"] }],
    ] as const) {
      const answer = await ask(client, op, args);
      expect((answer["error"] as { code: string }).code).toBe("capability_unavailable");
    }
  });

  test("a launcher that is configured is named, and its form is answered", async () => {
    const { env, root } = disposable(launcher);
    const { client, capabilities } = await greet(env);
    expect(capabilities).toContain("launcher");
    const answer = await ask(client, "launcher_config_read", {});
    expect(answer["ok"]).toBe(true);
    expect(answer["root_dirs"]).toEqual([join(root, "repos")]);
    // A parameter with no stated default is the ordinary "the user fills this
    // in" case rather than a config that was refused.
    expect(answer["templates"]).toEqual([
      { name: "claude", command: "printf hi", params: [{ name: "MODEL", default: "" }] },
    ]);
  });

  test("no translation helper configured: translate_run is refused", async () => {
    const { env } = disposable();
    const { client, capabilities } = await greet(env);
    expect(capabilities).not.toContain("translate");
    const answer = await ask(client, "translate_run", { texts: ["hello"] });
    expect((answer["error"] as { code: string }).code).toBe("capability_unavailable");
  });

  test("a helper that can be run is named", async () => {
    const { env } = disposable((root) => ({
      upstream: { translate_helper: helperAt(root) },
    }));
    const { capabilities } = await greet(env);
    expect(capabilities).toContain("translate");
  });

  test("a helper on the host answers a batch over its own pipes", async () => {
    const { env } = disposable((root) => ({
      upstream: { translate_helper: helperAt(root) },
    }));
    const { client } = await greet(env);
    const answer = await ask(client, "translate_run", { texts: ["one", "two"] });
    expect(answer["ok"]).toBe(true);
    expect(answer["results"]).toEqual([
      { ok: true, text: "ONE" },
      { ok: true, text: "TWO" },
    ]);
  });

  test("the kv ops need no capability: every instance answers them", async () => {
    const { env } = disposable();
    const { client, capabilities } = await greet(env);
    expect(capabilities).toEqual([]);
    expect((await ask(client, "kv_write", { ns: "theme", key: "d", value: 1 }))["ok"]).toBe(true);
  });
});

describe("a setting that cannot be honoured ends the start (DV-Q9)", () => {
  test("a helper that is not there is not silently no translation", async () => {
    const { env } = disposable((root) => ({
      upstream: { translate_helper: join(root, "missing") },
    }));
    let refused: unknown;
    try {
      await start({ env, echoLog: false });
    } catch (cause) {
      refused = cause;
    }
    expect(refused).toBeInstanceOf(ConfigError);
  });

  test("a helper that is there and cannot be run is refused too", async () => {
    const { env } = disposable((root) => {
      const path = join(root, "not-executable");
      writeFileSync(path, "#!/bin/sh\ncat\n");
      chmodSync(path, 0o644);
      return { upstream: { translate_helper: path } };
    });
    let refused: unknown;
    try {
      await start({ env, echoLog: false });
    } catch (cause) {
      refused = cause;
    }
    expect(refused).toBeInstanceOf(ConfigError);
  });

  test("a launcher with no root, no recipe or a name no shell could carry", async () => {
    for (const broken of [
      { root_dirs: [], templates: [{ name: "a", command: "b" }] },
      { root_dirs: ["/tmp"], templates: [] },
      { root_dirs: ["relative"], templates: [{ name: "a", command: "b" }] },
      { root_dirs: ["/tmp"], templates: [{ name: "a", command: "" }] },
      {
        root_dirs: ["/tmp"],
        templates: [{ name: "a", command: "b", params: [{ name: "not an identifier" }] }],
      },
    ]) {
      const { env } = disposable(() => ({ upstream: { launcher: broken } }));
      let refused: unknown;
      try {
        await start({ env, echoLog: false });
      } catch (cause) {
        refused = cause;
      }
      expect(refused).toBeInstanceOf(ConfigError);
    }
  });
});
