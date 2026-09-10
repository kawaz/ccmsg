import { describe, expect, test } from "bun:test";
import { TranscriptItem, validationErrors } from "@ccmsg/protocol";
import { ConfigError, MERGE_RULES, parseConfig, settingsFor } from "../src/instance/config.ts";
import { classify, type Item, ledger, select, selection } from "../src/transcript/items/index.ts";

/** Lines in the harness's own spelling. Every structure here was read off a
 * real transcript; every word in it was made up, because what is being tested
 * is the shape of the file and never what was said in one. */
function lines(...rows: Record<string, unknown>[]): string[] {
  return rows.map((row) => JSON.stringify(row));
}

function said(uuid: string, content: unknown, over: Record<string, unknown> = {}) {
  return {
    type: "user",
    uuid,
    timestamp: "2026-09-01T00:00:00.000Z",
    message: { role: "user", content },
    ...over,
  };
}

function answered(uuid: string, blocks: unknown[], over: Record<string, unknown> = {}) {
  return {
    type: "assistant",
    uuid,
    timestamp: "2026-09-01T00:00:01.000Z",
    message: { role: "assistant", content: blocks },
    ...over,
  };
}

/** One element of a selection, as the contract spells it. */
const SELECTOR = /^-?(?:@[A-Za-z0-9][A-Za-z0-9_-]*|[a-z]+(?::[A-Za-z0-9_.-]+)*)$/;

function typesOf(items: readonly Item[]): string[] {
  return items.map((item) => item.type);
}

function only(items: readonly Item[], type: string): Item | undefined {
  return items.find((item) => item.type === type);
}

