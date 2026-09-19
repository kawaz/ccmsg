import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type HandlerInput, OpError } from "../src/dispatch/index.ts";
import { Containment, fileHandlers, type SessionRoots } from "../src/files/index.ts";
import { SID, TestConn } from "./frames.ts";

/** Two writes of one file started side by side: what an instance answers when a
 * form is submitted twice, or two connections save the same file at once. */
let base: string;
let roots: SessionRoots;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "ccmsg-files-edit-")));
  mkdirSync(join(base, "repo/ws"), { recursive: true });
  roots = {
    root: join(base, "repo"),
    cwd: join(base, "repo/ws"),
    workspace_folders: [],
    external_files: [],
  };
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

function files() {
  return fileHandlers(
    new Containment({ roots: async (sid) => (sid === SID ? roots : undefined) }),
    () => false,
  );
}

function caller(): Pick<HandlerInput, "conn" | "identity"> {
  const identity = { state: "settled" as const, role: "user" as const };
  return { conn: new TestConn(identity), identity };
}

function input(op: string, args: Record<string, unknown>): HandlerInput {
  return { op, args: { op, request_id: "1", ...args }, ...caller() } as HandlerInput;
}

/** The outcome of one call, as a code: the answer's, or the refusal's. Anything
 * that is neither is a raw failure dispatch would answer as `internal_error`. */
async function outcomeOf(call: Promise<unknown>): Promise<string> {
  try {
    await call;
    return "ok";
  } catch (cause) {
    if (cause instanceof OpError) return cause.code;
    throw cause;
  }
}

/** What lies beside the file: the staging files a replace writes and renames
 * away, which are what a write that lost its name to another leaves behind. */
function leftovers(): string[] {
  return readdirSync(join(base, "repo/ws")).filter((name) => name.includes(".ccmsg-"));
}

describe("file.edit: two edits of one file at once", () => {
  test("the same token is honoured once, and the file holds the first edit", async () => {
    const handlers = files();
    await handlers["file.create"](
      input("file.create", { sid: SID, kind: "contained", path: "ws/shared.txt", content: "" }),
    );
    const read = (await handlers["file.read"](
      input("file.read", { sid: SID, kind: "contained", path: "ws/shared.txt" }),
    )) as { mtime_at: number; size: number };
    const token = { expected_mtime_at: read.mtime_at, expected_size: read.size };

    const edit = (content: string) =>
      handlers["file.edit"](
        input("file.edit", {
          sid: SID,
          kind: "contained",
          path: "ws/shared.txt",
          content: Buffer.from(content).toString("base64"),
          ...token,
        }),
      );
    // Which of the two lands first is not stated: dispatch runs them side by
    // side, and each reaches the file's write chain when its path is located.
    // What is stated is that exactly one of them does, and the file is that one.
    const bodies = ["first\n", "second\n"];
    const outcomes = await Promise.all(bodies.map((body) => outcomeOf(edit(body))));

    expect(outcomes.filter((each) => each === "ok")).toHaveLength(1);
    expect(outcomes.filter((each) => each === "file_conflict")).toHaveLength(1);
    const landed = bodies[outcomes.indexOf("ok")];
    expect(readFileSync(join(base, "repo/ws/shared.txt"), "utf8")).toBe(landed);
  });

  test("the file holds one edit whole, and nothing is left beside it", async () => {
    const handlers = files();
    await handlers["file.create"](
      input("file.create", { sid: SID, kind: "contained", path: "ws/raced.txt", content: "" }),
    );
    const read = (await handlers["file.read"](
      input("file.read", { sid: SID, kind: "contained", path: "ws/raced.txt" }),
    )) as { mtime_at: number; size: number };
    const token = { expected_mtime_at: read.mtime_at, expected_size: read.size };

    // Bodies of unequal length, so two writes landing in one staging file would
    // leave the longer one's tail and the shorter one's head rather than a body
    // either of them wrote.
    const longer = "the longer of the two bodies\n".repeat(64);
    const shorter = "short\n".repeat(8);
    const edit = (content: string) =>
      handlers["file.edit"](
        input("file.edit", {
          sid: SID,
          kind: "contained",
          path: "ws/raced.txt",
          content: Buffer.from(content).toString("base64"),
          ...token,
        }),
      );
    // The clock is held still while the two run: a staging name that took its
    // uniqueness from the clock would be one name for both, and the test states
    // that the name owes nothing to the clock rather than waiting for a
    // millisecond to prove it.
    const now = Date.now;
    Date.now = () => 1_800_000_000_000;
    let outcomes: string[];
    try {
      outcomes = await Promise.all([outcomeOf(edit(longer)), outcomeOf(edit(shorter))]);
    } finally {
      Date.now = now;
    }

    expect(outcomes).toContain("ok");
    const body = readFileSync(join(base, "repo/ws/raced.txt"));
    expect(body.includes(0)).toBe(false);
    expect([longer, shorter]).toContain(body.toString("utf8"));
    expect(leftovers()).toEqual([]);
  });
});
