import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { main } from "../src/cli.ts";
import {
  add,
  type AddOptions,
  type Child,
  CommandError,
  awaitGone,
  follow,
  idOf,
  type InstanceRow,
  list,
  registered,
  remove,
  rowFor,
  FIRST_PORT,
  type StatusRow,
  status as statusOfTarget,
  stop,
  STOP_TIMEOUT_MS,
  Supervisor,
  ask,
  tailOf,
  targetFor,
} from "../src/daemon/index.ts";
import { applied, DEFAULT_CONFIG, evaluate, TYPES_FILE } from "../src/instance/index.ts";
import { resolvePaths } from "../src/instance/paths.ts";
import { leasePort } from "./cluster.ts";
import { capture, Host, json, reapOrphans, writeConfigHome } from "./harness.ts";

/** Register a config home, as a test that is not about the options would.
 *
 * With an address of its own unless the test names one: what `add` picks for
 * itself is the first free port after what *that config home* has handed out,
 * and every test here starts from an empty one — so two tests whose children
 * overlap would be handed the same port, and the second child would fail to
 * bind. A lease asks the kernel for one nothing else on this machine holds,
 * and is given up in the moment before the instance takes it. */
async function register(dir: string, options: AddOptions = {}): Promise<InstanceRow> {
  if (options.port !== undefined) return await add(process.env, dir, options);
  const lease = leasePort();
  await lease.release();
  return await add(process.env, dir, { ...options, port: lease.port });
}

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
    for (const target of await registered(process.env)) {
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
  test("a directory that is not a config home is not added", async () => {
    const at = host();
    const stranger = at.home("stranger", false);
    expect(register(stranger)).rejects.toThrow(CommandError);
    // Nothing was written, so a mistyped path leaves no file to clean up.
    expect(await list(process.env)).toEqual([]);
  });

  test("add lists it, twice refuses, and remove takes it off again", async () => {
    const at = host();
    const home = at.home("one");
    const added = await register(home);
    expect(added).toMatchObject({ name: "one", dir: home, running: false });
    expect(added.id).toMatch(/^[0-9a-f]{32}$/);
    expect((await list(process.env)).map((row) => row.dir)).toEqual([home]);

    // Twice is refused: one file per instance, and one instance per config
    // home (A2), and the name a config home is registered under is its own.
    expect(register(home)).rejects.toThrow(CommandError);
    expect(await remove(process.env, "one")).toMatchObject({
      name: "one",
      dir: home,
      removed: true,
    });
    expect(await list(process.env)).toEqual([]);
    expect(remove(process.env, "one")).rejects.toThrow(CommandError);
  });

  test("what add writes is the file a person edits", async () => {
    const at = host();
    const home = at.home("one");
    const added = await register(home);
    const paths = resolvePaths(process.env);
    // The declarations the two files write against, put beside them: a
    // relative `import type` resolves with no tsconfig anywhere near it.
    expect(existsSync(join(paths.configDir, TYPES_FILE))).toBe(true);
    // One file per instance, called by its id, stating what differs from the
    // shared file and nothing else. The name a person reads is inside it, so
    // renaming moves nothing.
    const written = readFileSync(join(paths.instancesDir, `instance-${added.id}.ts`), "utf8");
    expect(written).toContain(`config.dir = ${JSON.stringify(home)};`);
    expect(written).toContain('config.name = "one";');
    expect(written).not.toContain("harness");
    // The dump presets go in the shared file: what a preset names is an
    // interest, which this instance has no opinion on, so they are examples in
    // a file to edit rather than a default in the code.
    const { satisfied } = await evaluate(paths.configDir);
    const instances = satisfied?.instances ?? [];
    expect(instances[0]?.config.dump.presets.map((one) => one.name)).toEqual([
      "file",
      "howto",
      "journal",
      "handoff",
      "audit",
    ]);
    expect(instances).toMatchObject([{ id: added.id, name: "one", dir: home }]);
    // What the instance runs with is the built-ins, those presets, and the two
    // things `add` settled for it: the address it binds and the row of the
    // mesh its peers dial it at.
    const port = instances[0]?.config.entry?.port as number;
    expect(instances[0]?.config).toEqual({
      ...DEFAULT_CONFIG,
      dump: instances[0]?.config.dump,
      entry: { host: "127.0.0.1", port, source_ips: [], trusted_proxies: [] },
      endpoint: `http://127.0.0.1:${String(port)}/`,
      endpoints: [{ id: added.id, endpoint: `http://127.0.0.1:${String(port)}/` }],
    });
  });

  test("adding a second config home leaves the presets a person edited alone", async () => {
    const at = host();
    await register(at.home("one"));
    const paths = resolvePaths(process.env);
    writeFileSync(
      paths.configFile,
      "export default ({ config }: { config: { dump: unknown } }) => { config.dump = { presets: [] }; return config; };\n",
    );
    await register(at.home("two"));
    const read = await evaluate(paths.configDir);
    expect(read.satisfied?.instances.map((one) => one.config.dump.presets)).toEqual([[], []]);
  });

  test("a directory whose name is not a label is listed under its id", async () => {
    const at = host();
    // The name is a label and the id is the identity, so a directory nobody
    // could label is registered all the same — under the id, which is what a
    // name defaults to.
    const row = await register(at.home("Upper.Case"));
    expect(row.name).toBe(row.id);
    expect((await list(process.env)).map((one) => one.name)).toEqual([row.id]);
  });

  test("what add writes down is the mesh row and the id to start", async () => {
    const at = host();
    const home = at.home("one");
    const row = await register(home);
    const paths = resolvePaths(process.env);
    // The two files a person edits afterwards: where this instance is reached,
    // and which ids this host starts. The address is the loopback one, because
    // that is the one this host is certainly reached at — a proxy in front of
    // it is a deployment fact nothing here can see.
    expect(JSON.parse(readFileSync(paths.endpointsFile, "utf8"))).toEqual([
      { id: row.id, endpoint: `http://127.0.0.1:${String(row.port)}/` },
    ]);
    expect(JSON.parse(readFileSync(paths.supervisorFile, "utf8"))).toEqual({
      instances: [row.id],
    });
    // And what checked out, which is what the supervisor and the instance read.
    const standing = applied(paths.stateRoot);
    expect(standing?.supervisor.instances).toEqual([row.id]);
    expect(standing?.instances[0]).toMatchObject({ id: row.id, name: "one", dir: home });
    expect(standing?.endpoints).toHaveLength(1);
  });

  test("remove takes the id out of both files and leaves the state directory", async () => {
    const at = host();
    const home = at.home("one");
    const row = await register(home);
    const paths = resolvePaths(process.env);
    await remove(process.env, "one");
    expect(JSON.parse(readFileSync(paths.endpointsFile, "utf8"))).toEqual([]);
    expect(JSON.parse(readFileSync(paths.supervisorFile, "utf8"))).toEqual({ instances: [] });
    expect(existsSync(join(paths.instancesDir, `instance-${row.id}.ts`))).toBe(false);
    // The id stays where everything the instance issued is keyed by it, so a
    // config home that is added again answers to the id it always had.
    expect(existsSync(targetFor(process.env, home).paths.instanceIdFile)).toBe(true);
    expect((await register(home)).id).toBe(row.id);
  });

  test("an edit that does not check out leaves what is applied standing", async () => {
    const at = host();
    const home = at.home("one");
    const row = await register(home);
    const paths = resolvePaths(process.env);
    // A port that is not one: the file is what a person just wrote, and the
    // settings that were checked go on being what runs (§8.3).
    writeFileSync(
      join(paths.instancesDir, `instance-${row.id}.ts`),
      `export default ({ config }: any) => {
        config.name = "one";
        config.dir = ${JSON.stringify(home)};
        config.entry = { host: "127.0.0.1", port: "nope", source_ips: [], trusted_proxies: [] };
        return config;
      };\n`,
    );
    const rows = await list(process.env);
    expect(rows.map((one) => one.name)).toEqual(["one"]);
    expect(rows[0]?.port).toBe(row.port);
    // And it is said, rather than left to be noticed in a setting that did not
    // take: what `daemon status` answers carries what was refused.
    const status = await statusOfTarget(targetFor(process.env, home, "one", row.id));
    expect(status.config_problems?.[0]?.msg).toMatch(/entry.port/);
  });

  test("the port is the next one after what is registered, and the harness is read off the directory", async () => {
    const at = host();
    // The one test here that lets `add` pick: everywhere else a port is handed
    // in so that two tests' children cannot be given the same one, and picking
    // is exactly what this is about. Nothing is started from these two, so the
    // ports they take are held by nobody afterwards.
    const first = await add(process.env, at.home("one"));
    const second = await add(process.env, at.home("two"));
    const paths = resolvePaths(process.env);
    const ports = (await evaluate(paths.configDir)).satisfied?.instances.map(
      (one) => one.config.entry?.port,
    ) as (number | undefined)[];
    // The range starts at 8643 and each instance after the first takes the next
    // free one: a person adding a second config home states nothing. Where the
    // first one lands depends on what else this machine is running — the search
    // walks past whatever is taken — so what is fixed here is that it is in the
    // range and that the second follows the first.
    const [one, two] = ports as [number, number];
    expect(one).toBeGreaterThanOrEqual(FIRST_PORT);
    expect(two).toBe(one + 1);
    expect([first.name, second.name]).toEqual(["one", "two"]);
    // And each is an entry of the mesh, at the address the other dials it at.
    const mesh = (await evaluate(paths.configDir)).satisfied?.endpoints ?? [];
    expect(mesh.map((row) => row.endpoint)).toEqual([
      `http://127.0.0.1:${String(one)}/`,
      `http://127.0.0.1:${String(two)}/`,
    ]);
    expect([first.id, second.id]).toEqual(mesh.map((row) => row.id));
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
    await register(one);
    await register(two);
    expect((await list(process.env)).every((row) => !row.running)).toBe(true);

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
      // Two config homes on one host are two entries of one mesh (§7.1), so
      // each names the other and neither names itself.
      expect(row.peers?.map((peer) => peer.endpoint)).toEqual(
        row.config.endpoints
          .map((entry) => entry.endpoint)
          .filter((endpoint) => endpoint !== row.config.endpoint),
      );
      // What a restart would apply, answered from the files: the presets
      // `add` seeded, the address it picked, the mesh those addresses make,
      // and the built-ins for everything nobody stated (§8.2).
      expect(row.config).toEqual({
        ...DEFAULT_CONFIG,
        dump: { presets: row.config.dump.presets },
        entry: row.config.entry,
        endpoint: row.config.endpoint,
        endpoints: row.config.endpoints,
      });
      expect(row.config.entry?.host).toBe("127.0.0.1");
      expect(row.config.dump.presets.map((one) => one.name)).toContain("howto");
    }

    const stopped = (await ask({ op: "supervise_stop", all: true })) as { stopped: boolean }[];
    expect(stopped.every((row) => row.stopped)).toBe(true);
    // Stopped and left stopped: the restart loop reads a departure it asked for
    // as one not to recover from.
    for (const target of await registered(process.env)) expect(rowFor(target).running).toBe(false);

    const again = (await ask({ op: "supervise_start", all: true })) as StatusRow[];
    expect(again.every((row) => row.running)).toBe(true);
    expect(again.map((row) => row.pid)).not.toEqual(started.map((row) => row.pid));
    await supervisor.stop();
  }, 60_000);

  test("with no supervisor there is nobody to ask, and the command says so", async () => {
    const at = host();
    await register(at.home("one"));
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
    await register(home);
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
    await register(home);
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
    expect(applied(resolvePaths(process.env).stateRoot)).toMatchObject({
      instances: [{ name: "one", dir: home }],
    });
    expect(supervisor.targets.map((target) => target.dir)).toEqual([home]);
    await supervisor.stop();
  }, 60_000);

  test("remove stops it being looked after and leaves the instance running", async () => {
    const at = host();
    const home = at.home("one");
    await register(home);
    const supervisor = await supervising();
    const before = rowFor(targetFor(process.env, home));
    expect(before.running).toBe(true);

    const removed = await capture(() => main(["daemon", "remove", "one"]));
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
    const homes = ["one", "two", "three"].map((name) => at.home(name));
    for (const home of homes) await register(home);
    // Nothing states the mesh: three instances of this host, each with a port
    // of its own, are already each other's peers (§7.1).
    writeConfigHome(
      resolvePaths(process.env).configDir,
      {},
      Object.fromEntries(
        homes.map((dir, index) => [
          basename(dir),
          {
            dir,
            entry: {
              host: "127.0.0.1",
              port: (leases[index] as (typeof leases)[number]).port,
              source_ips: [],
              trusted_proxies: [],
            },
          },
        ]),
      ),
    );
    for (const lease of leases) await lease.release();

    const supervisor = await supervising();
    const logs = (await registered(process.env)).map((target) => target.paths.logFile);
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
    for (const target of await registered(process.env)) {
      expect(rowFor(target).running).toBe(false);
    }
  }, 60_000);

  test("with no supervisor, add writes the file and says nobody was told", async () => {
    const at = host();
    const home = at.home("one");
    const added = await capture(() => main(["daemon", "add", home]));
    expect(added.code).toBe(0);
    expect(json(added.out)).toMatchObject({ dir: home, running: false, supervised: false });
    expect(applied(resolvePaths(process.env).stateRoot)?.instances).toBeArrayOfSize(1);
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
    await register(home);

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
    await register(at.home("one"));

    // Deaf to everything but SIGKILL, and unreachable besides: the supervisor
    // gets no further than asking, and every stage after that is a signal.
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

  test("a child that takes the shutdown and then stays is signalled anyway", async () => {
    const at = host();
    const home = at.home("one");
    await register(home);

    // The shape the wedge takes in the field: the instance answers `hello` and
    // `instance.shutdown`, writes `stopping`, and never exits. The graceful
    // stage succeeds and settles nothing, so it is the deadline after it that
    // has to move the shutdown along.
    const signals: string[] = [];
    let end: (code: number) => void = () => undefined;
    const exited = new Promise<number>((resolve) => {
      end = resolve;
    });
    let answering: ReturnType<typeof Bun.listen> | undefined;
    const asked: string[] = [];
    const stages: string[] = [];
    const supervisor = new Supervisor({
      stopTimeoutMs: 50,
      log: (line) => {
        if (line["event"] === "stopping") stages.push(line["stage"] as string);
      },
      spawn: (dir) => {
        answering = Bun.listen({
          unix: targetFor(process.env, dir).paths.socket,
          socket: {
            data: (socket, chunk) => {
              for (const line of new TextDecoder().decode(chunk).split("\n")) {
                if (line.trim() === "") continue;
                asked.push((JSON.parse(line) as { op?: string }).op ?? "");
                socket.write(`${JSON.stringify({ ok: true })}\n`);
              }
            },
          },
        });
        return {
          pid: 4243,
          exited,
          kill: (signal) => {
            signals.push(String(signal));
            if (signal === "SIGKILL") end(137);
          },
        };
      },
    });
    const ran = supervisor.run();
    await waitFor(() => answering !== undefined);
    await supervisor.stop();
    await ran;
    answering?.stop(true);
    // The graceful stage got its answer, so what followed was the deadline on a
    // child that had agreed to leave and had not.
    expect(asked).toEqual(["hello.user", "instance.shutdown"]);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(stages).toEqual(["asked", "sigterm", "sigkill", "exited"]);
  }, 15_000);

  test("it supervises exactly the config homes the files name", async () => {
    const at = host();
    const one = at.home("one");
    await register(one);
    at.home("two"); // made, not added
    // Read when the run starts rather than in the constructor: the files are
    // TypeScript, and reading one is an import.
    const supervisor = new Supervisor({ spawn: () => fakeChild(1) });
    supervisors.push(supervisor);
    runs.push(supervisor.run());
    await waitFor(() => supervisor.targets.length > 0);
    expect(supervisor.targets.map((t) => t.dir)).toEqual([one]);
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
    expect(json(refused.err)).toMatchObject({ error: { code: "file_exists" } });
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
    await register(one);
    await register(at.home("two"));
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
    await register(home);
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
    await register(at.home("one"));
    const shown = await capture(() => main(["daemon", "log", "--all"]));
    expect(shown.code).toBe(0);
    expect(shown.out).toBe("");
  });

  test("--all labels every line with the instance it came from", async () => {
    const at = host();
    const one = at.home("one");
    const two = at.home("two");
    await register(one);
    await register(two);
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
    await register(home);
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
