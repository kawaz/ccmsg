import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  starting,
  type TerminalInfo,
  TOPIC_SCHEMAS,
  unattachedTerminals,
  validationErrors,
} from "@ccmsg/protocol";
import { hostTerminals, Terminals, terminalsOf } from "../src/terminals/index.ts";
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
function manager(script: string): { lines: (jsonl: string) => void } {
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
  };
}

// Absolute, because `PATH` holds nothing but the directory this script is in.
const LISTS = '#!/bin/sh\ntest "$2" = "--format=jsonl" || exit 64\n/bin/cat @LISTING@\n';
const FAILS = '#!/bin/sh\necho "the manager is unwell" >&2\nexit 1\n';

/** A `Terminals` with somewhere to publish, whose poll is never waited on: the
 * tests drive the reading themselves, which is what makes them say when a
 * reading happened rather than how long one takes. */
function domain(list = hostTerminals(SELF)) {
  const published: { topic: string; data: unknown }[] = [];
  const logged: string[] = [];
  const terminals = new Terminals({
    self: SELF,
    list,
    publish: (topic, data) => {
      published.push({ topic, data });
    },
    log: (message) => {
      logged.push(message);
    },
    pollMs: 60_000,
  });
  return { terminals, published, logged };
}

/** The rows one frame carries, whether it opened the subscription or changed
 * it. */
function rows(data: unknown): TerminalInfo[] {
  return (data as { terminals: TerminalInfo[] }).terminals;
}

describe("the terminals of a host", () => {
  test("are the manager's listing, in the contract's spelling", async () => {
    const hyoui = manager(LISTS);
    hyoui.lines(`${line(CLAUDE)}\n${line(SHELL)}\n`);
    const { terminals } = domain();
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
    const hyoui = manager(LISTS);
    hyoui.lines(`${line(CLAUDE)}\n${line(SHELL)}\n`);
    const { terminals } = domain();
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
    manager(LISTS);
    const { terminals, published, logged } = domain();
    // The directory on `PATH` holds the script, and the script is not there
    // under the name the manager is asked for.
    process.env["PATH"] = mkdtempSync(join(tmpdir(), "ccmsg-terminals-none-"));
    homes.push(process.env["PATH"] as string);
    const [stated] = await terminals.snapshot();
    expect(rows(stated?.data)).toEqual([]);
    // A host with no manager is not a host whose manager failed.
    expect(logged).toEqual([]);
    expect(published).toEqual([]);
  });

  test("travel as a removal when one is closed", async () => {
    const hyoui = manager(LISTS);
    hyoui.lines(`${line(CLAUDE)}\n${line(SHELL)}\n`);
    const { terminals, published } = domain();
    // The reading the opening frame waits for is a change to whoever was
    // already subscribed, and goes out as one.
    await terminals.snapshot();
    expect(rows(published.splice(0)[0]?.data)).toHaveLength(2);
    hyoui.lines(`${line(CLAUDE)}\n`);
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
    const hyoui = manager(LISTS);
    hyoui.lines(`${line(CLAUDE)}\n`);
    const { terminals, published, logged } = domain();
    await terminals.snapshot();
    published.splice(0);
    writeFileSync(join(process.env["PATH"] as string, "hyoui"), FAILS);
    await terminals.read();
    // Nothing was published: a failed poll is not every terminal closing, and
    // the failure is said once rather than at every interval.
    expect(published).toEqual([]);
    await terminals.read();
    expect(logged).toEqual(["the terminal manager could not be read"]);
    const [stated] = await terminals.snapshot();
    expect(rows(stated?.data).map((row) => row.id)).toEqual(["hyoui:run-20107-ce44c928"]);
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