describe("classifying a transcript", () => {
  test("one assistant record is the thinking, the words and each call it held", () => {
    const items = classify(
      lines(
        answered("a1", [
          { type: "thinking", thinking: "wc will do" },
          { type: "text", text: "counting now" },
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "wc -l < f" } },
        ]),
      ),
    );
    expect(typesOf(items)).toEqual(["thinking", "message:user:out", "tool:Bash"]);
    // Every item the record became carries the record's id, so a bound by
    // record keeps a turn whole rather than cutting inside it.
    expect(items.every((item) => item.uuid === "a1")).toBe(true);
  });

  test("blank thinking is nothing that happened", () => {
    const items = classify(
      lines(
        answered("a1", [
          { type: "thinking", thinking: "  \n " },
          { type: "text", text: "hi" },
        ]),
      ),
    );
    expect(typesOf(items)).toEqual(["message:user:out"]);
  });

  test("a call and its result are two items that point at each other", () => {
    const items = classify(
      lines(
        answered("a1", [
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "wc -l < f" } },
        ]),
        answered("a2", [{ type: "text", text: "still waiting" }]),
        said("u1", [{ type: "tool_result", tool_use_id: "t1" }], {
          toolUseResult: { stdout: "3\n", stderr: "", interrupted: false },
        }),
      ),
    );
    const call = items[0];
    const answer = items[2];
    expect(call?.["role"]).toBe("use");
    expect(answer?.["role"]).toBe("result");
    // Turns stood between them and each kept its own instant, which is the
    // whole reason they are not folded into one item.
    expect(call?.["result_item"]).toBe(answer?.uuid ?? "");
    expect(answer?.["parent_item"]).toBe(call?.uuid ?? "");
    expect(answer?.["stdout"]).toBe("3\n");
  });

  test("a call that has not come back names no result", () => {
    const items = classify(
      lines(
        answered("a1", [
          { type: "tool_use", id: "t1", name: "Monitor", input: { description: "watch ci" } },
        ]),
      ),
    );
    expect(items[0]?.["result_item"]).toBeUndefined();
  });

  test("an agent is both a call and a message, and the answer arrives as a notification", () => {
    const items = classify(
      lines(
        answered("a1", [
          {
            type: "tool_use",
            id: "t1",
            name: "Agent",
            input: { prompt: "count the lines", name: "counter", subagent_type: "worker" },
          },
        ]),
        said("u1", [{ type: "tool_result", tool_use_id: "t1" }], {
          toolUseResult: { agentId: "acounter-9f", status: "running" },
        }),
        said(
          "u2",
          "<task-notification>\n<task-id>acounter-9f</task-id>\n<tool-use-id>t1</tool-use-id>\n<status>completed</status>\n<result>there were three</result>\n</task-notification>",
          { origin: { kind: "task-notification" } },
        ),
      ),
    );
    expect(typesOf(items)).toEqual([
      "tool:Agent",
      "message:sub:out",
      "tool:Agent",
      "message:sub:in",
    ]);
    const brief = only(items, "message:sub:out");
    const reply = only(items, "message:sub:in");
    // The id is not known until the agent has started, so the message that
    // asked for it learns its own id from the answer.
    expect(brief?.["agent_id"]).toBe("acounter-9f");
    expect(brief?.["result_item"]).toBe(reply?.uuid ?? "");
    expect(reply?.["parent_item"]).toBe(brief?.uuid ?? "");
    expect(reply?.["text"]).toBe("there were three");
  });

  test("a notification with no answer in it is the harness reporting a task", () => {
    const items = classify(
      lines(
        said(
          "u1",
          "<task-notification>\n<task-id>b6mm</task-id>\n<summary>a monitor spoke</summary>\n<event>a line appeared</event>\n</task-notification>",
          { origin: { kind: "task-notification" } },
        ),
      ),
    );
    expect(typesOf(items)).toEqual(["system:task"]);
    expect(items[0]?.["task_id"]).toBe("b6mm");
    expect(items[0]?.["event"]).toBe("a line appeared");
  });

  test("another session's message is told from a person's by the envelope it arrives in", () => {
    const items = classify(
      lines(
        said("u1", "where is the needle"),
        said("u2", 'a note:\n<teammate-message teammate_id="a-worker">hello</teammate-message>'),
      ),
    );
    expect(typesOf(items)).toEqual(["message:user:in", "message:session:in"]);
    expect(items[1]?.["from"]).toBe("a-worker");
  });

  test("what a person did to the harness is kept apart from what the harness did on its own", () => {
    const items = classify(
      lines(
        said(
          "u1",
          "<command-name>/clear</command-name>\n<command-args>and continue</command-args>",
        ),
        {
          type: "system",
          uuid: "s1",
          subtype: "local_command",
          content: "<local-command-stdout>done</local-command-stdout>",
          timestamp: "2026-09-01T00:00:02.000Z",
        },
        said("u2", "[Request interrupted by user]"),
        said("u3", "<local-command-caveat>Caveat: ...</local-command-caveat>"),
        said("u4", "a summary of what came before", { isCompactSummary: true }),
        answered("a1", [{ type: "text", text: "" }], { isApiErrorMessage: true }),
      ),
    );
    expect(typesOf(items)).toEqual([
      "notice:slash",
      "notice:slash",
      "notice:interrupt",
      "system:caveat",
      "system:compact",
      "system:api-error",
    ]);
    expect(items[0]?.["args"]).toBe("and continue");
    // The output of a slash command is filed on its own line, which says what
    // came out and not what was run.
    expect(items[1]?.["command"]).toBe("/clear");
    expect(items[1]?.["stdout"]).toBe("done");
  });

  test("a hook is typed by its event, and the matcher stays a field", () => {
    const items = classify(
      lines({
        type: "attachment",
        uuid: "x1",
        timestamp: "2026-09-01T00:00:00.000Z",
        attachment: {
          type: "hook_additional_context",
          hookName: "PreToolUse:Bash",
          toolUseID: "t1",
          content: "read it with the tool instead",
        },
      }),
    );
    // `hook:PreToolUse:Bash` would read as three levels of hierarchy and leave
    // `hook:PreToolUse` selecting nothing.
    expect(items[0]?.type).toBe("hook:PreToolUse");
    expect(items[0]?.["hook_name"]).toBe("PreToolUse:Bash");
    expect(items[0]?.["outcome"]).toBe("additionalContext");
    expect(items[0]?.["tool_use_id"]).toBe("t1");
  });

  test("a hook that ran a command carries what it cost", () => {
    const items = classify(
      lines({
        type: "attachment",
        uuid: "x1",
        timestamp: "2026-09-01T00:00:00.000Z",
        attachment: {
          type: "hook_success",
          hookName: "SessionStart:clear",
          hookEvent: "SessionStart",
          content: "a reminder",
          command: "echo a reminder",
          exitCode: 0,
          stderr: "",
          durationMs: 12,
        },
      }),
    );
    expect(items[0]?.type).toBe("hook:SessionStart");
    expect(items[0]?.["outcome"]).toBe("output");
    expect(items[0]?.["exit_code"]).toBe(0);
    expect(items[0]?.["duration_ms"]).toBe(12);
  });

  test("an attachment nobody has seen arrives under its own name", () => {
    const items = classify(
      lines({
        type: "attachment",
        uuid: "x1",
        timestamp: "2026-09-01T00:00:00.000Z",
        attachment: { type: "something_new", detail: "whatever it holds" },
      }),
    );
    expect(items[0]?.type).toBe("system:attachment:something_new");
    expect(items[0]?.["attachment"]).toEqual({
      type: "something_new",
      detail: "whatever it holds",
    });
  });

  test("a tool nobody wrote fields for still says what it was called with", () => {
    const items = classify(
      lines(
        answered("a1", [{ type: "tool_use", id: "t1", name: "Whatsit", input: { dial: 3 } }]),
        said("u1", [{ type: "tool_result", tool_use_id: "t1" }], { toolUseResult: "it turned" }),
      ),
    );
    expect(typesOf(items)).toEqual(["tool:Whatsit", "tool:Whatsit"]);
    expect(items[0]?.["input"]).toEqual({ dial: 3 });
    expect(items[1]?.["result"]).toEqual({ text: "it turned" });
  });

  test("a record that fits nothing is still an item", () => {
    const items = classify(
      lines({ type: "who-knows", uuid: "z1", timestamp: "2026-09-01T00:00:00.000Z" }),
    );
    expect(items[0]?.type).toBe("system:unknown");
  });

  test("the interface and the session's own bookkeeping are not events", () => {
    const items = classify(
      lines(
        { type: "mode", uuid: "m1" },
        { type: "queue-operation", uuid: "q1" },
        { type: "progress", uuid: "g1" },
        { type: "custom-title", uuid: "c1", customTitle: "a name" },
        { type: "file-history-snapshot", uuid: "f1" },
      ),
    );
    expect(items).toEqual([]);
  });

  test("a line that is not JSON at all is read around", () => {
    expect(classify(["{ half a rec", "", ...lines(said("u1", "hello"))])).toHaveLength(1);
  });

  test("the subject is whoever the file belongs to, so an agent's brief is what it was told", () => {
    const items = classify(
      lines(
        said("w1", '<teammate-message teammate_id="team-lead">count the lines</teammate-message>', {
          parentUuid: null,
          isSidechain: true,
        }),
        answered("w2", [{ type: "text", text: "there were three" }], { parentUuid: "w1" }),
      ),
    );
    // The same two type names a session's own dump uses, read from where this
    // subject stands — which is what lets one preset be carried down a chain.
    expect(typesOf(items)).toEqual(["message:user:in", "message:user:out"]);
  });

  test("turns are counted from where a person spoke", () => {
    const items = classify(
      lines(
        answered("a0", [{ type: "text", text: "before anyone asked" }]),
        said("u1", "first"),
        answered("a1", [{ type: "text", text: "an answer" }]),
        said("u2", "second"),
      ),
    );
    expect(items.map((item) => item.turn)).toEqual([0, 1, 1, 2]);
  });

  test("everything classified passes the contract's own shape", () => {
    const items = classify(
      lines(
        said("u1", "count the lines"),
        answered("a1", [
          { type: "thinking", thinking: "wc will do" },
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "wc -l < f" } },
          {
            type: "tool_use",
            id: "t2",
            name: "Write",
            input: { file_path: "/x", content: "a\nb" },
          },
          {
            type: "tool_use",
            id: "t3",
            name: "TodoWrite",
            input: { todos: [{ content: "do it", status: "pending" }] },
          },
        ]),
        said("u2", [{ type: "tool_result", tool_use_id: "t1" }], {
          toolUseResult: { stdout: "3\n", interrupted: false },
        }),
        said("u3", [{ type: "tool_result", tool_use_id: "t2" }], {
          toolUseResult: { type: "create" },
        }),
        said("u4", [{ type: "tool_result", tool_use_id: "t3", is_error: true }], {
          toolUseResult: "refused",
        }),
      ),
    );
    for (const item of items) {
      expect([item.type, validationErrors(TranscriptItem, item)]).toEqual([item.type, []]);
    }
  });
});

