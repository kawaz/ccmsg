import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import {
  type Child,
  CommandError,
  add,
  awaitGone,
  follow,
  idOf,
  list,
  registered,
  remove,
  rowFor,
  start,
  status,
  stop,
  Supervisor,
  tailOf,
  targetFor,
} from "../src/daemon/index.ts";
import { loadShared } from "../src/instance/index.ts";
import { resolvePaths } from "../src/instance/paths.ts";
import { capture, Host, json } from "./harness.ts";

const hosts: Host[] = [];

function host(): Host {
  const one = new Host("ccmsg-daemon-");
  hosts.push(one);
  one.adopt();
  return one;
}

afterEach(async () => {
  // Anything a test started is a real process: it is stopped before the
  // directories under it go, so nothing is left writing into a path that is
  // being removed.
  for (const one of hosts) {
    for (const target of registered(process.env)) {
      if (rowFor(target).running) await stop(target).catch(() => undefined);
    }
    one.release();
  }
  hosts.splice(0);
});

describe("which config homes there are (daemon add / remove / list)", () => {
  test("a directory that is not a config home is not added", () => {
    const at = host();
    const stranger = at.home("stranger", false);
    expect(() => add(process.env, stranger)).toThrow(CommandError);
    // Nothing was written, so a mistyped path leaves no entry to clean up.
    expect(list(process.env)).toEqual([]);
  });

  test("add lists it, twice refuses, and remove takes it off again", () => {
    const at = host();
    const home = at.home("one");
    const added = add(process.env, home);
    expect(added).toMatchObject({ dir: home, running: false });
    expect(added.id).toContain("ws://");
    expect(list(process.env).map((row) => row.dir)).toEqual([home]);

    expect(() => add(process.env, home)).toThrow(CommandError);
    expect(remove(process.env, home)).toEqual({ dir: home, removed: true });
    expect(list(process.env)).toEqual([]);
    expect(() => remove(process.env, home)).toThrow(CommandError);
  });

  test("what add writes is the shape a person edits", () => {
    const at = host();
    const home = at.home("one");
    add(process.env, home);
    const shared = loadShared(resolvePaths(process.env).configFile);
    expect(shared.defaults).toEqual({});
    expect(shared.instances).toEqual([{ dir: home, settings: {} }]);
  });
});

describe("the round trip against real processes", () => {
  test("add, start --all, status --all, stop --all", async () => {
    const at = host();
    const one = at.home("one");
    const two = at.home("two");
    add(process.env, one);
    add(process.env, two);
    expect(list(process.env).every((row) => !row.running)).toBe(true);

    const targets = registered(process.env);
    for (const target of targets) {
      const row = await start(process.env, target);
      expect(row.running).toBe(true);
      expect(row.pid).toBeGreaterThan(0);
    }

    // Each config home has an instance of its own, which is what makes two of
    // them two instances rather than one answering twice.
    const rows = [];
    for (const target of targets) rows.push(await status(target));
    expect(rows.map((row) => row.dir)).toEqual([one, two]);
    expect(new Set(rows.map((row) => row.pid)).size).toBe(2);
    for (const row of rows) {
      expect(row.running).toBe(true);
      expect(row.version).toBeString();
      expect(row.network).toBeString();
      // No mesh configured, so the only instance it knows of is itself and the
      // list of others is empty rather than absent.
      expect(row.peers).toEqual([]);
    }

    for (const target of targets) expect(await stop(target)).toMatchObject({ stopped: true });
    // Stopping is asked for and then happens, so what says it is over is the
    // lock being let go — the last thing a departing instance does (§8.5).
    for (const target of targets) {
      await awaitGone(target.paths, 10_000);
      expect(rowFor(target).running).toBe(false);
    }
  }, 30_000);

  test("starting one that is already running is refused rather than doubled", async () => {
    const at = host();
    const home = at.home("one");
    const target = targetFor(process.env, home);
    add(process.env, home);
    const first = await start(process.env, target);
    expect(start(process.env, target)).rejects.toThrow(CommandError);
    expect(rowFor(target).pid).toBe(first.pid as number);
    await stop(target);
  }, 30_000);

  test("the command that started one ends, rather than waiting on the child", async () => {
    const at = host();
    const home = at.home("one");
    add(process.env, home);
    // Run as its own process, which is the only place this shows: a live child
    // handle holds the parent's event loop open, and a test calling `start`
    // in-process has a runner keeping the loop alive anyway.
    const started = Bun.spawn(
      [
        process.execPath,
        new URL("../src/cli.ts", import.meta.url).pathname,
        "daemon",
        "start",
        home,
      ],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env } as Record<string, string> },
    );
    const code = await started.exited;
    expect(code).toBe(0);
    expect(json(await new Response(started.stdout).text())).toMatchObject({ running: true });
    await stop(targetFor(process.env, home));
  }, 30_000);

  test("stopping one that is not running says so rather than pretending", async () => {
    const at = host();
    const home = at.home("one");
    add(process.env, home);
    expect(stop(targetFor(process.env, home))).rejects.toThrow(CommandError);
  });
});

