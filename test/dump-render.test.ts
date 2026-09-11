// Times are drawn in the reader's own zone, so the run fixes one: what is
// under test is which words a type is drawn with, not where the machine is.
process.env.TZ = "UTC";

import { describe, expect, test } from "bun:test";
import type { DumpIdEntry, SessionDumpFile } from "@ccmsg/protocol";
import { dumpArgs } from "../src/cli.ts";
import { document, type Item } from "../src/transcript/items/index.ts";

const SID = "11111111-2222-3333-4444-555555555555";

/** An instant a heading shows as `00:01:02`, so the clock in an expectation is
 * a fact about the drawing rather than about when the test ran. */
const AT = Date.UTC(2026, 8, 1, 0, 1, 2);

function item(uuid: string, type: string, fields: Record<string, unknown> = {}): Item {
  return {
    id: `${uuid}:0`,
    uuid,
    source: { offset: 0, bytes: 1 },
    type,
    at: AT,
    ...fields,
  } as unknown as Item;
}

function file(items: readonly Item[], ids: readonly DumpIdEntry[] = []): SessionDumpFile {
  return {
    sid: SID,
    written_at: AT,
    types: ["message", "tool"],
    items: items as unknown as SessionDumpFile["items"],
    ids: [...ids],
  };
}

/** Only what was drawn for the items, so an expectation is the fragment and
 * not the document around it. */
function drawn(...items: Item[]): string {
  const whole = document(file(items));
  const body = whole.slice(whole.indexOf("## items\n") + "## items\n".length);
  return body.slice(0, body.indexOf("## ids")).trim();
}

describe("drawing one item of each type", () => {
  test("what was said is the body, kept as it was written", () => {
    expect(
      drawn(item("3f9a21c4", "message:user:in", { text: "型を整理して。\n二行目。", turn: 1 })),
    ).toBe(`[3f9a21c4:0] message:user:in  00:01:02 turn 1
  型を整理して。
  二行目。`);
  });

  test("a person operating the harness is one line, naming what happened", () => {
    expect(drawn(item("4d1e8f90", "notice:slash", { command: "pre-compact" }))).toBe(
      "[4d1e8f90:0] notice:slash  /pre-compact  00:01:02",
    );
  });

  test("a hook says its full name, what it did, and what it injected", () => {
    expect(
      drawn(
        item("92e6d4f5", "hook:PreToolUse", {
          hook_name: "PreToolUse:Bash",
          outcome: "additionalContext",
          tool_use_id: "toolu_01Ne9BDS",
          content: "read コマンドを使うこと。",
        }),
      ),
    )
      .toBe(`[92e6d4f5:0] hook:PreToolUse  PreToolUse:Bash  additionalContext  tool=toolu_01Ne9BDS  00:01:02
  read コマンドを使うこと。`);
  });

  test("a todo list is its items, one per line", () => {
    expect(
      drawn(
        item("3c9f5db6", "tool:TodoWrite", {
          role: "use",
          tool_use_id: "t9",
          todos: [
            { content: "型の体系を決める", status: "done" },
            { content: "表示を書く", status: "doing" },
          ],
        }),
      ),
    ).toBe(`[3c9f5db6:0] tool:TodoWrite  2 items  (未着)  00:01:02
  done   型の体系を決める
  doing  表示を書く`);
  });

  test("a tool nobody wrote a drawing for still arrives, carrying its call", () => {
    // Fields sharpen how a tool reads; they never decide whether it is kept.
    expect(
      drawn(
        item("aa11bb22", "tool:Newcomer", {
          role: "use",
          tool_use_id: "t1",
          input: { where: "somewhere", how: { deep: 1 } },
        }),
      ),
    ).toBe(`[aa11bb22:0] tool:Newcomer  (未着)  00:01:02
  where  somewhere
  how.deep  1`);
  });

  test("an attachment nobody has seen before keeps its own kind", () => {
    expect(
      drawn(
        item("81d5c3e4", "system:attachment:queued_command", { attachment: { command: "/x" } }),
      ),
    ).toBe(`[81d5c3e4:0] system:attachment:queued_command  00:01:02
  command  /x`);
  });
});

