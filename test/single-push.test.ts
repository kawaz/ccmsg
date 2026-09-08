import { describe, expect, test } from "bun:test";
import { Glob } from "bun";

/** M5: one push path, and one suppression inside it (daemon-v2 §1.1 / §11.3).
 *
 * topics.test.ts covers the behaviour of the mechanism. This covers the shape,
 * which behaviour cannot see: a second place that builds a topic frame, or a
 * second value comparison deciding whether to push, would agree with the
 * mechanism in every test and still be the "this topic has its own suppression"
 * the design set out to make impossible. */
const TOPIC_FRAME = /\bev:\s*"topic"/;
const VALUE_COMPARISON = /JSON\.stringify\([^)]*\)\s*[=!]==|[=!]==\s*JSON\.stringify\(/;

const SRC = new URL("../src/", import.meta.url).pathname;
const MECHANISM = "topics/";

async function offendersIn(path: string, pattern: RegExp): Promise<string[]> {
  const source = await Bun.file(SRC + path).text();
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => !line.startsWith("*") && !line.startsWith("//"))
    .filter((line) => pattern.test(line));
}

describe("nothing pushes a topic frame outside the topic mechanism (M5)", () => {
  const files = [...new Glob("**/*.ts").scanSync(SRC)];

  test("the scan covers the mechanism it is meant to protect", () => {
    expect(files.some((path) => path.startsWith(MECHANISM))).toBe(true);
  });

  test("the mechanism is where a topic frame is built", async () => {
    const builders: string[] = [];
    for (const path of files) {
      if ((await offendersIn(path, TOPIC_FRAME)).length > 0) builders.push(path);
    }
    expect(builders).toEqual(["topics/topics.ts"]);
  });

  test("no code serializes a value to decide whether to send it", async () => {
    const comparers: string[] = [];
    for (const path of files) {
      if ((await offendersIn(path, VALUE_COMPARISON)).length > 0) comparers.push(path);
    }
    // Not even inside the mechanism: its one comparison is against the form it
    // stored when it last pushed, which is why there is a stored form at all.
    expect(comparers).toEqual([]);
  });

  test("serialization is framing, that suppression, and what is written to disk", async () => {
    const serializers: string[] = [];
    for (const path of files) {
      if ((await offendersIn(path, /JSON\.stringify\(/)).length > 0) serializers.push(path);
    }
    // Framing turns a frame into a line, the mechanism turns a value into the
    // form it compares, and persistence turns one of the three things of §3.6
    // into its file. Another comparison of a value against the last one would
    // be a second answer to "is this new"; a writer is not one, which is why
    // this list is by file and the case above is by shape.
    expect(serializers.sort()).toEqual([
      "messaging/inbox.ts",
      "sessions/last-live.ts",
      "topics/topics.ts",
      "transport/conn.ts",
    ]);
  });
});
