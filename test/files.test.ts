import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type OpName,
  OP_SCHEMAS,
  opAttributes,
  type Role,
  type Sid,
  validationErrors,
} from "@ccmsg/protocol";
import { type HandlerInput, OpError } from "../src/dispatch/index.ts";
import {
  Containment,
  fileHandlers,
  sandboxCapabilities,
  SandboxGrants,
  type SessionRoots,
} from "../src/files/index.ts";
import { sessionStatusOf } from "../src/sessions/index.ts";
import { TranscriptFold } from "../src/transcript/index.ts";
import { OTHER_SID, SID, TestConn } from "./frames.ts";

/** A tree with one of each surface, and one file outside every surface.
 *
 * `repo` is the container a session greets with and `repo/ws` the working copy
 * it runs in, which is the layout the two differ in — a contained path is
 * reached through the container while a written file lands in the working copy.
 */
let base: string;
let roots: SessionRoots;

beforeAll(() => {
  // Resolved, because every path the instance answers with is: on macOS the
  // temporary directory is itself a symlink, and an unresolved fixture would
  // compare the two spellings of the same file rather than the containment.
  base = realpathSync(mkdtempSync(join(tmpdir(), "ccmsg-files-")));
  mkdirSync(join(base, "repo/ws/sub"), { recursive: true });
  mkdirSync(join(base, "repo/ws/node_modules"), { recursive: true });
  mkdirSync(join(base, "space"), { recursive: true });
  mkdirSync(join(base, "outside"), { recursive: true });
  writeFileSync(join(base, "repo/ws/hello.txt"), "hello\n");
  writeFileSync(join(base, "repo/ws/sub/deep.txt"), "deep\n");
  writeFileSync(join(base, "repo/ws/binary.dat"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
  writeFileSync(join(base, "repo/ws/.gitignore"), "node_modules\n");
  writeFileSync(join(base, "repo/ws/node_modules/hello-vendored.txt"), "vendored\n");
  writeFileSync(join(base, "space/doc.md"), "# doc\n");
  writeFileSync(join(base, "outside/named.txt"), "named\n");
  writeFileSync(join(base, "outside/secret.txt"), "secret\n");
  // A link inside the root pointing out of it: listed as itself, and refusing
  // to resolve wherever a path is decided.
  symlinkSync(join(base, "outside/secret.txt"), join(base, "repo/ws/escape.txt"));
  roots = {
    root: join(base, "repo"),
    cwd: join(base, "repo/ws"),
    workspace_folders: [join(base, "space")],
    external_files: [join(base, "outside/named.txt")],
  };
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

function containment(over: Partial<SessionRoots> = {}): Containment {
  return new Containment({
    roots: (sid) => (sid === SID ? { ...roots, ...over } : undefined),
  });
}

function handlers(over: Partial<SessionRoots> = {}) {
  return fileHandlers(containment(over));
}

/** A caller: a person greets with no sid, a session names itself with one. */
function as(role: Role, sid?: Sid): Pick<HandlerInput, "conn" | "identity"> {
  const identity = { state: "settled" as const, role, ...(sid === undefined ? {} : { sid }) };
  return { conn: new TestConn(identity), identity };
}

/** Run one op the way dispatch would, and hold its answer to the contract: a
 * body that does not pass the op's own response schema is a contract violation
 * even when the assertions below are happy (§11.1).
 *
 * The role is passed exactly where dispatch passes it — for an op the attribute
 * table marks `scope: "role"` and no other — so a range that only appears
 * because a test handed a role over would fail here rather than pass. */
function run(
  op: OpName,
  handler: (input: HandlerInput) => unknown,
  args: Record<string, unknown>,
  caller = as("user"),
): Record<string, unknown> {
  const scoped = opAttributes(op).scope === "role" && caller.identity !== undefined;
  const body = handler({
    op,
    args: { op, request_id: "1", ...args },
    ...caller,
    ...(scoped ? { role: caller.identity?.role } : {}),
  }) as object;
  const problems = validationErrors(OP_SCHEMAS[op].response, {
    ok: true,
    request_id: "1",
    ...body,
  });
  expect(problems).toEqual([]);
  return body as Record<string, unknown>;
}

function refusalOf(call: () => unknown): string {
  try {
    call();
  } catch (cause) {
    if (cause instanceof OpError) return cause.code;
    throw cause;
  }
  throw new Error("the call was not refused");
}

const files = () => handlers();

describe("contained", () => {
  test("lists the root and reads a file below it", () => {
    const list = run("dir.list", files()["dir.list"], { sid: SID, kind: "contained", path: "ws" });
    expect(list["path"]).toBe("ws");
    const names = (list["entries"] as { name: string }[]).map((entry) => entry.name);
    expect(names).toContain("hello.txt");
    const read = run("file.read", files()["file.read"], {
      sid: SID,
      kind: "contained",
      path: "ws/hello.txt",
    });
    expect(read).toMatchObject({ path: "ws/hello.txt", content: "hello\n", binary: false });
    expect(read["truncated"]).toBe(false);
  });

  test("a symlink is listed as itself and refuses to resolve", () => {
    const list = run("dir.list", files()["dir.list"], { sid: SID, kind: "contained", path: "ws" });
    const link = (list["entries"] as { name: string; type: string }[]).find(
      (entry) => entry.name === "escape.txt",
    );
    expect(link?.type).toBe("symlink");
    expect(
      refusalOf(() =>
        run("file.read", files()["file.read"], {
          sid: SID,
          kind: "contained",
          path: "ws/escape.txt",
        }),
      ),
    ).toBe("path_forbidden");
  });

  test("a path spelled out of the root is refused", () => {
    expect(
      refusalOf(() =>
        run("file.read", files()["file.read"], {
          sid: SID,
          kind: "contained",
          path: "../outside/secret.txt",
        }),
      ),
    ).toBe("path_forbidden");
  });

  test("a session that greeted with no root admits nothing", () => {
    const bare = fileHandlers(new Containment({ roots: () => undefined }));
    expect(
      refusalOf(() =>
        run("file.read", bare["file.read"], { sid: SID, kind: "contained", path: "ws/hello.txt" }),
      ),
    ).toBe("path_forbidden");
  });

  test("a file too large to hold in memory is answered from its head", () => {
    // The answer carries at most `READ_LIMIT`, so what is read is at most that.
    // A file past the largest buffer this runtime can allocate is the proof:
    // reading it whole cannot succeed, and answering it from its head must.
    // Sparse, so the size is the only thing about it that is large.
    const path = join(base, "repo/ws/enormous.txt");
    const marker = `${"the head of it\n".repeat(1000)}`;
    writeFileSync(path, marker);
    truncateSync(path, 5 * 1024 * 1024 * 1024);
    const stat = statSync(path);
    // A filesystem that gave us five real gigabytes is not one to run this on.
    if (stat.blocks * 512 > 64 * 1024 * 1024) {
      rmSync(path);
      return;
    }

    const read = run("file.read", files()["file.read"], {
      sid: SID,
      kind: "contained",
      path: "ws/enormous.txt",
    });

    expect(read["size"]).toBe(stat.size);
    expect(read["truncated"]).toBe(true);
    expect(read["binary"]).toBe(false);
    expect((read["content"] as string).length).toBe(512 * 1024);
    expect(read["content"]).toStartWith(marker);
    rmSync(path);
  });

  test("a binary file is answered without its content", () => {
    const read = run("file.read", files()["file.read"], {
      sid: SID,
      kind: "contained",
      path: "ws/binary.dat",
    });
    expect(read).toMatchObject({ binary: true, content: "" });
  });
});

describe("workspace", () => {
  test("a folder the session's editor names is reachable by absolute path", () => {
    const read = run("file.read", files()["file.read"], {
      sid: SID,
      kind: "workspace",
      path: join(base, "space/doc.md"),
    });
    expect(read["content"]).toBe("# doc\n");
    expect(read["path"]).toBe(join(base, "space/doc.md"));
  });

  test("a path in no named folder is refused", () => {
    expect(
      refusalOf(() =>
        run("file.read", files()["file.read"], {
          sid: SID,
          kind: "workspace",
          path: join(base, "outside/secret.txt"),
        }),
      ),
    ).toBe("path_forbidden");
  });
});

describe("external", () => {
  test("exactly the file the transcript named is readable", () => {
    const read = run("file.read", files()["file.read"], {
      sid: SID,
      kind: "external",
      path: join(base, "outside/named.txt"),
    });
    expect(read["content"]).toBe("named\n");
  });

  test("its neighbour in the same folder is not", () => {
    expect(
      refusalOf(() =>
        run("file.read", files()["file.read"], {
          sid: SID,
          kind: "external",
          path: join(base, "outside/secret.txt"),
        }),
      ),
    ).toBe("path_forbidden");
  });
});

describe("the visible range differs by role (scope: role)", () => {
  const own = as("session", SID);
  const other = as("session", OTHER_SID);

  test("a session reaches its own session's files", () => {
    const read = run(
      "file.read",
      files()["file.read"],
      { sid: SID, kind: "contained", path: "ws/hello.txt" },
      own,
    );
    expect(read["content"]).toBe("hello\n");
  });

  test("a session reaches no other session's files", () => {
    expect(
      refusalOf(() =>
        run(
          "file.read",
          files()["file.read"],
          { sid: SID, kind: "contained", path: "ws/hello.txt" },
          other,
        ),
      ),
    ).toBe("path_forbidden");
    expect(
      refusalOf(() =>
        run("dir.list", files()["dir.list"], { sid: SID, kind: "contained", path: "ws" }, other),
      ),
    ).toBe("path_forbidden");
  });

  test("a role the rule does not name reaches nothing", () => {
    expect(
      refusalOf(() =>
        run(
          "file.read",
          files()["file.read"],
          { sid: SID, kind: "contained", path: "ws/hello.txt" },
          as("instance", SID),
        ),
      ),
    ).toBe("path_forbidden");
  });

  test("a person reaches any session's files", () => {
    const list = run(
      "dir.list",
      files()["dir.list"],
      { sid: SID, kind: "contained", path: "ws" },
      as("user"),
    );
    expect((list["entries"] as unknown[]).length).toBeGreaterThan(0);
  });
});

describe("file.write: the inbox", () => {
  test("writes below the working directory and makes the folder", () => {
    const write = run("file.write", files()["file.write"], {
      sid: SID,
      path: "docs/inbox/note.md",
      content: "note\n",
    });
    expect(write["path"]).toBe("docs/inbox/note.md");
    expect(statSync(join(base, "repo/ws/docs/inbox/note.md")).isFile()).toBe(true);
  });

  test("the same name twice is refused rather than replaced", () => {
    expect(
      refusalOf(() =>
        run("file.write", files()["file.write"], {
          sid: SID,
          path: "docs/inbox/note.md",
          content: "again\n",
        }),
      ),
    ).toBe("file_exists");
  });

  test("a name outside the inbox is not writable", () => {
    expect(
      refusalOf(() =>
        run("file.write", files()["file.write"], { sid: SID, path: "elsewhere.md", content: "" }),
      ),
    ).toBe("path_not_writable");
  });
});

describe("file.create", () => {
  test("creates a file that is not there", () => {
    const created = run("file.create", files()["file.create"], {
      sid: SID,
      kind: "contained",
      path: "ws/sub/fresh.txt",
      content: "fresh\n",
    });
    expect(created["path"]).toBe("ws/sub/fresh.txt");
  });

  test("never replaces one that is", () => {
    expect(
      refusalOf(() =>
        run("file.create", files()["file.create"], {
          sid: SID,
          kind: "contained",
          path: "ws/hello.txt",
          content: "",
        }),
      ),
    ).toBe("file_exists");
  });

  test("makes no parent folder", () => {
    expect(
      refusalOf(() =>
        run("file.create", files()["file.create"], {
          sid: SID,
          kind: "contained",
          path: "ws/absent/new.txt",
          content: "",
        }),
      ),
    ).toBe("not_found");
  });
});

describe("file.edit", () => {
  test("overwrites what was read, and hands back the next token", () => {
    const read = run("file.read", files()["file.read"], {
      sid: SID,
      kind: "contained",
      path: "ws/sub/deep.txt",
    });
    const edited = run("file.edit", files()["file.edit"], {
      sid: SID,
      kind: "contained",
      path: "ws/sub/deep.txt",
      content: "deeper\n",
      expected_mtime_at: read["mtime_at"],
      expected_size: read["size"],
    });
    expect(edited["size"]).toBe(7);
    const after = run("file.read", files()["file.read"], {
      sid: SID,
      kind: "contained",
      path: "ws/sub/deep.txt",
    });
    expect(after["content"]).toBe("deeper\n");
    expect(after["mtime_at"]).toBe(edited["mtime_at"]);
  });

  test("a file that moved on since the read is refused", () => {
    const read = run("file.read", files()["file.read"], {
      sid: SID,
      kind: "contained",
      path: "ws/sub/deep.txt",
    });
    writeFileSync(join(base, "repo/ws/sub/deep.txt"), "somebody else\n");
    expect(
      refusalOf(() =>
        run("file.edit", files()["file.edit"], {
          sid: SID,
          kind: "contained",
          path: "ws/sub/deep.txt",
          content: "mine\n",
          expected_mtime_at: read["mtime_at"],
          expected_size: read["size"],
        }),
      ),
    ).toBe("file_conflict");
  });

  test("a binary file is never turned into text", () => {
    const stat = statSync(join(base, "repo/ws/binary.dat"));
    expect(
      refusalOf(() =>
        run("file.edit", files()["file.edit"], {
          sid: SID,
          kind: "contained",
          path: "ws/binary.dat",
          content: "text\n",
          expected_mtime_at: Math.floor(stat.mtimeMs),
          expected_size: stat.size,
        }),
      ),
    ).toBe("not_a_text_file");
  });
});

describe("file.delete", () => {
  test("unlinks one plain file", () => {
    writeFileSync(join(base, "repo/ws/sub/doomed.txt"), "x\n");
    const deleted = run("file.delete", files()["file.delete"], {
      sid: SID,
      kind: "contained",
      path: "ws/sub/doomed.txt",
    });
    expect(deleted["path"]).toBe("ws/sub/doomed.txt");
    expect(
      refusalOf(() =>
        run("file.read", files()["file.read"], {
          sid: SID,
          kind: "contained",
          path: "ws/sub/doomed.txt",
        }),
      ),
    ).toBe("not_found");
  });

  test("never a folder and never a symlink", () => {
    expect(
      refusalOf(() =>
        run("file.delete", files()["file.delete"], { sid: SID, kind: "contained", path: "ws/sub" }),
      ),
    ).toBe("path_forbidden");
    expect(
      refusalOf(() =>
        run("file.delete", files()["file.delete"], {
          sid: SID,
          kind: "contained",
          path: "ws/escape.txt",
        }),
      ),
    ).toBe("path_forbidden");
  });

  test("a link to a file inside the root does not delete what it points at", () => {
    // The link resolves to a path every check admits, so nothing but reading
    // the name itself tells the two apart. Deleting through it would unlink a
    // file the caller never named.
    const target = join(base, "repo/ws/sub/pointed-at.txt");
    writeFileSync(target, "keep\n");
    symlinkSync(target, join(base, "repo/ws/sub/pointer.txt"));
    expect(
      refusalOf(() =>
        run("file.delete", files()["file.delete"], {
          sid: SID,
          kind: "contained",
          path: "ws/sub/pointer.txt",
        }),
      ),
    ).toBe("path_forbidden");
    expect(statSync(target).isFile()).toBe(true);
  });
});

describe("file.find", () => {
  test("finds by the words a path holds, and excludes with a leading dash", () => {
    const found = run("file.find", files()["file.find"], {
      sid: SID,
      kind: "contained",
      query: "hello",
    });
    const hits = (found["hits"] as { path: string }[]).map((hit) => hit.path);
    expect(hits).toContain("ws/hello.txt");
    const narrowed = run("file.find", files()["file.find"], {
      sid: SID,
      kind: "contained",
      query: "hello -ws",
    });
    expect(narrowed["hits"]).toEqual([]);
  });

  test("what the repository's ignore rules hide stays hidden unless asked for", () => {
    const hidden = run("file.find", files()["file.find"], {
      sid: SID,
      kind: "contained",
      query: "vendored",
    });
    expect(hidden["hits"]).toEqual([]);
    const shown = run("file.find", files()["file.find"], {
      sid: SID,
      kind: "contained",
      query: "vendored",
      respect_gitignore: false,
    });
    expect((shown["hits"] as unknown[]).length).toBe(1);
  });

  test("a query with nothing to include matches nothing", () => {
    const empty = run("file.find", files()["file.find"], {
      sid: SID,
      kind: "contained",
      query: "  ",
    });
    expect(empty).toMatchObject({ hits: [], truncated: false });
  });
});

describe("file.stat", () => {
  test("names the surface each path is served through, and misses are null", () => {
    const body = run("file.stat", files()["file.stat"], {
      sid: SID,
      paths: [
        join(base, "repo/ws/hello.txt"),
        join(base, "space/doc.md"),
        join(base, "outside/named.txt"),
        join(base, "outside/secret.txt"),
        join(base, "repo/ws/nowhere.txt"),
      ],
    });
    expect(body["results"]).toEqual([
      { kind: "contained", path: "ws/hello.txt" },
      { kind: "workspace", path: join(base, "space/doc.md") },
      { kind: "external", path: join(base, "outside/named.txt") },
      null,
      null,
    ]);
  });

  test("a path outside every surface is the same miss as one that is not there", () => {
    const body = run("file.stat", files()["file.stat"], {
      sid: SID,
      paths: [join(base, "outside/secret.txt"), join(base, "outside/never-existed.txt")],
    });
    expect(body["results"]).toEqual([null, null]);
  });
});

describe("sandbox", () => {
  const origin = "https://ccmsg-files-{gid}.example.test";

  test("the capability is named only where an origin is configured", () => {
    expect(sandboxCapabilities(origin)).toEqual(["sandbox"]);
    expect(sandboxCapabilities(undefined)).toEqual([]);
    expect(sandboxCapabilities("https://no-placeholder.example.test")).toEqual([]);
  });

  test("a grant reaches only what the matching read reaches", () => {
    const grants = new SandboxGrants(containment(), origin);
    expect(
      refusalOf(() =>
        grants.mint({ sid: SID, kind: "external", path: join(base, "outside/secret.txt") }),
      ),
    ).toBe("path_forbidden");
    // `sandbox.grant` is a person's op and the table gives it no `scope`, so
    // there is no visible range to narrow: what a grant refuses is what the
    // matching read refuses, and nothing else.
  });

  test("the same scope keeps its id and moves its expiry out", () => {
    const grants = new SandboxGrants(containment(), origin);
    const first = grants.mint(
      { sid: SID, kind: "contained", path: "ws/hello.txt" },
      undefined,
      1000,
    );
    expect(first.url).toBe(
      `https://ccmsg-files-${first.gid}.example.test/${first.token}/hello.txt`,
    );
    const again = grants.mint(
      { sid: SID, kind: "contained", path: "ws/sub/../hello.txt" },
      {},
      2000,
    );
    expect(again.gid).toBe(first.gid);
    expect(again.token).toBe(first.token);
    expect(again.expires_at).toBeGreaterThan(first.expires_at);
    expect(grants.find(first.gid, 2000)).toBeDefined();
  });

  test("a grant stops at its expiry, and revoking one is best effort", () => {
    const grants = new SandboxGrants(containment(), origin);
    const grant = grants.mint({ sid: SID, kind: "contained", path: "ws/hello.txt" }, {}, 0);
    expect(grants.find(grant.gid, grant.expires_at + 1)).toBeUndefined();
    expect(grants.revoke({ gid: grant.gid })).toEqual({});
    expect(grants.revoke({ gid: "never-minted" })).toEqual({});
  });

  test("an external grant is bound to the one file", () => {
    const grants = new SandboxGrants(containment(), origin);
    const grant = grants.mint({
      sid: SID,
      kind: "external",
      path: join(base, "outside/named.txt"),
    });
    expect(grant.url.endsWith(grant.token)).toBe(true);
  });
});

/** The surfaces, reached the way the instance reaches them: what the fold read
 * out of a transcript becomes the allowlist a path is admitted by. Nothing here
 * states an allowlist directly — a fixture that did would pass while the fold
 * that has to fill it stayed empty. */
describe("the allowlists a session's own facts state", () => {
  const NAMED = "/named.txt";
  const UNNAMED = "/secret.txt";

  /** The status frame for a transcript of these rows, as `session.status:<sid>`
   * would carry it and as containment reads it. */
  function stated(rows: object[], where: { root?: string; cwd?: string }) {
    const fold = new TranscriptFold();
    for (const row of rows) fold.line(JSON.stringify(row));
    const status = sessionStatusOf(SID, fold.facts, where);
    return {
      status,
      containment: new Containment({
        roots: (sid) =>
          sid === SID
            ? {
                ...where,
                workspace_folders: status.workspace_folders.map((each) => each.path),
                external_files: status.external_files.map((each) => each.path),
              }
            : undefined,
      }),
    };
  }

  const read = (path: string) => ({
    type: "assistant",
    timestamp: "2026-09-08T10:00:00.000Z",
    message: {
      model: "claude-fable-5",
      content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: path } }],
    },
  });

  /** Read inside each test: the fixture tree is built in `beforeAll`. */
  const where = () => ({ root: join(base, "repo"), cwd: join(base, "repo/ws") });

  test("a file the transcript named outside the root is reachable as external", () => {
    const { status, containment } = stated([read(join(base, "outside", NAMED))], where());
    expect(status.external_files).toEqual([{ path: join(base, "outside", NAMED), origin: "tool" }]);
    expect(
      containment.locate({ sid: SID, kind: "external", path: join(base, "outside", NAMED) }).real,
    ).toBe(join(base, "outside", NAMED));
  });

  test("a file the transcript never named is not", () => {
    const { containment } = stated([read(join(base, "outside", NAMED))], where());
    expect(() =>
      containment.locate({ sid: SID, kind: "external", path: join(base, "outside", UNNAMED) }),
    ).toThrow(OpError);
  });

  test("a file inside the root is not external, since external is what is outside it", () => {
    const inside = join(base, "repo/ws/hello.txt");
    const { status } = stated([read(inside)], where());
    expect(status.external_files).toEqual([]);
  });

  test("a session that stated no root admits none of the paths it named", () => {
    const { status } = stated([read(join(base, "outside", NAMED))], { cwd: join(base, "repo/ws") });
    expect(status.external_files).toEqual([]);
  });

  test("a workspace file beside the working directory admits its whole subtree", () => {
    writeFileSync(
      join(base, "repo/ws/project.code-workspace"),
      // With a comment and a trailing comma, as the editors that write these allow.
      `{\n  // the folders of this workspace\n  "folders": [{ "path": "../../space", "name": "docs" },],\n}\n`,
    );
    try {
      const { status, containment } = stated([], where());
      expect(status.workspace_folders).toEqual([{ name: "docs", path: join(base, "space") }]);
      expect(
        containment.locate({ sid: SID, kind: "workspace", path: join(base, "space/doc.md") }).kind,
      ).toBe("workspace");
      expect(() =>
        containment.locate({ sid: SID, kind: "workspace", path: join(base, "outside", NAMED) }),
      ).toThrow(OpError);
    } finally {
      rmSync(join(base, "repo/ws/project.code-workspace"));
    }
  });

  test("a working directory with no workspace file names no folder", () => {
    const { status, containment } = stated([], where());
    expect(status.workspace_folders).toEqual([]);
    expect(() =>
      containment.locate({ sid: SID, kind: "workspace", path: join(base, "space/doc.md") }),
    ).toThrow(OpError);
  });
});