describe("a call and what came back", () => {
  const bash = item("07c5e1b8", "tool:Bash", {
    role: "use",
    tool_use_id: "t1",
    command: "wc -l < f",
    description: "行を数える",
    result_item: "18d6f2c9:0",
  });
  const answered = {
    ...item("18d6f2c9", "tool:Bash", {
      role: "result",
      parent_tool_use_id: "t1",
      parent_item: "07c5e1b8:0",
      stdout: "3",
    }),
  } as Item;

  test("touching each other, they are drawn as one thing", () => {
    expect(drawn(bash, answered)).toBe(`[07c5e1b8:0] tool:Bash  行を数える  → 18d6f2c9:0  00:01:02
  $ wc -l < f
  stdout  3`);
  });

  test("apart, the answer is drawn where it arrived and names the call", () => {
    const between = item("ffffffff", "thinking", { text: "待つ" });
    expect(drawn(bash, between, answered))
      .toBe(`[07c5e1b8:0] tool:Bash  行を数える  → 18d6f2c9:0  00:01:02
  $ wc -l < f

[ffffffff:0] thinking  00:01:02
  待つ

[18d6f2c9:0] tool:Bash  ← 07c5e1b8:0  00:01:02
  stdout  3`);
  });

  test("a call with nothing back yet says so rather than looking answered", () => {
    const { result_item: _absent, ...waiting } = bash as Record<string, unknown>;
    expect(drawn(waiting as unknown as Item))
      .toBe(`[07c5e1b8:0] tool:Bash  行を数える  (未着)  00:01:02
  $ wc -l < f`);
  });

  test("an agent's answer is drawn under the brief, however far apart they are", () => {
    const brief = item("b7e41d09", "message:sub:out", {
      role: "use",
      tool_use_id: "t1",
      agent_id: "a471372f2",
      subagent_type: "opus5-worker-high",
      prompt: "docs を書き直す。",
      result_item: "c2d80f16:0",
    });
    const between = item("ffffffff", "thinking", { text: "待つ" });
    const back = item("c2d80f16", "message:sub:in", {
      role: "result",
      parent_item: "b7e41d09:0",
      parent_tool_use_id: "t1",
      agent_id: "a471372f2",
      status: "ok",
      duration_ms: 252_000,
      text: "4 群に整理しました。",
    });
    expect(drawn(brief, between, back))
      .toBe(`[b7e41d09:0] message:sub:out  agent=a471372f2  type=opus5-worker-high  → c2d80f16:0  00:01:02
  docs を書き直す。
  [c2d80f16:0] message:sub:in  agent=a471372f2  status=ok  4m12s  00:01:02
    4 群に整理しました。

[ffffffff:0] thinking  00:01:02
  待つ`);
  });

  test("a teammate's run ends under the call that started it, and its letters stand alone", () => {
    const start = item("c8a2f371", "message:team:out", {
      role: "use",
      tool_use_id: "t9",
      to: "contract-dump-items",
      subagent_type: "opus5-worker-high",
      text: "契約に 2 型を足して。",
      result_item: "d4c1a0b2:0",
    });
    const letter = item("e5b70c93", "message:team:in", {
      from: "contract-dump-items",
      text: "fixtures まで通った。",
    });
    const done = item("d4c1a0b2", "message:team:in", {
      role: "result",
      parent_item: "c8a2f371:0",
      parent_tool_use_id: "t9",
      status: "ok",
      duration_ms: 240_000,
      text: "1.17.0 を切った。",
    });
    // The letter is its own message and stands where it arrived; only the run
    // ending answers anything, and that is drawn under what asked for it.
    expect(drawn(start, letter, done))
      .toBe(`[c8a2f371:0] message:team:out  to=contract-dump-items  type=opus5-worker-high  → d4c1a0b2:0  00:01:02
  契約に 2 型を足して。
  [d4c1a0b2:0] message:team:in  status=ok  4m00s  00:01:02
    1.17.0 を切った。

[e5b70c93:0] message:team:in  from=contract-dump-items  00:01:02
  fixtures まで通った。`);
  });

  test("what the one above said and what was said back to it", () => {
    const told = item("a9f30d15", "message:parent:in", {
      from: "team-lead",
      text: "docs を書き直す。",
    });
    const sent = item("b0e41c26", "message:parent:out", {
      role: "use",
      tool_use_id: "t3",
      to: "main",
      summary: "途中報告",
      text: "preset まで直してよいか",
      one_way: true,
    });
    const answered = item("c1f52d37", "message:parent:out", { text: "整理して揃えた。" });
    // An answer handed back as prose names nobody: no call carries it, and a
    // heading that invented a name would say more than the file does.
    expect(drawn(told, sent, answered))
      .toBe(`[a9f30d15:0] message:parent:in  from=team-lead  00:01:02
  docs を書き直す。

[b0e41c26:0] message:parent:out  to=main  途中報告  (片道)  00:01:02
  preset まで直してよいか

[c1f52d37:0] message:parent:out  00:01:02
  整理して揃えた。`);
  });

  test("two calls in one record are answered each by its own", () => {
    const first = item("r1", "tool:Read", {
      role: "use",
      tool_use_id: "t1",
      file_path: "a.ts",
      result_item: "r2:0",
    });
    const second = item("r1", "tool:Read", {
      role: "use",
      tool_use_id: "t2",
      file_path: "b.ts",
      result_item: "r3:0",
    });
    const back = item("r3", "tool:Read", {
      role: "result",
      parent_tool_use_id: "t2",
      parent_item: "r1:0",
      lines: 12,
    });
    // The answer carries the id the harness pairs calls with, so it lands on
    // the second call rather than on whichever one came first.
    expect(drawn(first, second, back)).toContain("[r1:0] tool:Read  b.ts  → r3:0  12 行");
  });

  test("an answer that never read its call is tied to it by the key the harness paired them with", () => {
    const { parent_item: _unread, ...orphan } = answered as Record<string, unknown>;
    // The call is in front of it here, so what the drawing has to do is find
    // it by the key rather than by a pointer the answer could not carry.
    expect(drawn(bash, orphan as unknown as Item))
      .toBe(`[07c5e1b8:0] tool:Bash  行を数える  → 18d6f2c9:0  00:01:02
  $ wc -l < f
  stdout  3`);
  });

  test("an agent's answer and the tool call beside it are told apart by which side asked", () => {
    // One key, two calls: the harness gives `Agent` a single id, and the brief
    // and the call it stands beside both name it. An answer belongs to the one
    // on its own side of the exchange.
    const call = item("s1", "tool:Agent", {
      role: "use",
      tool_use_id: "t7",
      prompt: "docs を書き直す。",
    });
    const brief = item("s1", "message:sub:out", {
      role: "use",
      tool_use_id: "t7",
      prompt: "docs を書き直す。",
    });
    const back = item("s2", "message:sub:in", {
      role: "result",
      parent_tool_use_id: "t7",
      text: "書き直しました。",
    });
    const page = drawn(call, brief, back);
    // Under the brief, indented as an agent's answer is, and the tool call is
    // left standing with nothing back.
    expect(page).toContain("  [s2:0] message:sub:in  00:01:02");
    expect(page).toContain("[s1:0] tool:Agent  (未着)");
  });
});

