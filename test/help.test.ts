import { describe, expect, test } from "bun:test";
import { main } from "../src/cli.ts";
import { capture } from "./harness.ts";

/** Every level of the tree, as a person reaches it. The leaves are here too:
 * "what does this take" is the same question at every depth, so the answer has
 * to exist at every depth. */
const LEVELS = [
  [],
  ["daemon"],
  ["daemon", "add"],
  ["daemon", "start"],
  ["daemon", "log"],
  ["service"],
  ["service", "log"],
  ["service", "register"],
  ["plugin"],
  ["plugin", "install"],
  ["dump"],
  ["dump", "presets"],
  ["post"],
  ["reply"],
  ["notify"],
  ["stopping"],
  ["hello"],
  ["say"],
];

describe("the help, at every level", () => {
  test("--help answers with text, not JSON, and succeeds", async () => {
    for (const level of LEVELS) {
      const asked = await capture(() => main([...level, "--help"]));
      expect(asked.code).toBe(0);
      expect(asked.err).toBe("");
      expect(() => JSON.parse(asked.out) as unknown).toThrow();
      // The heading names the level reached, so a person deep in the tree can
      // see which command they are reading about.
      expect(asked.out.split("\n")[0]).toStartWith(["ccmsg", ...level].join(" "));
      expect(asked.out).toContain("使い方:");
    }
  });

  test("-h is the same answer as --help", async () => {
    for (const level of LEVELS) {
      const short = await capture(() => main([...level, "-h"]));
      const long = await capture(() => main([...level, "--help"]));
      expect(short.out).toBe(long.out);
    }
  });

  test("a level that leads somewhere answers no arguments with its help", async () => {
    for (const level of [[], ["daemon"], ["service"], ["plugin"]]) {
      const bare = await capture(() => main(level));
      expect(bare.code).toBe(0);
      expect(bare.out).toContain("サブコマンド:");
    }
  });

  test("a command whose arguments are required answers no arguments with its help", async () => {
    const levels = [["daemon", "add"], ["daemon", "start"], ["dump"], ["post"], ["reply"]];
    for (const level of levels) {
      const bare = await capture(() => main(level));
      // Not a refusal in the error shape: nothing was attempted, and what the
      // caller needs is what the command takes.
      expect(bare.code).toBe(2);
      expect(bare.out).toContain("使い方:");
      expect(bare.err).toBe("");
    }
  });

  test("the sections are the ones a person looks for, in order", async () => {
    const daemon = await capture(() => main(["daemon", "--help"]));
    const order = [
      "サブコマンド:",
      "このレベルのオプション:",
      "グローバルオプション:",
      "環境変数:",
    ];
    let at = -1;
    for (const heading of order) {
      const found = daemon.out.indexOf(heading);
      expect(found).toBeGreaterThan(at);
      at = found;
    }
  });

  test("every subcommand the help lists is one the tree accepts", async () => {
    for (const level of [[], ["daemon"], ["service"], ["plugin"]]) {
      const listed = await capture(() => main([...level, "--help"]));
      const block = listed.out.slice(listed.out.indexOf("サブコマンド:")).split("\n").slice(1);
      const names = block
        .slice(0, block.indexOf(""))
        .map((line) => line.trim().split(/\s+/)[0] as string);
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) {
        const asked = await capture(() => main([...level, name as string, "--help"]));
        expect(asked.code).toBe(0);
        expect(asked.out).toContain("使い方:");
      }
    }
  });

  test("a word the tree does not know is a refusal in the error shape", async () => {
    const unknown = await capture(() => main(["nosuchthing"]));
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain("nosuchthing");
    const error = unknown.err.slice(unknown.err.indexOf("{"));
    expect(JSON.parse(error)).toMatchObject({ error: { code: "bad_request" } });
  });
});
