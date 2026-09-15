import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  starting,
  type TerminalInfo,
  TOPIC_SCHEMAS,
  unattachedTerminals,
  validationErrors,
} from "@ccmsg/protocol";
import { OpError } from "../src/dispatch/index.ts";
import { hostProcessDeps } from "../src/sessions/index.ts";
import {
  hostTerminals,
  hostTerminalWatch,
  socketDirs,
  type TerminalListing,
  Terminals,
  terminalsOf,
} from "../src/terminals/index.ts";
import { SELF } from "./frames.ts";

/** One line of what the terminal manager prints, in its own spelling. */
function line(row: Record<string, unknown>): string {
  return JSON.stringify(row);
}

const CLAUDE = {
  session: "run-20107-ce44c928",
  status: "live",
  child_state: "running",
  child_pid: 20127,
  child_pgid: 20127,
  cwd: "/repos/example/main",
  argv: ["claude", "--resume", "08bba651"],
  started_unix_ms: 1_787_640_347_235,
};

const SHELL = {
  session: "run-42929-ea1c2477",
  status: "live",
  child_state: "running",
  child_pid: 42931,
  cwd: "/repos/example",
  argv: ["/bin/zsh", "-i"],
  started_unix_ms: 1_789_445_602_678,
};

const homes: string[] = [];
const PATH = process.env["PATH"];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  process.env["PATH"] = PATH;
});

/** A terminal manager this host does not have, put on `PATH` as a script that
 * prints whatever a file says. What a test wants from a poll is what it writes
 * to that file, so a listing can change between polls the way a real one does.
 *
 * The real manager is out of reach of these tests by construction: `PATH` holds
 * this directory and nothing else. */
function manager(script: string): { lines: (jsonl: string) => void; said: () => string[] } {
  const dir = mkdtempSync(join(tmpdir(), "ccmsg-terminals-"));
  homes.push(dir);
  const out = join(dir, "listing");
  writeFileSync(out, "");
  writeFileSync(join(dir, "hyoui"), script.replaceAll("@LISTING@", out));
  chmodSync(join(dir, "hyoui"), 0o755);
  process.env["PATH"] = dir;
  return {
    lines: (jsonl) => {
      writeFileSync(out, jsonl);
    },
    said: () =>
      readFileSync(out, "utf8")
        .split("\n")
        .filter((said) => said !== ""),
  };
}

/** The code one refused call answered with. */
async function refusalOf(call: () => unknown): Promise<string> {
  try {
    await call();
  } catch (cause) {
    if (cause instanceof OpError) return cause.code;
    throw cause;
  }
  throw new Error("the call was expected to be refused");
}

// Absolute, because `PATH` holds nothing but the directory this script is in.
const LISTS = '#!/bin/sh\ntest "$2" = "--format=jsonl" || exit 64\n/bin/cat @LISTING@\n';
const FAILS = '#!/bin/sh\necho "the manager is unwell" >&2\nexit 1\n';

/** A listing of what the manager would have printed, without a manager.
 *
 * What the reading is about is the jsonl and what this instance makes of it,
 * and running a process to produce a string this test already holds makes the
 * reading wait on a process start — which is an interval of whatever else the
 * host is doing, and nothing to do with terminals. Running the manager is its
 * own test, below. */
function listing(jsonl: () => string): TerminalListing {
  return () => Promise.resolve(terminalsOf(SELF, jsonl()));
}

/** A `Terminals` with somewhere to publish, over a watch the case itself works:
 * `moved` is what the socket directories would have said. The readings are
 * driven by the case for the same reason, which is what makes these say when a
 * reading happened rather than how long one takes. What the real watch reports
 * of a real directory is its own test, below. */
function domain(list = hostTerminals(SELF)) {
  const published: { topic: string; data: unknown }[] = [];
  const logged: string[] = [];
  const armed = { started: 0, stopped: 0 };
  let onChange: (() => void) | undefined;
  const terminals = new Terminals({
    self: SELF,
    list,
    watch: (moved) => {
      onChange = moved;
      return {
        start: () => {
          armed.started++;
        },
        stop: () => {
          armed.stopped++;
        },
      };
    },
    publish: (topic, data) => {
      published.push({ topic, data });
    },
    log: (message) => {
      logged.push(message);
    },
  });
  return {
    terminals,
    published,
    logged,
    armed,
    moved: () => {
      onChange?.();
    },
  };
}

