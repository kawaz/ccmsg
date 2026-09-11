import { describe, expect, test } from "bun:test";
import { TranscriptItem, validationErrors } from "@ccmsg/protocol";
import { ConfigError, MERGE_RULES, parseConfig, settingsFor } from "../src/instance/config.ts";
import {
  classify,
  fields,
  type Item,
  ledger,
  located,
  select,
  selection,
} from "../src/transcript/items/index.ts";

/** Lines in the harness's own spelling. Every structure here was read off a
 * real transcript; every word in it was made up, because what is being tested
 * is the shape of the file and never what was said in one. */
function lines(...rows: Record<string, unknown>[]) {
  return located(rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
}

/** An item as a case that is not about classification needs one: what the case
 * states, over the base fields a classification would have filled in. The one
 * place a value is called an item without having been read out of a file. */
function stub(over: Record<string, unknown>): Item {
  return {
    id: `${String(over["uuid"])}:0`,
    source: { offset: 0, bytes: 1 },
    ...over,
  } as unknown as Item;
}

/** An item's fields, read past the end of an array. */
function of(item: Item | undefined): Record<string, unknown> {
  return item === undefined ? {} : fields(item);
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
    expect(of(call)["role"]).toBe("use");
    expect(of(answer)["role"]).toBe("result");
    // Turns stood between them and each kept its own instant, which is the
    // whole reason they are not folded into one item.
    expect(of(call)["result_item"]).toBe(answer?.id ?? "");
    expect(of(answer)["parent_item"]).toBe(call?.id ?? "");
    expect(of(answer)["stdout"]).toBe("3\n");
    // Both sides also carry the key the harness paired them with, which is
    // what ties them together for a reader that has only one of the two.
    expect(of(call)["tool_use_id"]).toBe("t1");
    expect(of(answer)["parent_tool_use_id"]).toBe("t1");
  });

  test("a call that has not come back names no result", () => {
    const items = classify(
      lines(
        answered("a1", [
          { type: "tool_use", id: "t1", name: "Monitor", input: { description: "watch ci" } },
        ]),
      ),
    );
    expect(of(items[0])["result_item"]).toBeUndefined();
  });

  test("an agent that was waited on answers in the call's own result", () => {
    const items = classify(
      lines(
        answered("a1", [
          {
            type: "tool_use",
            id: "t1",
            name: "Agent",
            input: { prompt: "count the lines", subagent_type: "worker" },
          },
        ]),
        said("u1", [{ type: "tool_result", tool_use_id: "t1" }], {
          toolUseResult: {
            agentId: "acounter-9f",
            agentType: "worker",
            status: "completed",
            content: [{ type: "text", text: "there were three" }],
            totalDurationMs: 4000,
          },
        }),
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
    expect(of(reply)["text"]).toBe("there were three");
    expect(of(reply)["duration_ms"]).toBe(4000);
    expect(of(reply)["parent_item"]).toBe(brief?.id ?? "");
    expect(of(brief)["result_item"]).toBe(reply?.id ?? "");
    // The exchange seen as a message carries the harness's key too: the brief
    // is a call and what came back names the call it answers.
    expect(of(brief)["tool_use_id"]).toBe("t1");
    expect(of(reply)["parent_tool_use_id"]).toBe("t1");
  });

  test("an agent started in the background answers much later, and the launch is not an answer", () => {
    const launch = [
      answered("a1", [
        { type: "tool_use", id: "t1", name: "Agent", input: { prompt: "count the lines" } },
      ]),
      // What comes straight back says only that it was launched. Reading that
      // as an answer of no words would claim the agent had finished.
      said("u1", [{ type: "tool_result", tool_use_id: "t1" }], {
        toolUseResult: {
          agentId: "acounter-9f",
          isAsync: true,
          status: "async_launched",
          outputFile: "/tmp/whatever",
        },
      }),
    ];
    const waiting = classify(lines(...launch));
    expect(typesOf(waiting)).toEqual(["tool:Agent", "message:sub:out", "tool:Agent"]);
    expect(of(only(waiting, "message:sub:out"))["result_item"]).toBeUndefined();

    const items = classify(
      lines(
        ...launch,
        answered("a2", [{ type: "text", text: "meanwhile, something else" }]),
        said(
          "u2",
          "<task-notification>\n<task-id>acounter-9f</task-id>\n<tool-use-id>t1</tool-use-id>\n<status>completed</status>\n<result>there were three</result>\n</task-notification>",
          { origin: { kind: "task-notification" } },
        ),
      ),
    );
    const brief = only(items, "message:sub:out");
    const reply = only(items, "message:sub:in");
    // Turns fell between them, and the brief still names what came back.
    expect(of(brief)["result_item"]).toBe(reply?.id ?? "");
    expect(of(reply)["parent_item"]).toBe(brief?.id ?? "");
    expect(of(reply)["text"]).toBe("there were three");
    expect(of(reply)["agent_id"]).toBe("acounter-9f");
  });

  test("Task is the older name for the tool that starts an agent, and reads the same", () => {
    const items = classify(
      lines(
        answered("a1", [
          { type: "tool_use", id: "t1", name: "Task", input: { prompt: "count the lines" } },
        ]),
        said("u1", [{ type: "tool_result", tool_use_id: "t1" }], {
          toolUseResult: {
            agentId: "acounter-9f",
            status: "completed",
            content: [{ type: "text", text: "there were three" }],
          },
        }),
      ),
    );
    // Two of the harness's names for one thing arrive under one type: the same
    // item under two names would be in the vocabulary twice, and a selection
    // asking for the tool that starts an agent would have to know which
    // spelling this transcript happened to use.
    expect(typesOf(items)).toEqual([
      "tool:Agent",
      "message:sub:out",
      "tool:Agent",
      "message:sub:in",
    ]);
    // The spelling the record used stays on the call, for a reader matching
    // what it sees against what it ran.
    expect(of(items[0])["harness_name"]).toBe("Task");
    expect(of(only(items, "message:sub:out"))["prompt"]).toBe("count the lines");
    expect(of(only(items, "message:sub:in"))["text"]).toBe("there were three");
    for (const item of items) {
      expect([item.type, validationErrors(TranscriptItem, item)]).toEqual([item.type, []]);
    }
  });

  test("a name makes an agent a teammate, and its run ending answers the call that started it", () => {
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
      "message:team:out",
      "tool:Agent",
      "message:team:in",
    ]);
    const brief = only(items, "message:team:out");
    const reply = only(items, "message:team:in");
    expect(of(brief)["to"]).toBe("counter");
    expect(of(brief)["text"]).toBe("count the lines");
    // The id is not known until the agent has started, so the message that
    // asked for it learns its own id from the answer.
    expect(of(brief)["agent_id"]).toBe("acounter-9f");
    expect(of(brief)["result_item"]).toBe(reply?.id ?? "");
    expect(of(reply)["parent_item"]).toBe(brief?.id ?? "");
    expect(of(reply)["text"]).toBe("there were three");
    expect(of(reply)["status"]).toBe("completed");
    for (const item of items) {
      expect([item.type, validationErrors(TranscriptItem, item)]).toEqual([item.type, []]);
    }
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
    expect(of(items[0])["task_id"]).toBe("b6mm");
    expect(of(items[0])["event"]).toBe("a line appeared");
  });

  test("another session's message is told from a person's by the envelope it arrives in", () => {
    const items = classify(
      lines(
        said("u1", "where is the needle"),
        said(
          "u2",
          'a note:\n<cross-session-message from="9f2c1ab4" mid="m-7781">hello</cross-session-message>',
        ),
      ),
    );
    expect(typesOf(items)).toEqual(["message:user:in", "message:session:in"]);
    expect(of(items[1])["from"]).toBe("9f2c1ab4");
    expect(of(items[1])["msg_id"]).toBe("m-7781");
  });

  test("who wrote decides whether an envelope is the one above or one alongside", () => {
    const items = classify(
      lines(
        said("u1", "start"),
        said("u2", '<teammate-message teammate_id="a-worker">hello</teammate-message>'),
        said("u3", '<teammate-message teammate_id="team-lead">carry on</teammate-message>'),
      ),
    );
    // A teammate writes under its own name and what it sends is a message of
    // its own; a lead is the one above wherever the subject stands.
    expect(typesOf(items)).toEqual(["message:user:in", "message:team:in", "message:parent:in"]);
    expect(of(items[1])["from"]).toBe("a-worker");
    expect(of(items[2])["from"]).toBe("team-lead");
    for (const item of items) expect(validationErrors(TranscriptItem, item)).toEqual([]);
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
    expect(of(items[0])["args"]).toBe("and continue");
    // The output of a slash command is filed on its own line, which says what
    // came out and not what was run.
    expect(of(items[1])["command"]).toBe("/clear");
    expect(of(items[1])["stdout"]).toBe("done");
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
    expect(of(items[0])["hook_name"]).toBe("PreToolUse:Bash");
    expect(of(items[0])["outcome"]).toBe("additionalContext");
    expect(of(items[0])["tool_use_id"]).toBe("t1");
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
    expect(of(items[0])["outcome"]).toBe("output");
    expect(of(items[0])["exit_code"]).toBe(0);
    expect(of(items[0])["duration_ms"]).toBe(12);
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
    expect(of(items[0])["attachment"]).toEqual({
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
    expect(of(items[0])["input"]).toEqual({ dial: 3 });
    expect(of(items[1])["result"]).toEqual({ text: "it turned" });
  });

  test("a record that fits nothing is still an item", () => {
    const items = classify(
      lines({ type: "who-knows", uuid: "z1", timestamp: "2026-09-01T00:00:00.000Z" }),
    );
    expect(items[0]?.type).toBe("system:unknown");
  });

  test("a record the harness left without an id is read from where it stands", () => {
    const items = classify(
      lines(
        { type: "who-knows", timestamp: "2026-09-01T00:00:00.000Z" },
        said("u1", "and then this"),
      ),
    );
    // A line that vanished quietly is the one failure a dump cannot be read
    // around, so the missing id is stood in for rather than being a reason to
    // drop the record.
    expect(typesOf(items)).toEqual(["system:unknown", "message:user:in"]);
    expect(items[0]?.uuid).toBe("@0");
    expect(items[0]?.id).toBe("@0:0");
    // Stood in for by the address, which is the item's own too, so the two
    // never say different things about where the record is.
    expect(items[0]?.source.offset).toBe(0);
    expect(validationErrors(TranscriptItem, items[0])).toEqual([]);
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
    expect(
      classify(located(`{ half a rec\n\n${JSON.stringify(said("u1", "hello"))}\n`)),
    ).toHaveLength(1);
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
    // Not `message:user`: what is at the other end of an agent's file is
    // whoever started it, and naming that `user` would have a reader take a
    // machine for a person. The names are the same wherever the subject
    // stands, which is what lets one preset be carried down a chain.
    expect(typesOf(items)).toEqual(["message:parent:in", "message:parent:out"]);
    expect(of(items[0])["from"]).toBe("team-lead");
    // The answer is prose with no call behind it — the one message an agent is
    // certain to send, and the reason `parent:out` is not a call alone.
    expect(of(items[1])["role"]).toBeUndefined();
    for (const item of items) expect(validationErrors(TranscriptItem, item)).toEqual([]);
  });

  test("an agent briefed without an envelope is still being told, not spoken to", () => {
    // A throwaway agent's brief arrives as the bare words it was started with.
    // Whether an envelope was around it says who wrote, not what it is.
    const items = classify(
      lines(
        said("w1", "count the lines", { parentUuid: null, isSidechain: true }),
        answered("w2", [{ type: "text", text: "there were three" }], { parentUuid: "w1" }),
      ),
    );
    expect(typesOf(items)).toEqual(["message:parent:in", "message:parent:out"]);
    expect(of(items[0])["from"]).toBeUndefined();
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

  test("writing to an agent is one direction, not a call waiting to come back", () => {
    const items = classify(
      lines(
        answered("a1", [
          {
            type: "tool_use",
            id: "t1",
            name: "SendMessage",
            input: { to: "counter", message: "carry on" },
          },
        ]),
      ),
    );
    const brief = only(items, "message:team:out");
    expect(of(brief)["text"]).toBe("carry on");
    expect(of(brief)["to"]).toBe("counter");
    // What the agent says back arrives under nothing that names this, so the
    // brief says it is waiting for nothing rather than looking unanswered.
    expect(of(brief)["one_way"]).toBe(true);
    expect(of(brief)["result_item"]).toBeUndefined();
    // The mark is the reader's own note about an item the contract already
    // names; it travels beside the fields the contract states, not instead of
    // them.
    expect(validationErrors(TranscriptItem, brief)).toEqual([]);
  });

  test("the name a message is addressed to decides which correspondence it is", () => {
    const items = classify(
      lines(
        answered("a1", [
          {
            type: "tool_use",
            id: "t1",
            name: "SendMessage",
            input: { to: "team-lead", message: "done", summary: "report" },
          },
          {
            type: "tool_use",
            id: "t2",
            name: "SendMessage",
            input: { to: "main", message: "also done" },
          },
        ]),
      ),
    );
    // `main` and `team-lead` are the harness's names for the one above; every
    // other name is somebody standing alongside.
    expect(typesOf(items)).toEqual([
      "tool:SendMessage",
      "message:parent:out",
      "tool:SendMessage",
      "message:parent:out",
    ]);
    const reported = items[1];
    expect(of(reported)["to"]).toBe("team-lead");
    expect(of(reported)["text"]).toBe("done");
    expect(of(reported)["summary"]).toBe("report");
    expect(of(reported)["tool_use_id"]).toBe("t1");
    for (const item of items) expect(validationErrors(TranscriptItem, item)).toEqual([]);
  });

  test("addressing a session by its id is a message to that session, not to an agent", () => {
    const items = classify(
      lines(
        answered("a1", [
          {
            type: "tool_use",
            id: "t1",
            name: "SendMessage",
            input: { to: "11111111-2222-3333-4444-555555555555", message: "over to you" },
          },
        ]),
      ),
    );
    expect(typesOf(items)).toEqual(["tool:SendMessage", "message:session:out"]);
    expect(of(only(items, "message:session:out"))["one_way"]).toBeUndefined();
  });

  test("an answer to a call this reading never saw keeps the key it is joined by", () => {
    // What a reading that starts part-way down a file meets: the seed of a
    // topic begins at the end of the file, and a transcript resumed from
    // another one has its calls in the file before it.
    const items = classify(
      lines(
        said("u1", [{ type: "tool_result", tool_use_id: "t-elsewhere" }], {
          toolUseResult: { stdout: "3\n" },
        }),
      ),
    );
    // The record never says which tool was called, so the type is the reserved
    // name rather than a guess, and what came back is stated as a result and
    // not as a record nobody could read.
    expect(typesOf(items)).toEqual(["tool:unknown"]);
    expect(of(items[0])["role"]).toBe("result");
    expect(of(items[0])["parent_tool_use_id"]).toBe("t-elsewhere");
    expect(of(items[0])["result"]).toEqual({ stdout: "3\n" });
    expect(of(items[0])["parent_item"]).toBeUndefined();
    expect(validationErrors(TranscriptItem, items[0])).toEqual([]);
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
        // The exchanges with another mind, which are a call and a message at
        // once: an agent that was started and answered, and a line written to
        // one that is answered nowhere this file names.
        answered("a2", [
          {
            type: "tool_use",
            id: "t4",
            name: "Agent",
            input: { prompt: "count them again", subagent_type: "worker" },
          },
          {
            type: "tool_use",
            id: "t5",
            name: "SendMessage",
            input: { to: "counter", message: "carry on" },
          },
        ]),
        said("u5", [{ type: "tool_result", tool_use_id: "t4" }], {
          toolUseResult: {
            agentId: "acounter-9f",
            status: "completed",
            content: [{ type: "text", text: "three again" }],
          },
        }),
        said("u6", [{ type: "tool_result", tool_use_id: "t5" }], { toolUseResult: "sent" }),
      ),
    );
    for (const item of items) {
      expect([item.type, validationErrors(TranscriptItem, item)]).toEqual([item.type, []]);
    }
  });
});