describe("the supervisor", () => {
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
      release: () => undefined,
      die: (code) => end(code),
    };
  }

  test("a child that dies is started again, after a wait that grows", async () => {
    const at = host();
    const home = at.home("one");
    add(process.env, home);

    const children: (Child & { die(code: number): void })[] = [];
    const waited: number[] = [];
    const supervisor = new Supervisor({
      backoff: { minMs: 1, maxMs: 4, steadyMs: 60_000 },
      log: (line) => {
        if (line["event"] === "restarting") waited.push(line["in_ms"] as number);
      },
      spawn: () => {
        const child = fakeChild(1000 + children.length);
        children.push(child);
        return child;
      },
    });
    const ran = supervisor.run();

    // Each death is followed by a start, and the wait before it doubles up to
    // the cap: a child failing at once cannot spin the supervisor.
    for (let round = 0; round < 4; round += 1) {
      const child = children[round] as (typeof children)[number];
      child.die(1);
      await waitFor(() => children.length === round + 2);
    }
    expect(waited).toEqual([1, 2, 4, 4]);

    // Leaving stops the restarting, so the last child is the last one.
    const before = children.length;
    void supervisor.stop();
    (children[before - 1] as (typeof children)[number]).die(0);
    await ran;
    expect(children.length).toBe(before);
  });

  test("it supervises exactly the config homes the shared file lists", () => {
    const at = host();
    const one = at.home("one");
    add(process.env, one);
    at.home("two"); // made, not added
    expect(new Supervisor({ spawn: () => fakeChild(1) }).targets.map((t) => t.dir)).toEqual([one]);
  });
});

describe("what a command answers with", () => {
  test("every answer is JSON, and so is every refusal", async () => {
    const at = host();
    const home = at.home("one");

    const added = await capture(() => main(["daemon", "add", home]));
    expect(added.code).toBe(0);
    expect(json(added.out)).toMatchObject({ dir: home, running: false });

    const listed = await capture(() => main(["daemon", "list"]));
    expect(json(listed.out)).toBeArrayOfSize(1);

    const refused = await capture(() => main(["daemon", "add", home]));
    expect(refused.code).toBe(1);
    expect(refused.out).toBe("");
    expect(json(refused.err)).toEqual({
      error: { code: "file_exists", msg: `${home} は既に登録されています` },
    });
  });

  test("run refuses a directory that is not a config home", async () => {
    const at = host();
    const stranger = at.home("stranger", false);
    const refused = await capture(() => main(["daemon", "run", stranger]));
    expect(refused.code).toBe(1);
    expect(json(refused.err)).toMatchObject({ error: { code: "not_found" } });
  });

  test("--all and a directory are not both an answer to the same question", async () => {
    host();
    const both = await capture(() => main(["daemon", "stop", "/somewhere", "--all"]));
    expect(both.code).toBe(1);
    expect(json(both.err)).toMatchObject({ error: { code: "invalid_args" } });
  });

  test("over --all, one config home refusing is a row rather than the whole answer", async () => {
    const at = host();
    add(process.env, at.home("one"));
    add(process.env, at.home("two"));
    const stopped = await capture(() => main(["daemon", "stop", "--all"]));
    expect(stopped.code).toBe(0);
    const rows = json(stopped.out) as { error?: { code: string } }[];
    expect(rows).toBeArrayOfSize(2);
    for (const row of rows) expect(row.error?.code).toBe("instance_unreachable");
  });
});

