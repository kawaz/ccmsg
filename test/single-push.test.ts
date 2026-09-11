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
    // Framing turns a frame into a line — on the instance's side of a
    // connection and on the CLI's — the mechanism turns a value into the form
    // it compares, and persistence turns one of the three things of §3.6 into
    // its file, the log included. Another comparison of a value against the
    // last one would be a second answer to "is this new"; a writer is not one,
    // which is why this list is by file and the case above is by shape.
    expect(serializers.sort()).toEqual([
      // The person's authentication: the claims a registration URL is signed
      // over, which the signature is taken of the way a proof's is, and the
      // replicated records written as their file — persistence again, of the
      // third thing of §3.6.
      "auth/auth.ts",
      "auth/records.ts",
      "cli.ts",
      // What a daemon command answers with and what a supervisor logs: both are
      // the CLI's own JSON output, said where the command lives rather than at
      // the point it is printed.
      "daemon/control.ts",
      // The supervisor's own protocol, framed the same way the instance's is:
      // one JSON object per line over a socket, on both sides of it.
      "daemon/link.ts",
      // A log line shown under a label: the record is reassembled with the
      // instance it came from beside its own fields, which is the CLI's output
      // again rather than anything compared against a previous value.
      "daemon/log.ts",
      "daemon/registry.ts",
      "daemon/supervise.ts",
      // Persistence of the one file a person edits: the shared config, written
      // back by `daemon add` and `daemon remove` at the shape it is read in.
      "instance/config.ts",
      "instance/log.ts",
      // The values a person saved, written whole as their namespace's file:
      // persistence again, of the one thing here nothing else holds a copy of.
      "kv/store.ts",
      // The mesh's three: the body of a probe and of a key request, which are
      // HTTP requests to another instance, and the two halves of a proof, whose
      // serialization *is* what gets signed. None is a value pushed to a
      // subscriber, and none is compared against a previous one.
      "mesh/keys.ts",
      "mesh/mesh.ts",
      "mesh/probe.ts",
      // Framing again, on the far side of route (a): the harness's socket takes
      // one JSON object per line, the same as the instance's own connections.
      "messaging/direct.ts",
      "messaging/inbox.ts",
      // Persistence again, of what an install left behind: the plugin's own
      // manifests, and the receipt that says which of them were written and
      // what was run. Both are files an uninstall reads back, and neither is a
      // value pushed to anybody.
      "plugin/codex.ts",
      "plugin/receipt.ts",
      // The one writer whose file is not instance state: a dump is the
      // artifact `session.dump.write` was asked for, written once and never
      // read back, so it neither survives a restart for the instance's sake
      // nor is a value compared against a previous one.
      "sessions/dump.ts",
      // How much of a range one answer carries. A size, not an answer to "is
      // this new": what it decides is where a page ends, and the page is sent
      // either way.
      "sessions/items.ts",
      "sessions/last-live.ts",
      // The mechanism's own two: one turns a value into the form it compares,
      // the other does the same for one element of a topic whose frames carry
      // the rows that changed.
      "topics/elements.ts",
      "topics/topics.ts",
      // Framing once more, towards an upstream rather than a client: the
      // translation helper takes one JSON object per line.
      "translate/translate.ts",
      "transport/conn.ts",
    ]);
  });
});
