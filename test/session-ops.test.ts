import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type DumpPreset,
  type OpName,
  OP_SCHEMAS,
  opAttributes,
  type PeerInfo,
  type Role,
  SessionDumpFile,
  type Sid,
  TranscriptItem,
  validationErrors,
} from "@ccmsg/protocol";
import { type HandlerInput, OpError } from "../src/dispatch/index.ts";
import {
  elapsedSeconds,
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
import { OTHER_SID, SELF, SELF_ENDPOINT, SID, TestConn } from "./frames.ts";

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

/** A session that did things: a shell call, an agent started and answered, a
 * file read. The structure is the harness's own — a call in an assistant
 * record, its answer in a later user record, an agent reporting through a
 * notification long after it was asked — and the words are invented. */
const BUSY_TRANSCRIPT =
  record({
    type: "user",
    uuid: "p1",
    timestamp: "2026-09-01T00:00:00.000Z",
    cwd: CWD,
    message: { role: "user", content: "count the lines please" },
  }) +
  record({
    type: "assistant",
    uuid: "a1",
    timestamp: "2026-09-01T00:00:01.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "wc will do" },
        {
          type: "tool_use",
          id: "tb1",
          name: "Bash",
          input: { command: "wc -l < f", description: "count" },
        },
        {
          type: "tool_use",
          id: "ta1",
          name: "Agent",
          input: { prompt: "count the lines", name: "count-lines", subagent_type: "worker" },
        },
      ],
    },
  }) +
  record({
    type: "user",
    uuid: "r1",
    timestamp: "2026-09-01T00:00:02.000Z",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tb1" }] },
    toolUseResult: { stdout: "3\n", stderr: "", interrupted: false },
  }) +
  record({
    type: "user",
    uuid: "r2",
    timestamp: "2026-09-01T00:00:03.000Z",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "ta1" }] },
    toolUseResult: {
      agentId: "acounter-9f",
      isAsync: true,
      status: "async_launched",
      name: "count-lines",
    },
  }) +
  record({
    type: "assistant",
    uuid: "a2",
    timestamp: "2026-09-01T00:00:04.000Z",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "tr1", name: "Read", input: { file_path: "/x/y.ts" } }],
    },
  }) +
  record({
    type: "user",
    uuid: "r3",
    timestamp: "2026-09-01T00:00:05.000Z",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tr1" }] },
    toolUseResult: { type: "text", file: { filePath: "/x/y.ts", content: "a\nb\n", numLines: 2 } },
  }) +
  record({
    type: "user",
    uuid: "n1",
    timestamp: "2026-09-01T00:01:00.000Z",
    origin: { kind: "task-notification" },
    message: {
      role: "user",
      content:
        "<task-notification>\n<task-id>acounter-9f</task-id>\n<tool-use-id>ta1</tool-use-id>\n<status>completed</status>\n<result>there were three</result>\n</task-notification>",
    },
  });

/** The agent's own file, which is where what it actually did is written. Its
 * first record is the brief its parent gave it, which is what nothing else in
 * the file is a reply to. */
const AGENT_TRANSCRIPT =
  record({
    type: "user",
    uuid: "w1",
    parentUuid: null,
    isSidechain: true,
    agentId: "acounter-9f",
    timestamp: "2026-09-01T00:00:03.000Z",
    message: { role: "user", content: "count the lines" },
  }) +
  record({
    type: "assistant",
    uuid: "w2",
    parentUuid: "w1",
    isSidechain: true,
    agentId: "acounter-9f",
    timestamp: "2026-09-01T00:00:50.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "there were three" }] },
  });

/** One item as it was written to the dump file, read back with only the two
 * fields every item has spelled out — the rest belong to its type. */
interface DumpedItem {
  readonly id: string;
  readonly uuid: string;
  readonly type: string;
  readonly [field: string]: unknown;
}

interface Dumped {
  readonly types: string[];
  readonly items: DumpedItem[];
  readonly ids: { kind: string; id: string }[];
  readonly [field: string]: unknown;
}