describe("selecting which items a dump keeps", () => {
  const ITEMS: Item[] = [
    stub({ uuid: "1", type: "message:user:in", at: 1 }),
    stub({ uuid: "2", type: "message:user:out", at: 2 }),
    stub({ uuid: "3", type: "thinking", at: 3 }),
    stub({ uuid: "4", type: "tool:Bash", at: 4 }),
    stub({ uuid: "5", type: "tool:Read", at: 5 }),
    stub({ uuid: "6", type: "system:attachment:date", at: 6 }),
    stub({ uuid: "7", type: "hook:PreToolUse", at: 7 }),
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
      stub({ uuid: "1", type: "message:sub:out", at: 1 }),
      stub({ uuid: "2", type: "tool:Agent", at: 2 }),
      stub({ uuid: "3", type: "tool:Bash", at: 3 }),
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
      stub({ uuid: "1", type: "message:sub:out", at: 1, agent_id: "a9", name: "counter" }),
      stub({ uuid: "2", type: "tool:Agent", at: 2, agent_id: "a9", status: "running" }),
      stub({
        uuid: "3",
        type: "message:sub:in",
        at: 3,
        agent_id: "a9",
        status: "done",
        duration_ms: 40,
      }),
    ]);
    expect(found).toEqual([
      { kind: "agent", id: "a9", label: "counter", status: "done", duration_ms: 40 },
    ]);
  });

  test("each kind of id is gathered under what it names", () => {
    const found = ledger([
      stub({
        uuid: "1",
        type: "tool:Monitor",
        at: 1,
        tool_use_id: "t1",
        task_id: "b6",
        description: "watch ci",
      }),
      stub({ uuid: "2", type: "message:session:in", at: 2, from: "9f2c1ab4", msg_id: "m-7781" }),
      stub({ uuid: "3", type: "tool:CronCreate", at: 3, tool_use_id: "t2", cron_id: "c1" }),
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
