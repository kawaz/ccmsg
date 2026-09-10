import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { OP_NAMES, opAttributes } from "@ccmsg/protocol";

/** M1: authorization is derived from the op attribute table, so no role is
 * compared by hand (daemon-v2 §1.1 / §11.3).
 *
 * The table sweep in dispatch.test.ts covers the behaviour; this covers the
 * shape, which behaviour cannot see: a hand-written role branch that happens
 * to agree with the table passes every sweep and still is the second place the
 * rule lives. The scan is over the instance's own code: the CLI is left out
 * because it speaks as a client, where a role literal is what a connection
 * announces about itself rather than a judgement about somebody else's, and
 * route (a) is left out because the only such word in it is the harness's own
 * frame type — a foreign protocol's spelling, on a path that authorizes
 * nothing. The fold and the classifier are left out for the same
 * reason: `"user"` there is the harness's own name for a kind of transcript
 * record, read from a file that grants nobody anything. The gateway's reader is left out because `"instance"`
 * there names a field of the contract's own request type — the one the
 * publisher stamps and the parser therefore omits — on a path that reads a
 * posted document and authorizes nobody. The mesh is left out for the same
 * reason as the CLI: the `"instance"` there is in the greeting this instance
 * sends when it dials a peer, where the word announces what this connection is
 * rather than judging what somebody else's may do. Which peer connections are
 * accepted is decided by the handshake, and a peer that passes it is settled
 * through the same `hello` reply every other role is. The daemon's control
 * connection is left out for the CLI's reason and is the CLI's code moved out
 * of it: the `"user"` there is what the command announces itself as. The
 * service definitions are left out because the `"user"` in them is a directory
 * segment of systemd's own layout, which grants nobody anything. */
const FOREIGN = new Set([
  "cli.ts",
  "daemon/control.ts",
  "mesh/mesh.ts",
  "messaging/direct.ts",
  "service/service.ts",
  "transcript/fold.ts",
  "transcript/items/classify.ts",
  "upstream/events.ts",
]);
/** Where a role is read on purpose: the implementations of the ops the
 * attribute table marks `scope: "role"`, which is the one route by which a role
 * reaches an implementation (daemon-v2 §3.2). There the role decides what the
 * reply may contain rather than whether the call is allowed, so the comparison
 * is the op's own rule and not a second copy of the table's. The sweep below
 * fails if the table stops declaring that scope, which is what keeps the
 * exception tied to the contract rather than to this list. */
const SCOPE_ROLE = new Set(["files/containment.ts"]);
/** Where a role is read because it decides what a frame has to *carry* rather
 * than what its sender may do.
 *
 * Two frames name a role: the greeting, where a session states its sid, a
 * person states none and an instance states its mesh claim; and the envelope's
 * `caller`, where a forwarded request names who it runs as and carries a sid
 * exactly when that is a session. Neither is the table's question — the table
 * says who may call an op, and it is read afterwards, against whatever
 * identity these two settle — and neither can live in the contract's schema,
 * because one schema covers all three roles and marks every such field
 * optional. So each is the instance's own rule about what a role has to say
 * about itself, not a second copy of whether the call was allowed. */
const SHAPED_BY_ROLE = new Set(["sessions/registry.ts", "dispatch/caller.ts"]);

const ROLE_LITERAL = /"(?:session|user|instance)"/;
const ROLE_COMPARISON = /\brole\s*[=!]==/;

const SRC = new URL("../src/", import.meta.url).pathname;

describe("no role comparison outside the attribute table (M1)", () => {
  const files = [...new Glob("**/*.ts").scanSync(SRC)].filter(
    (path) => !FOREIGN.has(path) && !SCOPE_ROLE.has(path) && !SHAPED_BY_ROLE.has(path),
  );

  test("the contract still declares the scope the exception rests on", () => {
    const scoped = OP_NAMES.filter((op) => opAttributes(op).scope === "role");
    expect(scoped.length).toBeGreaterThan(0);
  });

  test("the scan covers the dispatch module", () => {
    expect(files.some((path) => path.startsWith("dispatch/"))).toBe(true);
  });

  for (const path of files) {
    test(`${path} compares no role`, async () => {
      const source = await Bun.file(SRC + path).text();
      const offenders = source
        .split("\n")
        .map((line, i) => ({ line: line.trim(), no: i + 1 }))
        .filter(({ line }) => !line.startsWith("*") && !line.startsWith("//"))
        .filter(({ line }) => ROLE_LITERAL.test(line) || ROLE_COMPARISON.test(line));
      expect(offenders).toEqual([]);
    });
  }
});