describe("the document around the items", () => {
  test("it says what it is a dump of before anything that happened in it", () => {
    const whole = document(file([item("a1", "thinking", { text: "考えた" })]), {
      instance: "inst-1",
      since: "2026-09-01T00:00:00.000Z",
    });
    expect(whole.split("\n").slice(0, 8)).toEqual([
      `# dump ${SID}`,
      "",
      `- 対象: \`${SID}\``,
      "- instance: `inst-1`",
      "- 書き出し: 2026-09-01T00:01:02.000Z",
      "- types: `message` `tool`",
      "- 範囲: since=2026-09-01T00:00:00.000Z",
      "- items: 1",
    ]);
  });

  test("an agent's dump is headed by the agent, which is what it is of", () => {
    const of = { ...file([]), agent_id: "a471372f2" };
    expect(document(of).split("\n")[0]).toBe(`# dump ${SID}/agent-a471372f2`);
  });

  test("the ledger is at the end, which is what a reader descends by", () => {
    const whole = document(
      file(
        [],
        [
          {
            kind: "agent",
            id: "a471372f2",
            label: "dump-kinds",
            status: "ok",
            duration_ms: 252_000,
          },
          { kind: "task", id: "b6mmcr0ax" },
        ],
      ),
    );
    const ids = whole.slice(whole.indexOf("## ids")).trim().split("\n");
    expect(ids).toEqual([
      "## ids",
      "",
      "| kind | id | label | status |",
      "|---|---|---|---|",
      "| agent | `a471372f2` | dump-kinds | ok  4m12s |",
      "| task | `b6mmcr0ax` |  |  |",
    ]);
  });

  test("nothing is cut unless a reader asked for a cut", () => {
    const long = item("a1", "thinking", { text: "あいうえお\nかきくけこ" });
    expect(document(file([long]))).toContain("  かきくけこ");
    const cut = document(file([long]), { max_chars: 5 });
    expect(cut).toContain("  あいうえお");
    expect(cut).not.toContain("かきくけこ");
    expect(cut).toContain("残り");
  });

  test("a dump of nothing is still a document that says what it is", () => {
    const whole = document(file([]));
    expect(whole).toContain("- items: 0");
    expect(whole).toContain("(なし)");
  });
});

describe("what a person typed, as the op's arguments", () => {
  test("a bare sid is the session itself", () => {
    expect(dumpArgs(SID)).toEqual({ sid: SID });
  });

  test("`<sid>/agent-<id>` is split into the two the contract keeps apart", () => {
    expect(dumpArgs(`${SID}/agent-a471372f2`)).toEqual({ sid: SID, agent_id: "a471372f2" });
  });

  test("the selection is a list, and the preset it stands on is named", () => {
    expect(
      dumpArgs(
        SID,
        new Map([
          ["preset", "howto"],
          ["types", "thinking, tool:Bash ,-tool:Read"],
        ]),
      ),
    ).toEqual({ sid: SID, preset: "howto", types: ["thinking", "tool:Bash", "-tool:Read"] });
  });

  test("a bound is read as whichever of the two kinds it was written in", () => {
    // A moment parses as one; a record id does not, so nobody has to say which
    // they are handing over.
    expect(dumpArgs(SID, new Map([["since", "2026-09-01T00:00:00.000Z"]]))).toEqual({
      sid: SID,
      since_at: Date.UTC(2026, 8, 1),
    });
    expect(dumpArgs(SID, new Map([["until", "9f2c1ab4"]]))).toEqual({
      sid: SID,
      until_uuid: "9f2c1ab4",
    });
    expect(dumpArgs(SID, new Map([["since", "1756684800000"]]))).toEqual({
      sid: SID,
      since_at: 1_756_684_800_000,
    });
  });
});
