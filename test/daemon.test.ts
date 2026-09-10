import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  type StatusRow,
  stop,
  STOP_TIMEOUT_MS,
  Supervisor,
  ask,
  tailOf,
  targetFor,
} from "../src/daemon/index.ts";
import { loadShared } from "../src/instance/index.ts";
import { resolvePaths } from "../src/instance/paths.ts";
import { endpoint, leasePort } from "./cluster.ts";
import { capture, Host, json, reapOrphans } from "./harness.ts";

const hosts: Host[] = [];
const supervisors: Supervisor[] = [];
const runs: Promise<void>[] = [];

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
  for (const supervisor of supervisors.splice(0)) await supervisor.stop();
  await Promise.all(runs.splice(0));
  for (const one of hosts) {
    for (const target of registered(process.env)) {
      if (rowFor(target).running) await stop(target).catch(() => undefined);
    }
    one.release();
  }
  hosts.splice(0);
});

// A supervisor spawns real instances. One that outlived the test that started
// it is a daemon left running against a directory that has just been removed,
// which the run has to fail over rather than leave for a person to find in
// `ps` hours later.
afterAll(async () => {
  expect(await reapOrphans()).toEqual([]);
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
    expect(added.id).toMatch(/^[0-9a-f]{32}$/);
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

/** A supervisor of its own, running its control socket, stopped after the
 * test. Everything `daemon start` / `stop` / `status` does is a request to one,
 * so a test that is about those needs one running. */
async function supervising(options: Record<string, unknown> = {}): Promise<Supervisor> {
  const supervisor = new Supervisor({ startTimeoutMs: 15_000, log: () => undefined, ...options });
  supervisors.push(supervisor);
  const ran = supervisor.run();
  runs.push(ran);
  // The socket is bound before `run` settles anything else, so a request may go
  // as soon as the file is there. The children start after it, so a test that
  // is about them waits for them: `run` answers when the supervisor is asked to
  // leave, not when everything it looks after is up.
  await awaitFile(supervisor.socketPath);
  // Serving, not merely started: the lock is taken before the listener is up,
  // so a test that asks an instance anything waits for its socket.
  await waitFor(() => supervisor.targets.every((target) => existsSync(target.paths.socket)));
  return supervisor;
}

describe("the round trip against real processes", () => {
  test("add, start --all, status --all, stop --all, through the supervisor", async () => {
    const at = host();
    const one = at.home("one");
    const two = at.home("two");
    add(process.env, one);
    add(process.env, two);
    expect(list(process.env).every((row) => !row.running)).toBe(true);

    // A supervisor starts what it is looking after, so by the time it is up
    // both children are serving and `start` is what puts a stopped one back.
    const supervisor = await supervising();
    const started = (await ask({ op: "supervise_status", all: true })) as StatusRow[];
    expect(started.map((row) => row.dir)).toEqual([one, two]);
    expect(new Set(started.map((row) => row.pid)).size).toBe(2);
    for (const row of started) {
      expect(row.running).toBe(true);
      expect(row.version).toBeString();
      expect(row.network).toBeString();
      // No mesh configured, so the only instance it knows of is itself and the
      // list of others is empty rather than absent.
      expect(row.peers).toEqual([]);
    }

    const stopped = (await ask({ op: "supervise_stop", all: true })) as { stopped: boolean }[];
    expect(stopped.every((row) => row.stopped)).toBe(true);
    // Stopped and left stopped: the restart loop reads a departure it asked for
    // as one not to recover from.
    for (const target of registered(process.env)) expect(rowFor(target).running).toBe(false);

    const again = (await ask({ op: "supervise_start", all: true })) as StatusRow[];
    expect(again.every((row) => row.running)).toBe(true);
    expect(again.map((row) => row.pid)).not.toEqual(started.map((row) => row.pid));
    await supervisor.stop();
  }, 60_000);

  test("with no supervisor there is nobody to ask, and the command says so", async () => {
    const at = host();
    add(process.env, at.home("one"));
    for (const op of ["start", "stop", "restart", "status"]) {
      const asked = await capture(() => main(["daemon", op, "--all"]));
      expect(asked.code).toBe(1);
      expect(json(asked.err)).toEqual({
        error: {
          code: "supervisor_not_running",
          msg: "監督者が動いていません (`ccmsg service start` か `ccmsg daemon supervise` で起動してください)",
        },
      });
    }
  });

  test("starting one that is already running is refused rather than doubled", async () => {
    const at = host();
    const home = at.home("one");
    add(process.env, home);
    const supervisor = await supervising();
    const running = rowFor(targetFor(process.env, home));
    expect(running.running).toBe(true);
    expect(supervisor.startOne(home)).rejects.toThrow(CommandError);
    expect(rowFor(targetFor(process.env, home)).pid).toBe(running.pid as number);
    await supervisor.stop();
  }, 60_000);

  test("stopping one that is not running says so rather than pretending", async () => {
    const at = host();
    const home = at.home("one");
    add(process.env, home);
    const supervisor = await supervising();
    await supervisor.stopOne(home);
    expect(supervisor.stopOne(home)).rejects.toThrow(CommandError);
    await supervisor.stop();
  }, 60_000);

  test("a config home nobody registered is not one the supervisor will start", async () => {
    const at = host();
    const stranger = at.home("stranger");
    const supervisor = await supervising();
    expect(supervisor.startOne(stranger)).rejects.toThrow(CommandError);
    await supervisor.stop();
  }, 30_000);
});

describe("add and remove against a running supervisor", () => {
  test("add writes the file and has the child started", async () => {
    const at = host();
    const supervisor = await supervising();
    const home = at.home("one");

    const added = await capture(() => main(["daemon", "add", home]));
    expect(added.code).toBe(0);
    expect(json(added.out)).toMatchObject({ dir: home, running: true, supervised: true });
    expect(loadShared(resolvePaths(process.env).configFile).instances).toEqual([
      { dir: home, settings: {} },
    ]);
    expect(supervisor.targets.map((target) => target.dir)).toEqual([home]);
    await supervisor.stop();
  }, 60_000);

  test("remove stops it being looked after and leaves the instance running", async () => {
    const at = host();
    const home = at.home("one");
    add(process.env, home);
    const supervisor = await supervising();
    const before = rowFor(targetFor(process.env, home));
    expect(before.running).toBe(true);

    const removed = await capture(() => main(["daemon", "remove", home]));
    expect(json(removed.out)).toMatchObject({ dir: home, removed: true, supervised: false });
    expect(supervisor.targets).toEqual([]);
    // Still there, and still the same process: a list edit is not a shutdown.
    expect(rowFor(targetFor(process.env, home))).toMatchObject({ running: true, pid: before.pid });

    // And now nothing brings it back, so stopping it by hand is the end of it.
    await stop(targetFor(process.env, home));
    await awaitGone(targetFor(process.env, home).paths, 15_000);
    expect(rowFor(targetFor(process.env, home)).running).toBe(false);
    await supervisor.stop();
  }, 60_000);

  test("three linked instances are all the way down before the supervisor answers", async () => {
    const at = host();
    // Three real children with a mesh between them: the shape a stop wedged in,
    // where a link being torn down held a listener open past the point the
    // socket had already gone and the instance read as stopped.
    const leases = [leasePort(), leasePort(), leasePort()];
    const peers = leases.map((lease) => endpoint(lease.port));
    const homes = ["one", "two", "three"].map((name) => at.home(name));
    for (const home of homes) add(process.env, home);
    const configFile = resolvePaths(process.env).configFile;
    writeFileSync(
      configFile,
      JSON.stringify({
        instances: homes.map((dir, index) => ({
          dir,
          peers,
          entry: {
            host: "127.0.0.1",
            port: (leases[index] as (typeof leases)[number]).port,
            origins: [peers[index]],
          },
        })),
      }),
    );
    for (const lease of leases) await lease.release();

    const supervisor = await supervising();
    const logs = registered(process.env).map((target) => target.paths.logFile);
    // A link each way, read as the state each peer is left in rather than as a
    // count of the lines: both ends dial, one of the two connections is dropped
    // as the duplicate, and the peer that says so says `established` twice.
    const linked = (log: string): number => {
      if (!existsSync(log)) return 0;
      const state = new Map<string, boolean>();
      for (const line of readFileSync(log, "utf8").split("\n")) {
        const said = /"message":"mesh peer (established|lost)","peer":"([^"]+)"/.exec(line);
        if (said !== null) state.set(said[2] as string, said[1] === "established");
      }
      return [...state.values()].filter(Boolean).length;
    };
    await waitFor(() => logs.every((log) => linked(log) === 2), 30_000);

    const started = Date.now();
    await supervisor.stop();
    // Answering is the children having gone, so what this measures is the
    // whole of the shutdown and not the moment it was asked for.
    expect(Date.now() - started).toBeLessThan(STOP_TIMEOUT_MS);
    for (const target of registered(process.env)) {
      expect(rowFor(target).running).toBe(false);
    }
  }, 60_000);

  test("with no supervisor, add writes the file and says nobody was told", async () => {
    const at = host();
    const home = at.home("one");
    const added = await capture(() => main(["daemon", "add", home]));
    expect(added.code).toBe(0);
    expect(json(added.out)).toMatchObject({ dir: home, running: false, supervised: false });
    expect(loadShared(resolvePaths(process.env).configFile).instances).toBeArrayOfSize(1);
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
    await waitFor(() => children.length === 1);

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

  test("a child that will not leave is signalled, and then killed", async () => {
    const at = host();
    add(process.env, at.home("one"));

    // Deaf to everything but SIGKILL: what a child wedged in its own shutdown
    // looks like from here, and the case a supervisor used to wait out forever
    // because it had nothing after `await child.exited`.
    const signals: string[] = [];
    let end: (code: number) => void = () => undefined;
    const exited = new Promise<number>((resolve) => {
      end = resolve;
    });
    const child: Child = {
      pid: 4242,
      exited,
      kill: (signal) => {
        signals.push(String(signal));
        if (signal === "SIGKILL") end(137);
      },
    };
    let spawned = 0;
    const supervisor = new Supervisor({
      stopTimeoutMs: 50,
      log: () => undefined,
      spawn: () => {
        spawned += 1;
        return child;
      },
    });
    const ran = supervisor.run();
    await waitFor(() => spawned === 1);
    await supervisor.stop();
    await ran;
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  }, 15_000);

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
    const one = at.home("one");
    add(process.env, one);
    add(process.env, at.home("two"));
    const supervisor = await supervising();
    // One of the two is already stopped, so stopping both is one refusal and
    // one success — and the caller can see which was which.
    await supervisor.stopOne(one);

    const stopped = await capture(() => main(["daemon", "stop", "--all"]));
    expect(stopped.code).toBe(0);
    const rows = json(stopped.out) as {
      dir?: string;
      stopped?: boolean;
      error?: { code: string };
    }[];
    expect(rows).toBeArrayOfSize(2);
    expect(rows[0]?.error?.code).toBe("instance_unreachable");
    expect(rows[1]).toMatchObject({ stopped: true });
    await supervisor.stop();
  }, 60_000);
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

/** Wait for a path to exist, which is how a test knows a listener it did not
 * bind itself is up. */
async function awaitFile(path: string): Promise<void> {
  await waitFor(() => existsSync(path));
}

/** Wait for something another task will do, on the event loop rather than on a
 * clock: each turn gives the pending promises a chance to run. */
async function waitFor(ready: () => boolean, turns = 1000): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    if (ready()) return;
    await Bun.sleep(1);
  }
  throw new Error("what the test was waiting for did not happen");
}