function dumpAt(path: string): Dumped {
  return JSON.parse(readFileSync(path, "utf8")) as Dumped;
}

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
function writeState(configHome: string, pid: number, sid: Sid, startedAt = Date.now()) {
  writeFileSync(
    join(configHome, "sessions", `${pid}.json`),
    JSON.stringify({ pid, sessionId: sid, cwd: CWD, kind: "interactive", startedAt }),
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
function ops(
  over: Partial<ProcessDeps> & {
    typed?: string[][];
    lastLive?: Sid[];
    presets?: DumpPreset[];
  } = {},
) {
  const configHome = home();
  const stateDir = join(configHome, "state");
  const published: { topic: string; data: unknown }[] = [];
  // `last_live` is read as the domain is constructed (§8.3 step 4), so a test
  // that wants an entry in it writes the file first.
  if (over.lastLive !== undefined) {
    const store = new LastLiveStore(lastLivePath(stateDir), SELF);
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
    harness: "claude",
    self: SELF,
    endpoint: SELF_ENDPOINT,
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
      harness: "claude",
      configHome,
      announced: (sid) => domain.transcriptPath(sid),
    }),
    processes,
    forget: (sid) => domain.forget(sid),
    presets: over.presets ?? [],
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

import { isLive } from "../src/sessions/index.ts";

/** The other half of the same list: the rows the instance has lost. */
const isLost = (row: { readonly state?: string }): boolean => !isLive(row as { state?: never });

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
    // what it may reach is not. Outside the range there is nothing to read,
    // which is the code the op declares — a refusal naming the session would
    // answer a question the caller was not entitled to ask.
    expect(
      await refusalOf(() =>
        run("transcript_read", handlers.transcript_read, { sid: OTHER_SID }, as("session", SID)),
      ),
    ).toBe("not_found");
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
    ).toBe("not_found");
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

  test("a pid recycled since the row was written is refused, not signalled", async () => {
    const pid = child();
    const { configHome, handlers, signalled } = ops();
    // The row was written for a session that started hours ago; the process
    // under its pid started moments ago, which is what a recycled pid looks
    // like. argv0 alone accepts it — the harness's own name is what a
    // recycled pid would be running if it were another session of the same
    // harness — so the start times are what separate them.
    writeState(configHome, pid, SID, Date.now() - 3 * 60 * 60 * 1000);
    expect(await refusalOf(() => run("session_kill", handlers.session_kill, { sid: SID }))).toBe(
      "session_not_found",
    );
    expect(signalled).toEqual([]);
    expect(alive(pid)).toBe(true);
  });

  test("the process the row was written for is signalled, start times and all", async () => {
    const pid = child();
    const { configHome, handlers, signalled } = ops();
    // The row is written after its process comes up, so the two instants are
    // near but not equal — the tolerance is what that gap is for, and the real
    // start time is read from the host rather than stated by the test.
    writeState(configHome, pid, SID, Date.now() + 400);
    expect((await run("session_kill", handlers.session_kill, { sid: SID }))["terminated"]).toBe(
      true,
    );
    expect(signalled).toEqual([{ pid, signal: "SIGTERM" }]);
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
    expect(
      domain
        .peerRows()
        .filter(isLost)
        .map((entry) => entry.sid),
    ).toEqual([SID]);

    published.length = 0;
    const removed = await run("session_last_live_remove", handlers.session_last_live_remove, {
      sid: SID,
    });
    expect(removed["removed"]).toBe(true);
    expect(domain.peerRows().filter(isLost)).toEqual([]);
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
    expect(domain.peerRows().filter(isLost)).toEqual([]);
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
    expect(written["bytes"]).toBe(Buffer.byteLength(readFileSync(path)));
  });

  test("what was written is counted by type, and one turn is more than one item", async () => {
    const { configHome, handlers } = ops();
    writeTranscript(configHome, SID);
    const written = await run("session_dump_write", handlers.session_dump_write, { sid: SID });
    // The assistant's one record is the thinking it did and the words it said,
    // which are two items and two things a selection can ask for apart.
    expect(written["entries"]).toEqual({
      "message:user:in": 1,
      thinking: 1,
      "message:user:out": 1,
    });
    const document = dumpAt(written["path"] as string);
    expect(document.items.map((item) => item.type)).toEqual([
      "message:user:in",
      "thinking",
      "message:user:out",
    ]);
    // Every item a record became carries that record's id, which is what makes
    // a bound by record keep a turn whole.
    expect(document.items[1]?.uuid).toBe("a1");
    expect(document.items[2]?.uuid).toBe("a1");
  });

  test("the file is the shape the contract states, and says what it left out", async () => {
    const { configHome, handlers } = ops({
      presets: [{ name: "file", opts: { types: ["tool:Read", "tool:Bash"] } }],
    });
    writeTranscript(configHome, SID, BUSY_TRANSCRIPT);
    const written = await run("session_dump_write", handlers.session_dump_write, {
      sid: SID,
      preset: "file",
      types: ["-tool:Read"],
    });
    const path = written["path"] as string;
    // Two extensions: JSON, and JSON of a shape the contract states. The file
    // travels by its path and is opened by whoever was handed it.
    expect(path.endsWith(".dump.json")).toBe(true);
    const document = dumpAt(path);
    expect(validationErrors(SessionDumpFile, document)).toEqual([]);
    expect(document["sid"]).toBe(SID);
    expect(document["agent_id"]).toBeUndefined();
    expect(document["written_at"]).toBeNumber();
    // The selection as applied, so the file states what it holds without the
    // instance's config having to be read beside it.
    expect(document.types).toEqual(["tool:Read", "tool:Bash", "-tool:Read"]);
    expect(document.items.map((item) => item.type)).toEqual(["tool:Bash", "tool:Bash"]);
  });

  test("a dump of nothing is still a file that says what it is a dump of", async () => {
    const { configHome, handlers } = ops();
    writeTranscript(configHome, SID, BUSY_TRANSCRIPT);
    const written = await run("session_dump_write", handlers.session_dump_write, {
      sid: SID,
      types: ["ids"],
    });
    const document = dumpAt(written["path"] as string);
    expect(validationErrors(SessionDumpFile, document)).toEqual([]);
    expect(written["entries"]).toEqual({});
    expect(document.items).toEqual([]);
    // The ledger is not a type and is never selected away: an id says how to
    // point at something rather than what a line is.
    expect(document.ids).toEqual([]);
  });

  test("the file of an agent's dump names the agent it is of", async () => {
    const { configHome, handlers } = ops();
    const file = writeTranscript(configHome, SID);
    mkdirSync(join(dirname(file), SID, "subagents"), { recursive: true });
    writeFileSync(
      join(dirname(file), SID, "subagents", "agent-acounter-9f.jsonl"),
      AGENT_TRANSCRIPT,
    );
    const written = await run("session_dump_write", handlers.session_dump_write, {
      sid: SID,
      agent_id: "acounter-9f",
    });
    const document = dumpAt(written["path"] as string);
    expect(validationErrors(SessionDumpFile, document)).toEqual([]);
    expect(document["agent_id"]).toBe("acounter-9f");
    // Nothing was noted beside the file, so it is read as an errand's — and
    // every item says so, which is what a client drawing it beside the
    // session's own items reads the relations from.
    expect(new Set(document.items.map((item) => item["subject"]))).toEqual(new Set(["sub"]));
  });

  test("an agent the harness noted as a teammate is dumped as one", async () => {
    const { configHome, handlers } = ops();
    const file = writeTranscript(configHome, SID);
    const under = join(dirname(file), SID, "subagents");
    mkdirSync(under, { recursive: true });
    writeFileSync(join(under, "agent-acounter-9f.jsonl"), AGENT_TRANSCRIPT);
    writeFileSync(
      join(under, "agent-acounter-9f.meta.json"),
      JSON.stringify({ name: "counter", taskKind: "in_process_teammate" }),
    );
    const written = await run("session_dump_write", handlers.session_dump_write, {
      sid: SID,
      agent_id: "acounter-9f",
    });
    const document = dumpAt(written["path"] as string);
    expect(new Set(document.items.map((item) => item["subject"]))).toEqual(new Set(["team"]));
  });

  test("the session's own items are read from the session", async () => {
    const { configHome, handlers } = ops();
    writeTranscript(configHome, SID, BUSY_TRANSCRIPT);
    const read = await run("transcript_items_read", handlers.transcript_items_read, { sid: SID });
    const items = read["items"] as DumpedItem[];
    expect(items.length).toBeGreaterThan(0);
    expect(new Set(items.map((item) => item["subject"]))).toEqual(new Set(["main"]));
  });

  test("every item written passes the contract's own shape", async () => {
    const { configHome, handlers } = ops();
    writeTranscript(configHome, SID, BUSY_TRANSCRIPT);
    const written = await run("session_dump_write", handlers.session_dump_write, { sid: SID });
    const document = dumpAt(written["path"] as string);
    expect(document.items.length).toBeGreaterThan(5);
    for (const item of document.items) {
      expect([item.type, validationErrors(TranscriptItem, item)]).toEqual([item.type, []]);
    }
  });

  test("a selection reads left to right, so a prefix comes in and one member goes back out", async () => {
    const { configHome, handlers } = ops();
    writeTranscript(configHome, SID, BUSY_TRANSCRIPT);
    const written = await run("session_dump_write", handlers.session_dump_write, {
      sid: SID,
      types: ["tool", "-tool:Read"],
    });
    const kinds = Object.keys(written["entries"] as Record<string, number>).sort();
    expect(kinds).toEqual(["tool:Agent", "tool:Bash"]);
  });

  test("a preset is the ground the types are applied over", async () => {
    const { configHome, handlers } = ops({
      presets: [
        { name: "file", opts: { types: ["tool:Read"] } },
        { name: "howto", opts: { types: ["thinking", "@file"] } },
      ],
    });
    writeTranscript(configHome, SID, BUSY_TRANSCRIPT);
    const written = await run("session_dump_write", handlers.session_dump_write, {
      sid: SID,
      preset: "howto",
      types: ["-thinking", "tool:Bash"],
    });
    expect(Object.keys(written["entries"] as Record<string, number>).sort()).toEqual([
      "tool:Bash",
      "tool:Read",
    ]);
  });

  test("a preset nobody configured is refused rather than widening the dump", async () => {
    const { configHome, handlers } = ops();
    writeTranscript(configHome, SID);
    expect(
      await refusalOf(() =>
        run("session_dump_write", handlers.session_dump_write, { sid: SID, preset: "journal" }),
      ),
    ).toBe("invalid_args");
  });

  test("a call and its result point at each other, however far apart they were written", async () => {
    const { configHome, handlers } = ops();
    writeTranscript(configHome, SID, BUSY_TRANSCRIPT);
    const written = await run("session_dump_write", handlers.session_dump_write, {
      sid: SID,
      types: ["tool:Bash"],
    });
    const items = dumpAt(written["path"] as string).items;
    const call = items.find((item) => item["role"] === "use");
    const answer = items.find((item) => item["role"] === "result");
    expect(call?.["result_item"]).toBe(answer?.id);
    expect(answer?.["parent_item"]).toBe(call?.id);
    expect(answer?.["stdout"]).toBe("3\n");
  });

  test("a teammate's brief and its answer are the two halves of one message", async () => {
    const { configHome, handlers } = ops();
    writeTranscript(configHome, SID, BUSY_TRANSCRIPT);
    const written = await run("session_dump_write", handlers.session_dump_write, {
      sid: SID,
      types: ["message:team"],
    });
    const items = dumpAt(written["path"] as string).items;
    const asked = items.find((item) => item.type === "message:team:out");
    const answered = items.find((item) => item.type === "message:team:in");
    expect(asked?.["text"]).toBe("count the lines");
    expect(asked?.["harness_name"]).toBe("count-lines");
    expect(asked?.["agent_id"]).toBe("acounter-9f");
    expect(answered?.["parent_item"]).toBe(asked?.id);
    expect(answered?.["text"]).toBe("there were three");
    // The ledger is what a reader descends by: the agent named here is the
    // subject of the next dump.
    expect(written["ids"]).toContainEqual({
      kind: "agent",
      id: "acounter-9f",
      label: "count-lines",
      status: "completed",
    });
  });

  test("the subject moves to an agent, and the brief it was given reads as what it was told", async () => {
    const { configHome, handlers } = ops();
    const file = writeTranscript(configHome, SID);
    mkdirSync(join(dirname(file), SID, "subagents"), { recursive: true });
    writeFileSync(
      join(dirname(file), SID, "subagents", "agent-acounter-9f.jsonl"),
      AGENT_TRANSCRIPT,
    );
    const written = await run("session_dump_write", handlers.session_dump_write, {
      sid: SID,
      agent_id: "acounter-9f",
    });
    expect(written["entries"]).toEqual({ "message:parent:in": 1, "message:parent:out": 1 });
    const document = dumpAt(written["path"] as string);
    expect(document.items[0]?.["text"]).toBe("count the lines");
    expect(document.items[1]?.["text"]).toBe("there were three");
    expect((written["path"] as string).includes(`${SID}-agent-acounter-9f-`)).toBe(true);
  });

  test("a bound by record cuts at that record, and thinking can be left out", async () => {
    const { configHome, handlers } = ops();
    writeTranscript(configHome, SID);
    const written = await run("session_dump_write", handlers.session_dump_write, {
      sid: SID,
      since_uuid: "a1",
      until_uuid: "a1",
      no_thinking: true,
    });
    expect(written["entries"]).toEqual({ "message:user:out": 1 });
    const document = dumpAt(written["path"] as string);
    expect(document.items[0]?.uuid).toBe("a1");
  });

  test("a session with no transcript has nothing to dump", async () => {
    const { handlers } = ops();
    expect(
      await refusalOf(() => run("session_dump_write", handlers.session_dump_write, { sid: SID })),
    ).toBe("not_found");
  });
});