describe("selecting which items a dump keeps", () => {
  const ITEMS: Item[] = [
    { uuid: "1", type: "message:user:in", at: 1 },
    { uuid: "2", type: "message:user:out", at: 2 },
    { uuid: "3", type: "thinking", at: 3 },
    { uuid: "4", type: "tool:Bash", at: 4 },
    { uuid: "5", type: "tool:Read", at: 5 },
    { uuid: "6", type: "system:attachment:date", at: 6 },
    { uuid: "7", type: "hook:PreToolUse", at: 7 },
  ];

  function kept(types: string[] | undefined, presets: Parameters<typeof selection>[1] = []) {
    return typesOf(select(ITEMS, selection(types === undefined ? {} : { types }, presets)).items);
  }

  test("nobody saying keeps everything but the attachments", () => {
    expect(kept(undefined)).toEqual([
      "message:user:in",
      "message:user:out",
      "thinking",
      "tool:Bash",
      "tool:Read",
      "hook:PreToolUse",
    ]);
  });

  test("a prefix reaches everything below it and stops at a segment", () => {
    expect(kept(["tool"])).toEqual(["tool:Bash", "tool:Read"]);
    expect(kept(["message:user"])).toEqual(["message:user:in", "message:user:out"]);
    // `thin` is not a level of `thinking`, so it reaches nothing.
    expect(kept(["thin"])).toEqual([]);
  });

  test("an exclusion reaches what a prefix before it brought in", () => {
    expect(kept(["tool", "-tool:Read"])).toEqual(["tool:Bash"]);
  });

  test("order decides, so the same two elements read the other way say the opposite", () => {
    expect(kept(["-tool:Read", "tool"])).toEqual(["tool:Bash", "tool:Read"]);
  });

  test("a preset is put where it was named, so what follows it still reaches inside", () => {
    const presets = [
      { name: "file", opts: { types: ["tool:Read", "tool:Bash"] } },
      { name: "howto", opts: { types: ["thinking", "@file"] } },
    ];
    expect(kept(["@howto"], presets)).toEqual(["thinking", "tool:Bash", "tool:Read"]);
    expect(kept(["@howto", "-tool:Read"], presets)).toEqual(["thinking", "tool:Bash"]);
  });

  test("a preset is the ground a selection is applied over", () => {
    const presets = [{ name: "file", opts: { types: ["tool:Read"] } }];
    const keep = selection({ preset: presets[0], types: ["thinking"] }, presets);
    expect(typesOf(select(ITEMS, keep).items)).toEqual(["thinking", "tool:Read"]);
  });

  test("the two older flags say in one word what the selection says in its own", () => {
    expect(typesOf(select(ITEMS, selection({ no_thinking: true }, [])).items)).not.toContain(
      "thinking",
    );
    const machinery: Item[] = [
      { uuid: "1", type: "message:sub:out", at: 1 },
      { uuid: "2", type: "tool:Agent", at: 2 },
      { uuid: "3", type: "tool:Bash", at: 3 },
    ];
    expect(typesOf(select(machinery, selection({ no_agent: true }, [])).items)).toEqual([
      "tool:Bash",
    ]);
  });

  test("what was kept is counted by type", () => {
    const { entries } = select(ITEMS, selection({ types: ["tool"] }, []));
    expect(entries).toEqual({ "tool:Bash": 1, "tool:Read": 1 });
  });

  test("the default is stated in the vocabulary a person writes in, not a wildcard", () => {
    // The dump file repeats the selection it was written under, and a reader of
    // that file has only the one vocabulary to read it in.
    for (const element of selection({}, []).elements) {
      expect([element, SELECTOR.test(element)]).toEqual([element, true]);
    }
  });

  test("what the selection came to is what the file will say it was", () => {
    const presets = [
      { name: "file", opts: { types: ["tool:Read", "tool:Bash"] } },
      { name: "howto", opts: { types: ["thinking", "@file"] } },
    ];
    // Presets expanded and exclusions left where they stood, so the file states
    // what it holds without the instance's config having to be read beside it.
    expect(selection({ types: ["@howto", "-tool:Read"] }, presets).elements).toEqual([
      "thinking",
      "tool:Read",
      "tool:Bash",
      "-tool:Read",
    ]);
  });
});