/** The rows one frame carries, whether it opened the subscription or changed
 * it. */
function rows(data: unknown): TerminalInfo[] {
  return (data as { terminals: TerminalInfo[] }).terminals;
}

describe("the terminals of a host", () => {
  test("are the manager's listing, in the contract's spelling", async () => {
    const { terminals } = domain(listing(() => `${line(CLAUDE)}\n${line(SHELL)}\n`));
    const [stated] = await terminals.snapshot();
    expect(rows(stated?.data)).toEqual([
      {
        instance: SELF,
        id: "hyoui:run-20107-ce44c928",
        state: "running",
        command: ["claude", "--resume", "08bba651"],
        cwd: "/repos/example/main",
        pid: 20127,
        started_at: 1_787_640_347_235,
      },
      {
        instance: SELF,
        id: "hyoui:run-42929-ea1c2477",
        state: "running",
        command: ["/bin/zsh", "-i"],
        cwd: "/repos/example",
        pid: 42931,
        started_at: 1_789_445_602_678,
      },
    ]);
    // What the subscriber receives is a frame of the contract's own topic, so
    // the shape is checked as the contract states it rather than only as this
    // test spelled it.
    expect(
      validationErrors(TOPIC_SCHEMAS["terminals"], {
        ev: "topic",
        topic: "terminals",
        snapshot: true,
        instance: SELF,
        data: stated?.data,
      }),
    ).toEqual([]);
  });

  test("say which of them a harness has just started in, by the contract's own derivation", async () => {
    const { terminals } = domain(listing(() => `${line(CLAUDE)}\n${line(SHELL)}\n`));
    const [stated] = await terminals.snapshot();
    const listed = rows(stated?.data);
    // Nothing is on `agents` yet: the harness has not written its state file.
    // The terminal running one is on its way to being a session, and the one
    // running a shell is a person's own.
    expect(starting(listed, []).map((row) => row.id)).toEqual(["hyoui:run-20107-ce44c928"]);
    expect(unattachedTerminals([], listed)).toHaveLength(2);
    // Once the harness reports the run, its terminal is that session's.
    const agents = [{ instance: SELF, pid: 20127, sid: "s1" }];
    expect(starting(listed, agents)).toEqual([]);
    expect(unattachedTerminals(agents, listed).map((row) => row.id)).toEqual([
      "hyoui:run-42929-ea1c2477",
    ]);
  });

  test("are empty on a host that manages none", async () => {
    const { terminals, published, logged } = domain();
    // Nothing on `PATH` is the manager, so nothing is ever started: this is
    // the reading a host without one does, not one that waits on a process.
    process.env["PATH"] = mkdtempSync(join(tmpdir(), "ccmsg-terminals-none-"));
    homes.push(process.env["PATH"] as string);
    const [stated] = await terminals.snapshot();
    expect(rows(stated?.data)).toEqual([]);
    // A host with no manager is not a host whose manager failed.
    expect(logged).toEqual([]);
    expect(published).toEqual([]);
  });

  test("travel as a removal when one is closed", async () => {
    let jsonl = `${line(CLAUDE)}\n${line(SHELL)}\n`;
    const { terminals, published } = domain(listing(() => jsonl));
    // The reading the opening frame waits for is a change to whoever was
    // already subscribed, and goes out as one.
    await terminals.snapshot();
    expect(rows(published.splice(0)[0]?.data)).toHaveLength(2);
    jsonl = `${line(CLAUDE)}\n`;
    await terminals.read();
    expect(published).toHaveLength(1);
    // A removal is not a row of the list, which is why it is read as what a
    // frame carries rather than as a terminal.
    const change = published[0]?.data as { terminals: unknown[]; polled_at: number };
    expect(change.terminals).toEqual([
      { instance: SELF, id: "hyoui:run-42929-ea1c2477", removed: true },
    ]);
    expect(change.polled_at).toBeNumber();
    // A listing that has not moved tells a subscriber nothing.
    await terminals.read();
    expect(published).toHaveLength(1);
  });

  test("are left as they stand when the manager cannot be read", async () => {
    let unwell = false;
    const { terminals, published, logged } = domain(() =>
      unwell
        ? Promise.reject(new Error("the manager is unwell"))
        : Promise.resolve(terminalsOf(SELF, `${line(CLAUDE)}\n`)),
    );
    await terminals.snapshot();
    published.splice(0);
    unwell = true;
    await terminals.read();
    // Nothing was published: a failed poll is not every terminal closing, and
    // the failure is said once rather than at every interval.
    expect(published).toEqual([]);
    await terminals.read();
    expect(logged).toEqual(["the terminal manager could not be read"]);
    const [stated] = await terminals.snapshot();
    expect(rows(stated?.data).map((row) => row.id)).toEqual(["hyoui:run-20107-ce44c928"]);
  });

  /** The one reading here that starts a process.
   *
   * What a host's own listing is is a command run through `PATH`, and that is
   * worth one test; what the lines mean is every test above, where no process
   * stands between the jsonl and the rows. Both readings here are waited for
   * by the child's own exit — a listing that says the two things `hostTerminals`
   * distinguishes, a host with no manager (above) and a manager that failed. */
  test("are asked of the manager on PATH, and a manager that failed is not an answer", async () => {
    const hyoui = manager(LISTS);
    hyoui.lines(`${line(CLAUDE)}\n`);
    const list = hostTerminals(SELF);

    expect((await list()).map((row) => row.id)).toEqual(["hyoui:run-20107-ce44c928"]);

    writeFileSync(join(process.env["PATH"] as string, "hyoui"), FAILS);
    const failed = await list().then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(failed).toBeInstanceOf(Error);
  });

  test("keep the newest reading when an older one lands after it", async () => {
    const answers: (() => void)[] = [];
    let next: readonly TerminalInfo[] = [];
    const { terminals, published } = domain(async () => {
      const stated = next;
      await new Promise<void>((done) => answers.push(done));
      return stated;
    });
    const row = (id: string): TerminalInfo => ({
      instance: SELF,
      id: `hyoui:${id}`,
      state: "running",
      command: ["zsh"],
    });
    next = [row("old")];
    const first = terminals.read();
    next = [row("new")];
    const second = terminals.read();
    // The older reading lands last, and is dropped for having been overtaken.
    answers[1]?.();
    await second;
    answers[0]?.();
    await first;
    expect(published).toHaveLength(1);
    expect(rows(published[0]?.data).map((held) => held.id)).toEqual(["hyoui:new"]);
  });

  test("are typed into by the manager their scheme names, under its own handle", async () => {
    // The manager records what it was asked to do, because what is under test is
    // the argv this host builds rather than what a terminal did with it.
    const hyoui = manager('#!/bin/sh\necho "$@" >> @LISTING@\n');
    const { type } = hostProcessDeps(() => Promise.resolve([]));
    await type?.({ id: "hyoui:run-1-a", namespace: "work" }, ["text:/rename x", "key:Enter"]);
    await type?.({ id: "hyoui:run-1-a" }, ["key:Escape"]);
    expect(hyoui.said()).toEqual([
      "input --namespace work run-1-a text:/rename x key:Enter",
      // The scheme is this instance's way of telling managers apart and means
      // nothing to the manager, so what it is handed is the handle alone.
      "input run-1-a key:Escape",
    ]);
  });

  test("are not typed into where no manager here knows them", async () => {
    manager(LISTS);
    const { type } = hostProcessDeps(() => Promise.resolve([]));
    // A terminal of a manager this instance does not speak to, and one whose id
    // carries no scheme at all: neither is handed to whichever command happens
    // to be installed.
    for (const id of ["tmux:0", "run-1-a", "hyoui:", ":x"]) {
      expect(await refusalOf(() => type?.({ id }, ["key:Enter"]))).toBe("capability_unavailable");
    }
  });

  test("are read again when the socket directories move, and not otherwise", async () => {
    let jsonl = `${line(CLAUDE)}\n`;
    let reads = 0;
    const { terminals, published, armed, moved } = domain(() => {
      reads++;
      return Promise.resolve(terminalsOf(SELF, jsonl));
    });
    // The watch is what the subscription drives: armed when the first
    // subscriber arrives and let go when the last one leaves (DESIGN §6.3).
    terminals.start();
    expect(armed).toEqual({ started: 1, stopped: 0 });
    await terminals.snapshot();
    published.splice(0);

    // Nothing in the directories moved, so the manager is not asked again and
    // a subscriber is told nothing: there is no interval to arrive.
    const quiet = reads;
    await Bun.sleep(50);
    expect(reads).toBe(quiet);
    expect(published).toEqual([]);

    // A socket appeared, which is a terminal opening.
    jsonl = `${line(CLAUDE)}\n${line(SHELL)}\n`;
    moved();
    await terminals.read();
    expect(reads).toBeGreaterThan(quiet);
    expect(rows(published[0]?.data).map((row) => row.id)).toEqual(["hyoui:run-42929-ea1c2477"]);

    terminals.stop();
    expect(armed).toEqual({ started: 1, stopped: 1 });
  });

  test("leave out a line that states no terminal", () => {
    expect(
      terminalsOf(
        SELF,
        `${line({ ...CLAUDE, session: undefined })}\nnot json\n${line(CLAUDE)}\n`,
      ).map((row) => row.id),
    ).toEqual(["hyoui:run-20107-ce44c928"]);
  });

  test("state the manager's word for the terminal where it says none for the child", () => {
    const [stale] = terminalsOf(
      SELF,
      line({ session: "run-1-a", status: "stale", child_state: null, child_pid: null, argv: null }),
    );
    expect(stale).toEqual({
      instance: SELF,
      id: "hyoui:run-1-a",
      state: "stale",
      command: [],
    });
  });
});