describe("dump_presets_read", () => {
  test("the selections a dump may be asked for by name are the configured ones, in order", async () => {
    const presets: DumpPreset[] = [
      { name: "file", description: "reads and writes", opts: { types: ["tool:Read"] } },
      { name: "howto", opts: { types: ["thinking", "@file"] } },
    ];
    const { handlers } = ops({ presets });
    expect(await run("dump_presets_read", handlers.dump_presets_read, {})).toEqual({ presets });
  });

  test("an instance configured with none says so rather than inventing any", async () => {
    const { handlers } = ops();
    expect(await run("dump_presets_read", handlers.dump_presets_read, {})).toEqual({ presets: [] });
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

describe("how long a process has been running, as `ps` states it", () => {
  test("the units are read from the end, so every form of it is one instant", () => {
    expect(elapsedSeconds("00:07")).toBe(7);
    expect(elapsedSeconds("12:34")).toBe(12 * 60 + 34);
    expect(elapsedSeconds("01:02:03")).toBe(3_723);
    expect(elapsedSeconds("2-03:04:05")).toBe(2 * 86_400 + 3 * 3_600 + 4 * 60 + 5);
    // A host whose `ps` states it some other way leaves the guard on argv0
    // alone rather than on a number read out of the wrong shape.
    expect(elapsedSeconds("")).toBeUndefined();
    expect(elapsedSeconds("Wed Sep  9 02:45:31 2026")).toBeUndefined();
  });
});

describe("transcript_items_read", () => {
  /** The whole range, so a case can say what a page is a page of. */
  async function all(
    handlers: ReturnType<typeof ops>["handlers"],
    over: Record<string, unknown> = {},
  ) {
    const answer = await run("transcript_items_read", handlers.transcript_items_read, {
      sid: SID,
      ...over,
    });
    return answer as {
      items: DumpedItem[];
      next?: string;
      prev?: string;
      ids?: Record<string, unknown>[];
    };
  }

  test("a range is answered as the items the records were read into", async () => {
    const { configHome, handlers } = ops();
    writeTranscript(configHome, SID, BUSY_TRANSCRIPT);
    const { items, next } = await all(handlers);
    expect(next).toBeUndefined();
    expect(items.map((item) => item.type)).toContain("tool:Bash");
    // Items are finer than records: one assistant line became the thinking and
    // each call it held, and the ids say which of them is which.
    expect(items.filter((item) => item.uuid === "a1").map((item) => item.id)).toEqual([
      "a1:0",
      "a1:1",
      "a1:2",
      "a1:3",
    ]);
  });

  test("a limit cuts the page and names the item it stopped before", async () => {
    const { configHome, handlers } = ops();
    writeTranscript(configHome, SID, BUSY_TRANSCRIPT);
    const whole = (await all(handlers)).items;
    const page = await all(handlers, { since_at: 0, limit: 3 });
    expect(page.items).toHaveLength(3);
    expect(page.next).toBe(whole[3]?.id);

    // Resuming at what was named answers the rest exactly, with nothing read
    // twice and nothing skipped.
    const rest = await all(handlers, { since_id: page.next });
    expect([...page.items, ...rest.items].map((item) => item.id)).toEqual(
      whole.map((item) => item.id),
    );
  });

  test("asking with no bound answers the tail, as the raw read with no before does", async () => {
    const { configHome, handlers } = ops();
    writeTranscript(configHome, SID, BUSY_TRANSCRIPT);
    const whole = (await all(handlers)).items;
    const page = await all(handlers, { limit: 3 });
    // The newest items are what a first read wants, and `prev` is how it walks
    // back from there through a transcript it never has to read whole.
    expect(page.items.map((item) => item.id)).toEqual(whole.slice(-3).map((item) => item.id));
    expect(page.next).toBeUndefined();
    expect(page.prev).toBe(page.items[0]?.id);
  });

  test("a transcript is read from its beginning by saying since_at: 0", async () => {
    const { configHome, handlers } = ops();
    writeTranscript(configHome, SID, BUSY_TRANSCRIPT);
    const whole = (await all(handlers)).items;
    const page = await all(handlers, { since_at: 0, limit: 3 });
    expect(page.items.map((item) => item.id)).toEqual(whole.slice(0, 3).map((item) => item.id));
    expect(page.prev).toBeUndefined();
  });

  test("an upper bound alone answers the range's end and names what precedes it", async () => {
    const { configHome, handlers } = ops();
    writeTranscript(configHome, SID, BUSY_TRANSCRIPT);
    const whole = (await all(handlers)).items;
    const page = await all(handlers, { until_id: whole.at(-1)?.id, limit: 3 });
    // The bound is open, so the item it names is not answered again; what
    // comes back is the three before it, still oldest first.
    expect(page.items.map((item) => item.id)).toEqual(whole.slice(-4, -1).map((item) => item.id));
    expect(page.next).toBeUndefined();
    expect(page.prev).toBe(page.items[0]?.id);
  });

  test("handing back what preceded a page walks to the start of the transcript", async () => {
    const { configHome, handlers } = ops();
    writeTranscript(configHome, SID, BUSY_TRANSCRIPT);
    const whole = (await all(handlers)).items;
    const walked: string[] = [];
    let bound: string | undefined;
    for (;;) {
      const page = await all(handlers, {
        limit: 2,
        ...(bound === undefined ? { until_uuid: whole.at(-1)?.uuid } : { until_id: bound }),
      });
      walked.unshift(...page.items.map((item) => item.id));
      if (page.prev === undefined) break;
      bound = page.prev;
    }
    expect(walked).toEqual(whole.map((item) => item.id));
  });

  test("a lower bound reads forward even when an upper one cuts the range short", async () => {
    const { configHome, handlers } = ops();
    writeTranscript(configHome, SID, BUSY_TRANSCRIPT);
    const whole = (await all(handlers)).items;
    const page = await all(handlers, {
      since_id: whole[1]?.id,
      until_id: whole.at(-1)?.id,
      limit: 2,
    });
    expect(page.items.map((item) => item.id)).toEqual(whole.slice(1, 3).map((item) => item.id));
    expect(page.next).toBe(whole[3]?.id);
    expect(page.prev).toBeUndefined();
  });

  test("a selection is applied to the whole file before the page is cut", async () => {
    const { configHome, handlers } = ops();
    writeTranscript(configHome, SID, BUSY_TRANSCRIPT);
    const { items } = await all(handlers, { types: ["tool", "-tool:Read"] });
    expect([...new Set(items.map((item) => item.type))].sort()).toEqual([
      "tool:Agent",
      "tool:Bash",
    ]);
  });

  test("a link may name an item the range left out, which is not a broken pointer", async () => {
    const { configHome, handlers } = ops();
    writeTranscript(configHome, SID, BUSY_TRANSCRIPT);
    const { items } = await all(handlers, { types: ["tool:Bash"], since_uuid: "r1" });
    const answer = items[0];
    expect(answer?.["role"]).toBe("result");
    // The call fell before the range; the reader knows its id and can ask.
    expect(answer?.["parent_item"]).toBe("a1:1");
  });

  test("the record behind an item is fetched by the address the item carries", async () => {
    const { configHome, handlers } = ops();
    const path = writeTranscript(configHome, SID, BUSY_TRANSCRIPT);
    const { items } = await all(handlers);
    for (const item of items) {
      const source = item["source"] as { offset: number; bytes: number };
      const read = await run("transcript_read", handlers.transcript_read, {
        sid: SID,
        before: source.offset + source.bytes,
        max_bytes: source.bytes,
      });
      const lines = read["lines"] as string[];
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] ?? "")).toMatchObject({ uuid: item.uuid });
    }
    expect(path).toContain(SID);
  });

  test("an agent below the session is read from its own file", async () => {
    const { configHome, handlers } = ops();
    const file = writeTranscript(configHome, SID, BUSY_TRANSCRIPT);
    mkdirSync(join(dirname(file), SID, "subagents"), { recursive: true });
    writeFileSync(
      join(dirname(file), SID, "subagents", "agent-acounter-9f.jsonl"),
      AGENT_TRANSCRIPT,
    );
    const { items } = await all(handlers, { agent_id: "acounter-9f" });
    // Every type is read from where the subject stands, and what stands at
    // the other end of an agent's file is whoever started it rather than a
    // person.
    expect(items.map((item) => item.type)).toEqual(["message:parent:in", "message:parent:out"]);
  });

  test("the ledger is answered when the selection asks for it, and not otherwise", async () => {
    const { configHome, handlers } = ops();
    writeTranscript(configHome, SID, BUSY_TRANSCRIPT);
    expect((await all(handlers)).ids).toBeUndefined();
    const asked = await all(handlers, { types: ["message:team", "ids"] });
    expect(asked.ids).toContainEqual({
      kind: "agent",
      id: "acounter-9f",
      label: "count-lines",
      status: "completed",
    });
  });

  test("a range with two lower bounds is refused rather than guessed at", async () => {
    const { configHome, handlers } = ops();
    writeTranscript(configHome, SID, BUSY_TRANSCRIPT);
    expect(
      await refusalOf(() =>
        run("transcript_items_read", handlers.transcript_items_read, {
          sid: SID,
          since_uuid: "a1",
          since_id: "a1:0",
        }),
      ),
    ).toBe("invalid_args");
  });

  test("a range with two upper bounds is refused the same way", async () => {
    const { configHome, handlers } = ops();
    writeTranscript(configHome, SID, BUSY_TRANSCRIPT);
    expect(
      await refusalOf(() =>
        run("transcript_items_read", handlers.transcript_items_read, {
          sid: SID,
          until_uuid: "a1",
          until_id: "a1:0",
        }),
      ),
    ).toBe("invalid_args");
  });

  test("a session sees its own transcript and no other", async () => {
    const { configHome, handlers } = ops();
    writeTranscript(configHome, SID, BUSY_TRANSCRIPT);
    const own = await run(
      "transcript_items_read",
      handlers.transcript_items_read,
      { sid: SID },
      as("session", SID),
    );
    expect((own["items"] as DumpedItem[]).length).toBeGreaterThan(0);
    expect(
      await refusalOf(() =>
        run(
          "transcript_items_read",
          handlers.transcript_items_read,
          { sid: SID },
          as("session", OTHER_SID),
        ),
      ),
    ).toBe("not_found");
  });
});