describe("the ledger of ids", () => {
  test("a later sighting of the same id is a later state of it", () => {
    const found = ledger([
      { uuid: "1", type: "message:sub:out", at: 1, agent_id: "a9", name: "counter" },
      { uuid: "2", type: "tool:Agent", at: 2, agent_id: "a9", status: "running" },
      { uuid: "3", type: "message:sub:in", at: 3, agent_id: "a9", status: "done", duration_ms: 40 },
    ]);
    expect(found).toEqual([
      { kind: "agent", id: "a9", label: "counter", status: "done", duration_ms: 40 },
    ]);
  });

  test("each kind of id is gathered under what it names", () => {
    const found = ledger([
      {
        uuid: "1",
        type: "tool:Monitor",
        at: 1,
        tool_use_id: "t1",
        task_id: "b6",
        description: "watch ci",
      },
      { uuid: "2", type: "message:session:in", at: 2, from: "9f2c1ab4", msg_id: "m-7781" },
      { uuid: "3", type: "tool:CronCreate", at: 3, tool_use_id: "t2", cron_id: "c1" },
    ]);
    expect(found.map((entry) => entry.kind)).toEqual([
      "task",
      "tool_use",
      "msg",
      "sid",
      "tool_use",
      "cron",
    ]);
  });
});

