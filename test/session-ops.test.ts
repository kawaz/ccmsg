import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type OpName,
  OP_SCHEMAS,
  opAttributes,
  type PeerInfo,
  type Role,
  type Sid,
  validationErrors,
} from "@ccmsg/protocol";
import { type HandlerInput, OpError } from "../src/dispatch/index.ts";
import {
  hostProcessDeps,
  lastLivePath,
  LastLiveStore,
  type ProcessDeps,
  sessionCapabilities,
  sessionHandlers,
  SessionProcesses,
  Sessions,
  type Terminal,
} from "../src/sessions/index.ts";
import { TranscriptFiles } from "../src/transcript/index.ts";
import { OTHER_SID, SELF, SID, TestConn } from "./frames.ts";

/** A transcript, in the harness's own spelling: its record types, its ISO
 * instants, its block arrays. Nothing here is the contract's — what turns one
 * into the other is what these ops are being tested for. */
const CWD = "/Users/someone/.local/share/repos/github.com/someone/a-repo/main";

function record(row: Record<string, unknown>): string {
  return `${JSON.stringify(row)}\n`;
}

const SAID_BY_PERSON = record({
  type: "user",
  uuid: "u1",
  timestamp: "2026-09-01T00:00:00.000Z",
  cwd: CWD,
  message: { role: "user", content: "where is the needle" },
});
const SAID_BY_AGENT = record({
  type: "assistant",
  uuid: "a1",
  timestamp: "2026-09-01T00:00:10.000Z",
  cwd: CWD,
  message: {
    role: "assistant",
    model: "claude-opus-5",
    content: [
      { type: "thinking", thinking: "a haystack" },
      { type: "text", text: "the needle is here" },
    ],
  },
});
const RENAMED = record({
  type: "custom-title",
  uuid: "t1",
  timestamp: "2026-09-01T00:00:20.000Z",
  customTitle: "a titled session",
});
const TRANSCRIPT = SAID_BY_PERSON + SAID_BY_AGENT + RENAMED;

/** A config home with a harness `sessions/` directory, a `projects/` tree and
 * a state directory — everything one instance derives from a config home
 * (§8.1), under the OS temp directory. */
function home() {
  const root = mkdtempSync(join(tmpdir(), "ccmsg-session-ops-"));
  mkdirSync(join(root, "sessions"), { recursive: true });
  mkdirSync(join(root, "projects", "-Users-someone-a-repo"), { recursive: true });
  homes.push(root);
  return root;
}