describe("the directories the manager binds its sockets in", () => {
  const HOME = "/home/someone";

  test("are the manager's own, for the namespace this instance asks it about", () => {
    // Both bases, in the manager's own order (hyoui `discovery`).
    expect(socketDirs({ XDG_RUNTIME_DIR: "/run/user/1", XDG_STATE_HOME: "/s", HOME })).toEqual([
      "/run/user/1/hyoui",
      "/s/hyoui",
    ]);
    // The state base is where it goes by default, which is the one a host
    // without `XDG_RUNTIME_DIR` has.
    expect(socketDirs({ HOME })).toEqual(["/home/someone/.local/state/hyoui"]);
    expect(socketDirs({ XDG_RUNTIME_DIR: "", XDG_STATE_HOME: "", HOME })).toEqual([
      "/home/someone/.local/state/hyoui",
    ]);
    // A namespace of its own is a directory under each base; the default one is
    // the base itself, whether it is named or left unsaid.
    expect(socketDirs({ HOME, HYOUI_NAMESPACE: "work" })).toEqual([
      "/home/someone/.local/state/hyoui/work",
    ]);
    expect(socketDirs({ HOME, HYOUI_NAMESPACE: "default" })).toEqual([
      "/home/someone/.local/state/hyoui",
    ]);
    // A host with no home at all: there is nowhere to watch and nothing is
    // guessed.
    expect(socketDirs({})).toEqual([]);
  });

  test("say a terminal opened and closed, and say so before they exist", async () => {
    const root = mkdtempSync(join(tmpdir(), "ccmsg-sockets-"));
    homes.push(root);
    // The state base of a host whose manager has never run: the directory is
    // not there when the subscription opens.
    const dir = join(root, "hyoui");
    let moved = 0;
    const waiters: (() => void)[] = [];
    const watch = hostTerminalWatch(() => {
      moved++;
      for (const waiter of waiters.splice(0)) waiter();
    }, [dir]);
    /** Whether the watch said anything within `budgetMs`. */
    const reported = async (budgetMs: number): Promise<boolean> => {
      const before = moved;
      await Promise.race([
        new Promise<void>((resolve) => waiters.push(resolve)),
        Bun.sleep(budgetMs),
      ]);
      return moved > before;
    };

    watch.start();
    // Arming is itself a reason to read, once however many directories there
    // are.
    expect(moved).toBe(1);

    // The manager's first terminal, which makes the directory as it binds.
    mkdirSync(dir, { recursive: true });
    expect(await reported(5_000)).toBe(true);
    const socket = join(dir, "run-1-a.sock");
    writeFileSync(socket, "");
    expect(await reported(5_000)).toBe(true);
    // And the terminal closing, which is the socket going away.
    unlinkSync(socket);
    expect(await reported(5_000)).toBe(true);

    watch.stop();
    const quiet = moved;
    writeFileSync(join(dir, "run-2-b.sock"), "");
    await Bun.sleep(300);
    // Nobody is subscribed: nothing is watched and nothing is read (DESIGN
    // §6.3).
    expect(moved).toBe(quiet);
  });
});