describe("presets in the config", () => {
  const FILE = "/nowhere/ccmsg.json";

  test("a selection is read as the operator wrote it", () => {
    const config = parseConfig(FILE, {
      dump: {
        presets: [
          { name: "file", description: "reads and writes", opts: { types: ["tool:Read"] } },
          { name: "howto", opts: { types: ["thinking", "@file", "-tool:Grep"] } },
        ],
      },
    });
    expect(config.dump.presets).toEqual([
      { name: "file", description: "reads and writes", opts: { types: ["tool:Read"] } },
      { name: "howto", opts: { types: ["thinking", "@file", "-tool:Grep"] } },
    ]);
  });

  test("an instance that names none has none", () => {
    expect(parseConfig(FILE, {}).dump).toEqual({ presets: [] });
  });

  test("a reference to a preset nobody configured is refused where it was written", () => {
    expect(() =>
      parseConfig(FILE, { dump: { presets: [{ name: "howto", opts: { types: ["@file"] } }] } }),
    ).toThrow(ConfigError);
  });

  test("presets that reference each other in a cycle are refused, naming the loop", () => {
    // Refused when the file is read rather than at each dump: a cycle found
    // per request is found long after the file that holds it was edited.
    expect(() =>
      parseConfig(FILE, {
        dump: {
          presets: [
            { name: "a", opts: { types: ["@b"] } },
            { name: "b", opts: { types: ["@a"] } },
          ],
        },
      }),
    ).toThrow(/cycle: a -> b -> a/);
  });

  test("a selection element that is not one is refused", () => {
    expect(() =>
      parseConfig(FILE, { dump: { presets: [{ name: "a", opts: { types: ["Tool:Bash"] } }] } }),
    ).toThrow(ConfigError);
  });

  test("two selections may not share a name", () => {
    expect(() =>
      parseConfig(FILE, {
        dump: {
          presets: [
            { name: "a", opts: { types: ["thinking"] } },
            { name: "a", opts: { types: ["tool"] } },
          ],
        },
      }),
    ).toThrow(/repeats a/);
  });

  test("an instance that names its own selections runs with those and not the defaults' as well", () => {
    expect(MERGE_RULES["dump.presets"]).toBe("replace");
    const settings = settingsFor(
      {
        defaults: { dump: { presets: [{ name: "shared", opts: { types: ["thinking"] } }] } },
        instances: [
          {
            dir: "/a",
            settings: { dump: { presets: [{ name: "mine", opts: { types: ["tool"] } }] } },
          },
        ],
      },
      "/a",
    );
    expect(parseConfig(FILE, settings).dump.presets.map((one) => one.name)).toEqual(["mine"]);
  });
});