describe("reading a log (daemon log)", () => {
  /** Lines in the shape the instance writes them: one JSON object per line. */
  function wrote(target: { paths: { stateDir: string } }, ...messages: string[]): void {
    mkdirSync(target.paths.stateDir, { recursive: true });
    appendFileSync(
      join(target.paths.stateDir, "daemon.log"),
      messages.map((message) => `${JSON.stringify({ at: "now", message })}\n`).join(""),
    );
  }

  test("one config home's log comes out as it was written", async () => {
    const at = host();
    const home = at.home("one");
    add(process.env, home);
    wrote(targetFor(process.env, home), "listening", "stopping");

    const shown = await capture(() => main(["daemon", "log", home]));
    expect(shown.code).toBe(0);
    const lines = shown.out.trim().split("\n").map(json);
    expect(lines).toEqual([
      { at: "now", message: "listening" },
      { at: "now", message: "stopping" },
    ]);
  });

  test("a log nothing has written yet is no lines rather than a failure", async () => {
    const at = host();
    add(process.env, at.home("one"));
    const shown = await capture(() => main(["daemon", "log", "--all"]));
    expect(shown.code).toBe(0);
    expect(shown.out).toBe("");
  });

  test("--all labels every line with the instance it came from", async () => {
    const at = host();
    const one = at.home("one");
    const two = at.home("two");
    add(process.env, one);
    add(process.env, two);
    wrote(targetFor(process.env, one), "from one");
    wrote(targetFor(process.env, two), "from two");

    const shown = await capture(() => main(["daemon", "log", "--all"]));
    const lines = shown.out.trim().split("\n").map(json) as Record<string, unknown>[];
    expect(lines).toEqual([
      { id: idOf(targetFor(process.env, one)), dir: one, at: "now", message: "from one" },
      { id: idOf(targetFor(process.env, two)), dir: two, at: "now", message: "from two" },
    ]);
    // Still JSON lines: the label goes beside the record's own fields rather
    // than wrapping it, so a reader parses one object per line either way.
    expect(lines.every((line) => typeof line["message"] === "string")).toBe(true);
  });

  test("a line that is not JSON is shown rather than dropped", async () => {
    const at = host();
    const home = at.home("one");
    add(process.env, home);
    const target = targetFor(process.env, home);
    mkdirSync(target.paths.stateDir, { recursive: true });
    // What a runtime prints when it dies: the one thing somebody opening a log
    // is most likely looking for.
    appendFileSync(join(target.paths.stateDir, "daemon.log"), "Segmentation fault\n");

    const shown = await capture(() => main(["daemon", "log", "--all"]));
    expect(json(shown.out.trim())).toMatchObject({ dir: home, line: "Segmentation fault" });
  });

  test("following a log shows what is appended after it started", async () => {
    const at = host();
    const home = at.home("one");
    const target = targetFor(process.env, home);
    wrote(target, "before");

    const file = join(target.paths.stateDir, "daemon.log");
    const seen = await tailOf(file);
    expect(seen.lines).toBeArrayOfSize(1);

    const arrived: string[] = [];
    const follower = follow(file, seen.end, (lines) => arrived.push(...lines));
    try {
      wrote(target, "after");
      await waitFor(() => arrived.length === 1);
      expect(json(arrived[0] as string)).toMatchObject({ message: "after" });
      // The line already shown is not shown again: following starts where
      // reading ended.
      expect(arrived.some((line) => line.includes("before"))).toBe(false);
    } finally {
      follower.close();
    }
  });

  test("a log that shrank is read from its start again", async () => {
    const at = host();
    const target = targetFor(process.env, at.home("one"));
    wrote(target, "one", "two", "three");
    const file = join(target.paths.stateDir, "daemon.log");
    const seen = await tailOf(file);

    const arrived: string[] = [];
    const follower = follow(file, seen.end, (lines) => arrived.push(...lines));
    try {
      // Rotated: what the old offset pointed past is gone, so holding it would
      // skip everything the new file has.
      writeFileSync(file, `${JSON.stringify({ message: "rotated" })}\n`);
      await waitFor(() => arrived.length === 1);
      expect(json(arrived[0] as string)).toMatchObject({ message: "rotated" });
    } finally {
      follower.close();
    }
  });
});

/** Wait for something another task will do, on the event loop rather than on a
 * clock: each turn gives the pending promises a chance to run. */
async function waitFor(ready: () => boolean, turns = 1000): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    if (ready()) return;
    await Bun.sleep(1);
  }
  throw new Error("what the test was waiting for did not happen");
}
