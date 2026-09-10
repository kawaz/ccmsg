import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionSearchArgs } from "@ccmsg/protocol";
import { OpError } from "../src/dispatch/index.ts";
import { search } from "../src/sessions/index.ts";
import { TranscriptFiles } from "../src/transcript/index.ts";
import { OTHER_SID, SELF, SID } from "./frames.ts";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** A config home holding one transcript per session, in the layout the walk
 * expects: `projects/<flattened cwd>/<sid>.jsonl`. */
function home(transcripts: Record<string, readonly string[]>) {
  const root = mkdtempSync(join(tmpdir(), "ccmsg-search-"));
  homes.push(root);
  const project = join(root, "projects", "-repos-a-repo-main");
  mkdirSync(project, { recursive: true });
  for (const [sid, said] of Object.entries(transcripts)) {
    writeFileSync(
      join(project, `${sid}.jsonl`),
      said
        .map(
          (text) =>
            `${JSON.stringify({
              type: "user",
              cwd: "/repos/a-repo/main",
              timestamp: new Date(1_757_000_000_000).toISOString(),
              message: { role: "user", content: text },
            })}\n`,
        )
        .join(""),
    );
  }
  return {
    root,
    deps: {
      self: SELF,
      configHome: root,
      files: new TranscriptFiles({
        harness: "claude",
        configHome: root,
        announced: () => undefined,
      }),
    },
  };
}

function ask(args: Partial<SessionSearchArgs>, deps: ReturnType<typeof home>["deps"]) {
  return search({ op: "session_search", request_id: "1", ...args } as SessionSearchArgs, deps);
}

describe("what a regular-expression query may cost (§5)", () => {
  test("a clause longer than the cap is refused rather than compiled", () => {
    const { deps } = home({ [SID]: ["anything"] });

    let refused: unknown;
    try {
      ask({ query: "a".repeat(1001), regex: true }, deps);
    } catch (cause) {
      refused = cause;
    }
    expect(refused).toBeInstanceOf(OpError);
    expect((refused as OpError).code).toBe("invalid_args");
    // The cap is on the clause, not on the query: as many clauses as a caller
    // likes, each within it.
    expect(ask({ query: `${"a".repeat(1000)}\nb`, regex: true }, deps).truncated).toBe(false);
  });

  test("a clause that backtracks without end is cut off and the answer says so", () => {
    // The classic catastrophic pattern, over records built to defeat it: every
    // record costs it time exponential in their length, so it cannot finish and
    // the budget is the only thing that ends it.
    const said = Array.from({ length: 40 }, () => `${"a".repeat(40)}!`);
    const { deps } = home({ [SID]: said, [OTHER_SID]: said });

    const started = performance.now();
    const result = ask({ query: "^(a+)+$", regex: true }, deps);
    const spent = performance.now() - started;

    expect(result.truncated).toBe(true);
    // Cut off within the budget rather than running to the end of the walk,
    // which at this pattern's cost would be longer than anyone would wait.
    expect(spent).toBeLessThan(20_000);
  }, 30_000);

  test("a well-formed clause is answered whole, and says nothing was left out", () => {
    // The other side of the budget: it must not cut off an honest query. These
    // are the same records the catastrophic clause could not finish.
    const said = Array.from({ length: 40 }, () => `${"a".repeat(40)}!`);
    const { deps } = home({ [SID]: [...said, "the needle is here"], [OTHER_SID]: said });

    const result = ask({ query: "needle", regex: true }, deps);

    expect(result.truncated).toBe(false);
    expect(result.hits.map((hit) => hit.sid)).toEqual([SID]);
  });

  test("a query of terms is not budgeted, since substring matching is linear", () => {
    const { deps } = home({ [SID]: ["the needle is here"], [OTHER_SID]: ["straw"] });

    const result = ask({ query: "needle" }, deps);

    expect(result.truncated).toBe(false);
    expect(result.hits.map((hit) => hit.sid)).toEqual([SID]);
  });
});
