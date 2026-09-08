import { describe, expect, test } from "bun:test";
import { Glob } from "bun";

/** M1: authorization is derived from the op attribute table, so no role is
 * compared by hand (daemon-v2 §1.1 / §11.3).
 *
 * The table sweep in dispatch.test.ts covers the behaviour; this covers the
 * shape, which behaviour cannot see: a hand-written role branch that happens
 * to agree with the table passes every sweep and still is the second place the
 * rule lives. There are no op implementations yet, so the scan is over the
 * dispatch module — the only code that reads a role at all. It widens to the
 * handlers when they arrive. */
const ROLE_LITERAL = /"(?:session|user|instance)"/;
const ROLE_COMPARISON = /\brole\s*[=!]==/;

const SRC = new URL("../src/", import.meta.url).pathname;

describe("no role comparison outside the attribute table (M1)", () => {
  const files = [...new Glob("**/*.ts").scanSync(SRC)];

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