const homes: string[] = [];
const children: number[] = [];
afterEach(() => {
  for (const pid of children.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone, which is what most of these tests leave behind.
    }
  }
  for (const root of homes.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** One harness state file, as the harness writes it: camelCase, its own status
 * words, and the pid of the process it describes. */
function writeState(configHome: string, pid: number, sid: Sid) {
  writeFileSync(
    join(configHome, "sessions", `${pid}.json`),
    JSON.stringify({ pid, sessionId: sid, cwd: CWD, kind: "interactive", startedAt: 1 }),
  );
}

function writeTranscript(configHome: string, sid: Sid, text = TRANSCRIPT): string {
  const file = join(configHome, "projects", "-Users-someone-a-repo", `${sid}.jsonl`);
  writeFileSync(file, text);
  return file;
}

/** A child of this process to signal, so a kill test never reaches a real
 * session. It outlives the test it is spawned in only if the test failed to
 * kill it, which the cleanup above then does. */
function child(): number {
  const spawned = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
  children.push(spawned.pid);
  return spawned.pid;
}

interface Signalled {
  readonly pid: number;
  readonly signal: string;
}

/** The session ops over one config home, with every effect on a process
 * injected. What is not injected is the resolution itself: the pid comes from
 * that config home's own `sessions/` and from nowhere else (M6). */
function ops(over: Partial<ProcessDeps> & { typed?: string[][]; lastLive?: Sid[] } = {}) {
  const configHome = home();
  const stateDir = join(configHome, "state");
  const published: { topic: string; data: unknown }[] = [];
  // `last_live` is read as the domain is constructed (§8.3 step 4), so a test
  // that wants an entry in it writes the file first.
  if (over.lastLive !== undefined) {
    const store = new LastLiveStore(lastLivePath(stateDir));
    for (const sid of over.lastLive) {
      store.record({
        sid,
        instance: SELF,
        repo: "someone/a-repo",
        ws: "main",
        cwd: CWD,
        last_seen_at: Date.now(),
      });
    }
  }
  const domain = new Sessions({
    self: SELF,
    configHome,
    stateDir,
    capabilities: [],
    version: "test",
    startedAt: 1,
    publish: (topic, data) => published.push({ topic, data }),
  });
  const signalled: Signalled[] = [];
  const typed: string[][] = over.typed ?? [];
  const processes = new SessionProcesses({
    ...hostProcessDeps(() => domain.rowsNow()),
    // The reuse guard reads what the process was launched as; a `sleep` child
    // is not the harness, so the test states the answer the guard would get on
    // a real session and keeps every other step real.
    command: () => Promise.resolve("/opt/homebrew/bin/claude --model opus"),
    signal: (pid, signal) => {
      signalled.push({ pid, signal });
      process.kill(pid, signal);
    },
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    type: (terminal: Terminal, keys: readonly string[]) => {
      typed.push([terminal.id, terminal.namespace ?? "", ...keys]);
      return Promise.resolve();
    },
    ...over,
  });
  const handlers = sessionHandlers({
    self: SELF,
    configHome,
    stateDir,
    files: new TranscriptFiles({
      configHome,
      announced: (sid) => domain.transcriptPath(sid),
    }),
    processes,
    forget: (sid) => domain.forget(sid),
  });
  return { configHome, stateDir, domain, handlers, published, signalled, typed };
}

/** A caller: a person greets with no sid, a session names itself with one. */
function as(role: Role, sid?: Sid): Pick<HandlerInput, "conn" | "identity"> {
  const identity = { state: "settled" as const, role, ...(sid === undefined ? {} : { sid }) };
  return { conn: new TestConn(identity), identity };
}

/** Run one op the way dispatch would, and hold its answer to the contract: a
 * body that does not pass the op's own response schema is a contract violation
 * however happy the assertions below are (§11.1).
 *
 * The role is handed over exactly where dispatch hands it over — for an op the
 * attribute table marks `scope: "role"` and no other — so a visible range that
 * only appears because a test passed a role fails here rather than passing. */
async function run(
  op: OpName,
  handler: (input: HandlerInput) => unknown,
  args: Record<string, unknown>,
  caller = as("user"),
): Promise<Record<string, unknown>> {
  const scoped = opAttributes(op).scope === "role" && caller.identity !== undefined;
  const body = (await handler({
    op,
    args: { op, request_id: "1", ...args },
    ...caller,
    ...(scoped ? { role: caller.identity?.role } : {}),
  })) as object;
  const problems = validationErrors(OP_SCHEMAS[op].response, {
    ok: true,
    request_id: "1",
    ...body,
  });
  expect(problems).toEqual([]);
  return body as Record<string, unknown>;
}

async function refusalOf(call: () => unknown): Promise<string> {
  try {
    await call();
  } catch (cause) {
    if (cause instanceof OpError) return cause.code;
    throw cause;
  }
  throw new Error("the call was expected to be refused");
}

describe("transcript_read (scope: role)", () => {
  test("a person reads a session that is not theirs, a session reads only its own", async () => {
    const { configHome, handlers } = ops();
    writeTranscript(configHome, SID);
    writeTranscript(configHome, OTHER_SID);

    const person = await run("transcript_read", handlers.transcript_read, { sid: OTHER_SID });
    expect((person["lines"] as string[]).length).toBe(3);

    const own = await run(
      "transcript_read",
      handlers.transcript_read,
      { sid: SID },
      as("session", SID),
    );
    expect((own["lines"] as string[]).length).toBe(3);

    // The one difference the role makes: the call is allowed either way, and
    // what it may reach is not.
    expect(
      await refusalOf(() =>
        run("transcript_read", handlers.transcript_read, { sid: OTHER_SID }, as("session", SID)),
      ),
    ).toBe("forbidden");
  });

  test("the range is the file ops' range, not a second copy of it", async () => {
    // The visible range of every `scope: "role"` op comes from one function, so
    // a role the rule does not name reaches nothing here for the same reason it
    // reaches no file. `instance` is such a role.
    const { configHome, handlers } = ops();
    writeTranscript(configHome, SID);
    expect(
      await refusalOf(() =>
        run("transcript_read", handlers.transcript_read, { sid: SID }, as("instance", SID)),
      ),
    ).toBe("forbidden");
  });

  test("paging backwards from the end reaches the beginning without overlap", async () => {
    const { configHome, handlers } = ops();
    writeTranscript(configHome, SID);
    const size = Buffer.byteLength(TRANSCRIPT);

    const tail = await run("transcript_read", handlers.transcript_read, {
      sid: SID,
      max_bytes: Buffer.byteLength(RENAMED),
    });
    expect(tail["lines"]).toEqual([RENAMED.trimEnd()]);
    expect(tail["end"]).toBe(size);
    expect(tail["size"]).toBe(size);

    const earlier = await run("transcript_read", handlers.transcript_read, {
      sid: SID,
      before: tail["start"] as number,
    });
    expect(earlier["start"]).toBe(0);
    expect(earlier["end"]).toBe(tail["start"]);
    expect(earlier["lines"]).toEqual([SAID_BY_PERSON.trimEnd(), SAID_BY_AGENT.trimEnd()]);
  });

  test("a session with no transcript anywhere under this config home", async () => {
    const { handlers } = ops();
    expect(
      await refusalOf(() => run("transcript_read", handlers.transcript_read, { sid: SID })),
    ).toBe("not_found");
  });
});

describe("session_kill", () => {
  test("only the pid this config home's own sessions/ names is signalled (M6)", async () => {
    const ours = child();
    const theirs = child();
    const { configHome, handlers, signalled } = ops();
    writeState(configHome, ours, SID);
    // Another config home, with a session of its own. This instance answers for
    // one config home, so the pid in that one is a number it never reaches.
    const elsewhere = home();
    writeState(elsewhere, theirs, OTHER_SID);

    const killed = await run("session_kill", handlers.session_kill, { sid: SID });
    expect(killed["terminated"]).toBe(true);
    expect(signalled).toEqual([{ pid: ours, signal: "SIGTERM" }]);
    // The other home's session is not found here, and its process is untouched.
    expect(
      await refusalOf(() => run("session_kill", handlers.session_kill, { sid: OTHER_SID })),
    ).toBe("session_not_found");
    expect(signalled).toEqual([{ pid: ours, signal: "SIGTERM" }]);
    expect(alive(theirs)).toBe(true);
  });

  test("force asks for the signal the instance never chooses on its own", async () => {
    const pid = child();
    const { configHome, handlers, signalled } = ops();
    writeState(configHome, pid, SID);
    const killed = await run("session_kill", handlers.session_kill, { sid: SID, force: true });
    expect(killed["terminated"]).toBe(true);
    expect(signalled).toEqual([{ pid, signal: "SIGKILL" }]);
  });

  test("a pid whose process is no longer the harness is refused, not signalled", async () => {
    const pid = child();
    const { configHome, handlers, signalled } = ops({
      command: () => Promise.resolve("/bin/sleep 30"),
    });
    writeState(configHome, pid, SID);
    expect(await refusalOf(() => run("session_kill", handlers.session_kill, { sid: SID }))).toBe(
      "session_not_found",
    );
    expect(signalled).toEqual([]);
    expect(alive(pid)).toBe(true);
  });
});

describe("session_env_read", () => {
  test("the environment comes from the session's own process", async () => {
    const pid = child();
    const { configHome, handlers } = ops({
      platform: () => "linux",
      environment: () => Promise.resolve("HOME=/Users/someone\0HYOUI_SESSION_ID=t-1\0"),
    });
    writeState(configHome, pid, SID);
    const read = await run("session_env_read", handlers.session_env_read, { sid: SID });
    expect(read["pid"]).toBe(pid);
    expect(read["env"]).toEqual({ HOME: "/Users/someone", HYOUI_SESSION_ID: "t-1" });
  });

  test("a host with no way to read a process's environment answers not_found", async () => {
    const pid = child();
    const { configHome, handlers } = ops({
      environment: () => Promise.reject(new Error("ps: not permitted")),
    });
    writeState(configHome, pid, SID);
    expect(
      await refusalOf(() => run("session_env_read", handlers.session_env_read, { sid: SID })),
    ).toBe("not_found");
  });
});

describe("session_rename", () => {
  test("the title is typed into the terminal the session's own process names", async () => {
    const pid = child();
    const typed: string[][] = [];
    const { configHome, handlers } = ops({
      typed,
      platform: () => "linux",
      environment: () => Promise.resolve("HYOUI_SESSION_ID=t-1\0HYOUI_NAMESPACE=work\0"),
    });
    writeState(configHome, pid, SID);
    const renamed = await run("session_rename", handlers.session_rename, {
      sid: SID,
      title: "  a new title  ",
    });
    expect(renamed["terminal_id"]).toBe("t-1");
    expect(renamed["title"]).toBe("a new title");
    // The submit is a keystroke of its own, so the terminal drains the typed
    // line before it arrives.
    expect(typed).toEqual([["t-1", "work", "text:/rename a new title", "key:Enter"]]);
  });

  test("a session whose terminal is unknown is refused rather than guessed at", async () => {
    const pid = child();
    const { configHome, handlers } = ops({
      platform: () => "linux",
      environment: () => Promise.resolve("HOME=/Users/someone\0"),
    });
    writeState(configHome, pid, SID);
    expect(
      await refusalOf(() =>
        run("session_rename", handlers.session_rename, { sid: SID, title: "x" }),
      ),
    ).toBe("not_found");
  });

  test("a title carrying a newline would submit half a command", async () => {
    const pid = child();
    const { configHome, handlers } = ops({
      platform: () => "linux",
      environment: () => Promise.resolve("HYOUI_SESSION_ID=t-1\0"),
    });
    writeState(configHome, pid, SID);
    expect(
      await refusalOf(() =>
        run("session_rename", handlers.session_rename, { sid: SID, title: "one\ntwo" }),
      ),
    ).toBe("invalid_args");
  });
});

describe("session_last_live_remove", () => {
  test("the entry goes, the `peers` list says so, and asking twice is not an error", async () => {
    const { handlers, domain, published } = ops({ lastLive: [SID] });
    expect(domain.peers().last_live.map((entry) => entry.sid)).toEqual([SID]);

    published.length = 0;
    const removed = await run("session_last_live_remove", handlers.session_last_live_remove, {
      sid: SID,
    });
    expect(removed["removed"]).toBe(true);
    expect(domain.peers().last_live).toEqual([]);
    // The removal changes a value the `peers` topic carries, so it goes out
    // through the one push path rather than being a silent edit to a file.
    const peers = published.filter((each) => each.topic === "peers").at(-1);
    expect(peers).toBeDefined();
    expect((peers?.data as { last_live: PeerInfo[] } | undefined)?.last_live).toEqual([]);

    // Two clients pressing the same button is the ordinary case, and the
    // caller's goal holds either way.
    const again = await run("session_last_live_remove", handlers.session_last_live_remove, {
      sid: SID,
    });
    expect(again["removed"]).toBe(false);
  });

  test("the removal touches that list alone", async () => {
    const { configHome, handlers, domain } = ops({ lastLive: [SID] });
    const file = writeTranscript(configHome, SID);
    await run("session_last_live_remove", handlers.session_last_live_remove, { sid: SID });
    expect(domain.peers().last_live).toEqual([]);
    // The session stays reachable by every other route: its transcript is
    // still there and still readable.
    const read = await run("transcript_read", handlers.transcript_read, { sid: SID });
    expect(read["size"]).toBe(Buffer.byteLength(readFileSync(file)));
  });
});

describe("session_search", () => {
  test("what a clause matches, and which side of the conversation is searched", async () => {
    const { configHome, handlers } = ops();
    writeTranscript(configHome, SID);
    writeTranscript(configHome, OTHER_SID, SAID_BY_PERSON);

    const both = await run("session_search", handlers.session_search, { query: "needle" });
    const hits = both["hits"] as { sid: Sid; matches: { role: string }[] }[];
    expect(hits.map((hit) => hit.sid).sort()).toEqual([SID, OTHER_SID].sort());
    expect(hits.find((hit) => hit.sid === SID)?.matches.map((match) => match.role)).toEqual([
      "user",
      "agent",
    ]);
    expect(both["truncated"]).toBe(false);

    const agentOnly = await run("session_search", handlers.session_search, {
      query: "needle",
      target_user: false,
    });
    const agentHits = agentOnly["hits"] as { sid: Sid }[];
    expect(agentHits.map((hit) => hit.sid)).toEqual([SID]);

    // Terms within a clause are ANDed, so a clause naming two things that never
    // appear together matches nothing.
    const both2 = await run("session_search", handlers.session_search, {
      query: "needle haystack",
    });
    expect(both2["hits"]).toEqual([]);
  });

  test("a hit states where it came from and what the session was", async () => {
    const { configHome, handlers } = ops();
    const file = writeTranscript(configHome, SID);
    const found = await run("session_search", handlers.session_search, { sid: SID.slice(0, 8) });
    const hit = (found["hits"] as Record<string, unknown>[])[0];
    expect(hit?.["file"]).toBe(file);
    expect(hit?.["config_dir"]).toBe(configHome);
    expect(hit?.["instance"]).toBe(SELF);
    expect(hit?.["cwd"]).toBe(CWD);
    expect(hit?.["repo"]).toBe("someone/a-repo");
    expect(hit?.["ws"]).toBe("main");
    expect(hit?.["title"]).toBe("a titled session");
    expect(hit?.["model"]).toBe("claude-opus-5");
  });

  test("a config home this instance does not know is ignored, leaving nothing", async () => {
    const { configHome, handlers } = ops();
    writeTranscript(configHome, SID);
    const none = await run("session_search", handlers.session_search, {
      query: "needle",
      config_dirs: ["/somewhere/else"],
    });
    expect(none).toEqual({ hits: [], truncated: false });
  });
});

describe("session_dump_write", () => {
  test("the dump lands in this instance's own data directory, not a caller's path", async () => {
    const { configHome, stateDir, handlers } = ops();
    writeTranscript(configHome, SID);
    const written = await run("session_dump_write", handlers.session_dump_write, { sid: SID });
    const path = written["path"] as string;
    expect(path.startsWith(join(stateDir, "dumps"))).toBe(true);
    expect(readdirSync(join(stateDir, "dumps")).length).toBe(1);
    expect(written["instance"]).toBe(SELF);
    expect(written["entries"]).toBe(3);
    expect(written["bytes"]).toBe(Buffer.byteLength(readFileSync(path)));

    const document = JSON.parse(readFileSync(path, "utf8")) as {
      entries: { said_by?: string; thinking?: string }[];
    };
    expect(document.entries.map((entry) => entry.said_by)).toEqual(["user", "agent", undefined]);
    expect(document.entries[1]?.thinking).toBe("a haystack");
  });

  test("a bound by record cuts at that record, and thinking can be left out", async () => {
    const { configHome, stateDir, handlers } = ops();
    writeTranscript(configHome, SID);
    const written = await run("session_dump_write", handlers.session_dump_write, {
      sid: SID,
      since_uuid: "a1",
      until_uuid: "a1",
      no_thinking: true,
    });
    expect(written["entries"]).toBe(1);
    const document = JSON.parse(
      readFileSync(join(stateDir, "dumps", readdirSync(join(stateDir, "dumps"))[0] ?? ""), "utf8"),
    ) as { entries: { uuid: string; thinking?: string }[] };
    expect(document.entries[0]?.uuid).toBe("a1");
    expect(document.entries[0]?.thinking).toBeUndefined();
  });

  test("a session with no transcript has nothing to dump", async () => {
    const { handlers } = ops();
    expect(
      await refusalOf(() => run("session_dump_write", handlers.session_dump_write, { sid: SID })),
    ).toBe("not_found");
  });
});

describe("session_fork_origin", () => {
  test("the seam is where the copied records stop", async () => {
    const { configHome, handlers } = ops();
    // The ancestor holds a record the fork did not copy — a subagent's turn
    // interleaves into the parent — so the copied run is a subsequence of the
    // ancestor rather than a prefix of it.
    const sidechain = record({
      type: "assistant",
      uuid: "s1",
      isSidechain: true,
      timestamp: "2026-09-01T00:00:05.000Z",
      message: { role: "assistant", model: "claude-opus-5", content: [] },
    });
    // The ancestor lives beside the fork, which is the same project directory.
    writeTranscript(configHome, OTHER_SID, SAID_BY_PERSON + sidechain + SAID_BY_AGENT + RENAMED);
    const own = record({
      type: "user",
      uuid: "u2",
      timestamp: "2026-09-02T00:00:00.000Z",
      message: { role: "user", content: "carrying on" },
    });
    writeTranscript(configHome, SID, SAID_BY_PERSON + SAID_BY_AGENT + own);

    const answer = await run("session_fork_origin", handlers.session_fork_origin, { sid: SID });
    expect(answer["origin"]).toEqual({ sid: OTHER_SID, boundary_uuid: "a1", copied: 2 });
  });

  test("the ancestor is not a fork of its own fork", async () => {
    // Which of two files holding the same opening records is the copy is read
    // out of the records, not out of the filesystem's clock: the ancestor
    // carries a record the fork never copied, so its run into the fork stops
    // where the fork's run into it carries on. Asked from the other side, the
    // same comparison has to answer nothing.
    const { configHome, handlers } = ops();
    const sidechain = record({
      type: "assistant",
      uuid: "s1",
      isSidechain: true,
      timestamp: "2026-09-01T00:00:05.000Z",
      message: { role: "assistant", model: "claude-opus-5", content: [] },
    });
    writeTranscript(configHome, SID, SAID_BY_PERSON + sidechain + SAID_BY_AGENT + RENAMED);
    writeTranscript(
      configHome,
      OTHER_SID,
      SAID_BY_PERSON +
        SAID_BY_AGENT +
        record({
          type: "user",
          uuid: "u2",
          timestamp: "2026-09-02T00:00:00.000Z",
          message: { role: "user", content: "carrying on" },
        }),
    );
    expect(await run("session_fork_origin", handlers.session_fork_origin, { sid: SID })).toEqual(
      {},
    );
  });

  test("a session that is no fork has no seam to place", async () => {
    const { configHome, handlers } = ops();
    writeTranscript(configHome, SID);
    expect(await run("session_fork_origin", handlers.session_fork_origin, { sid: SID })).toEqual(
      {},
    );
  });
});

describe("the capabilities the session ops rest on", () => {
  test("named only where what they rest on is configured", () => {
    expect(sessionCapabilities({ fork_origin: false })).toEqual([]);
    expect(sessionCapabilities({ fork_origin: true, terminal_gateway: "hyoui" }).sort()).toEqual([
      "fork",
      "terminal",
    ]);
  });

  test("an instance with no terminal configured types nowhere", async () => {
    const pid = child();
    const { configHome, handlers } = ops({
      platform: () => "linux",
      environment: () => Promise.resolve("HYOUI_SESSION_ID=t-1\0"),
      type: undefined,
    });
    writeState(configHome, pid, SID);
    expect(
      await refusalOf(() =>
        run("session_rename", handlers.session_rename, { sid: SID, title: "x" }),
      ),
    ).toBe("capability_unavailable");
  });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
