import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION, type SessionSearchArgs } from "@ccmsg/protocol";
import { OpError } from "../src/dispatch/index.ts";
import { type Env, type Instance, isRunning, start } from "../src/instance/index.ts";
import { search } from "../src/sessions/index.ts";
import { TranscriptFiles } from "../src/transcript/index.ts";
import { connectUds, type LineClient } from "./client.ts";
import { OTHER_SID, SELF, SID } from "./frames.ts";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** A config home holding one transcript per session, in the layout the walk
 * expects: `projects/<flattened cwd>/<sid>.jsonl`. */
function home(transcripts: Record<string, readonly string[]>) {
  const root = mkdtempSync(join(tmpdir(), "ccmsg-search-"));
  homes.push(root);
  const project = join(root, "projects", "-repos-a-repo-main");
  mkdirSync(project, { recursive: true });
  for (const [sid, said] of Object.entries(transcripts)) {
    writeFileSync(
      join(project, `${sid}.jsonl`),
      said
        .map(
          (text) =>
            `${JSON.stringify({
              type: "user",
              cwd: "/repos/a-repo/main",
              timestamp: new Date(1_757_000_000_000).toISOString(),
              message: { role: "user", content: text },
            })}\n`,
        )
        .join(""),
    );
  }
  return {
    root,
    deps: {
      self: SELF,
      configHome: root,
      files: new TranscriptFiles({
        harness: "claude",
        configHome: root,
        announced: () => undefined,
      }),
    },
  };
}

function ask(args: Partial<SessionSearchArgs>, deps: ReturnType<typeof home>["deps"]) {
  return search({ op: "session.search", request_id: "1", ...args } as SessionSearchArgs, deps);
}

describe("what a regular-expression query may cost (§5)", () => {
  test("a clause longer than the cap is refused rather than compiled", async () => {
    const { deps } = home({ [SID]: ["anything"] });

    let refused: unknown;
    try {
      await ask({ query: "a".repeat(1001), regex: true }, deps);
    } catch (cause) {
      refused = cause;
    }
    expect(refused).toBeInstanceOf(OpError);
    expect((refused as OpError).code).toBe("invalid_args");
    // The cap is on the clause, not on the query: as many clauses as a caller
    // likes, each within it.
    expect((await ask({ query: `${"a".repeat(1000)}\nb`, regex: true }, deps)).truncated).toBe(
      false,
    );
  });

  test("a clause that backtracks without end is cut off and the answer says so", async () => {
    // The classic catastrophic pattern, over records built to defeat it: every
    // record costs it time exponential in their length, so it cannot finish and
    // the budget is the only thing that ends it.
    const said = Array.from({ length: 40 }, () => `${"a".repeat(40)}!`);
    const { deps } = home({ [SID]: said, [OTHER_SID]: said });

    const started = performance.now();
    const result = await ask({ query: "^(a+)+$", regex: true }, deps);
    const spent = performance.now() - started;

    expect(result.truncated).toBe(true);
    // Cut off within the budget rather than running to the end of the walk,
    // which at this pattern's cost would be longer than anyone would wait.
    expect(spent).toBeLessThan(20_000);
  }, 30_000);

  test("a well-formed clause is answered whole, and says nothing was left out", async () => {
    // The other side of the budget: it must not cut off an honest query. These
    // are the same records the catastrophic clause could not finish.
    const said = Array.from({ length: 40 }, () => `${"a".repeat(40)}!`);
    const { deps } = home({ [SID]: [...said, "the needle is here"], [OTHER_SID]: said });

    const result = await ask({ query: "needle", regex: true }, deps);

    expect(result.truncated).toBe(false);
    expect(result.hits.map((hit) => hit.sid)).toEqual([SID]);
  });

  test("a query of terms is not budgeted, since substring matching is linear", async () => {
    const { deps } = home({ [SID]: ["the needle is here"], [OTHER_SID]: ["straw"] });

    const result = await ask({ query: "needle" }, deps);

    expect(result.truncated).toBe(false);
    expect(result.hits.map((hit) => hit.sid)).toEqual([SID]);
  });
});

describe("what else an instance answers while a search is matching (§5)", () => {
  const running: Instance[] = [];
  const clients: LineClient[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close();
    for (const instance of running.splice(0)) await instance.stop();
  });

  /** An instance over a config home holding one transcript that defeats the
   * pattern below. */
  async function serving(): Promise<Instance> {
    const root = mkdtempSync(join(tmpdir(), "ccmsg-search-instance-"));
    homes.push(root);
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "settings.json"), "{}\n");
    const project = join(home, "projects", "-repos-a-repo-main");
    mkdirSync(project, { recursive: true });
    writeFileSync(
      join(project, `${SID}.jsonl`),
      Array.from(
        { length: 200 },
        () =>
          `${JSON.stringify({
            type: "user",
            cwd: "/repos/a-repo/main",
            timestamp: new Date(1_757_000_000_000).toISOString(),
            message: { role: "user", content: `${"a".repeat(40)}!` },
          })}\n`,
      ).join(""),
    );
    const env: Env = {
      CLAUDE_CONFIG_DIR: home,
      CCMSG_STATE_DIR: join(root, "state"),
      CCMSG_CACHE_DIR: join(root, "cache"),
      CCMSG_CONFIG_DIR: join(root, "config"),
    };
    const outcome = await start({ env, echoLog: false });
    if (!isRunning(outcome)) throw new Error("another instance holds this config home");
    running.push(outcome);
    return outcome;
  }

  async function client(instance: Instance): Promise<LineClient> {
    const one = await connectUds(instance.socketPath);
    clients.push(one);
    one.send({ op: "hello.user", request_id: "hello", protocol_version: PROTOCOL_VERSION });
    expect((await one.next())["ok"]).toBe(true);
    return one;
  }

  test("a ping is answered throughout a match that cannot finish", async () => {
    const instance = await serving();
    const searching = await client(instance);
    const asking = await client(instance);

    // Left running rather than awaited: what it costs is a whole budget, and
    // the question is what the instance does during it.
    searching.send({
      op: "session.search",
      request_id: "search",
      query: "^(a+)+$",
      regex: true,
    });
    let done: Record<string, unknown> | undefined;
    const answered = searching.next().then((answer) => (done = answer));

    // Asked over and over until the search is done, because a single ask could
    // have been answered before the matching began. Each round trip is a real
    // op over the socket, so what this measures is the instance's own turn.
    let worst = 0;
    let asked = 0;
    let refused = 0;
    while (done === undefined) {
      const at = performance.now();
      asking.send({ op: "instance.ping", request_id: `ping-${String(asked)}` });
      if ((await asking.next())["ok"] !== true) refused += 1;
      worst = Math.max(worst, performance.now() - at);
      asked += 1;
    }
    await answered;

    // The match really did run into its budget, so the asking above happened
    // while it was going.
    expect(done?.["truncated"]).toBe(true);
    expect([asked > 10, refused]).toEqual([true, 0]);
    // The budget the search is held to. A match on this thread would hold every
    // one of these past it — one `test()` of this pattern does not return.
    expect(worst).toBeLessThan(2_000);
  }, 30_000);
});
