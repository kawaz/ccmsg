# dump のアイテム型

dump は transcript の行をそのまま並べるのではなく、**アイテム型**に分類してから型ごとの表示コンポーネントでテキストに落とす。webui の Timeline が行を単位に分けてコンポーネントを割り当てているのと同じ構造を、出力先がテキストになっただけのものとして持つ。

主語は **main セッション**。「誰が誰に」は main から見た `in` / `out` で表す。範囲は時刻または record 位置で切る。

## 1. 型の体系

型名は `:` 区切りの階層。prefix 指定で配下をまとめて選べる (`tool` は `tool:*` 全部、`message:user` は in と out の両方)。

### message — 会話

| 型 | 意味 | jsonl 上の抽出 | webui の単位 | csa |
|---|---|---|---|---|
| `message:user:in` | 人 → main の発言 | `type:"user"` かつ下記 notice のどれでもない行。`content` が string、または text / image ブロックのみの配列 | `UserMessageKind` = `user-prompt` / `slash-command-prompt` | `U` |
| `message:user:out` | main → 人 への応答 | `type:"assistant"` の `content[].type=="text"` | `Segment` = `text` (role: assistant) | `R` |
| `message:sub:out` | main → subagent の指示 | `content[].type=="tool_use"` かつ `name=="Agent"` の `input.prompt` (`description` / `subagent_type` / `name` を添える)、および `name=="SendMessage"` で宛先が subagent のもの | `agent-spawn` / `agent-send` | `A` |
| `message:sub:in` | subagent → main の答え | `origin.kind=="task-notification"` の user 行のうち `<subagent>` と `<result>` を持つもの。全文が要るときは `<sid>/subagents/agent-<agentId>.jsonl` の末尾 assistant text | `task-notification` | `I` |
| `message:session:out` | main → 他セッション | `tool_use` `name=="Bash"` の `command` が `ccmsg post` / `ccmsg reply`、および `name=="SendMessage"` で宛先が sid のもの | `SessionReply` | (なし) |
| `message:session:in` | 他セッション → main | user 行の本文に含まれる `<cross-session-message …>` 封筒。`ccmsg` の直接配送は `<teammate-message …>` の形でも届く | `IncomingMessage` (`extractIncomingMessages`) | `I` |

`message:sub` の in と out は同じ Agent 呼び出しに属するので、`tool_use.id` → `tool_result.tool_use_id` → `toolUseResult.agentId` の鎖で束ねて 1 組として出す (実測でこの鎖は全件つながった)。

### thinking

| 型 | 意味 | jsonl 上の抽出 | webui の単位 | csa |
|---|---|---|---|---|
| `thinking` | main の思考 | `type:"assistant"` の `content[].type=="thinking"`。空白のみは捨てる | `thinking` / `thinking-hidden` | `T` |

### tool — ツール呼び出し

`tool:<ToolName>` の 1 段。呼び出しと結果は別の型にせず **1 アイテムに畳む** (`tool_use.id` と `tool_result.tool_use_id` で対にする)。読み手にとって「何をして何が返ったか」が 1 かたまりであるほうが読めるため。

| 型 | フィールド |
|---|---|
| `tool:Bash` | `{command, description, stdout, stderr, interrupted}` |
| `tool:Read` | `{file_path, offset, limit, bytes}` |
| `tool:Write` / `tool:Edit` | `{file_path, old_string, new_string}` (本文は行数に畳む) |
| `tool:Grep` / `tool:Glob` | `{pattern, path, matches}` |
| `tool:WebFetch` / `tool:WebSearch` | `{url, prompt}` / `{query, results}` |
| `tool:Agent` | `message:sub:out` / `:in` の素材。`tool:Agent` としては起動事実 (`agent_id`, `name`, `subagent_type`, `status`) だけを出す |
| `tool:SendMessage` | `{to, summary, msg_id, routing}` |
| `tool:Monitor` | `{description, command, persistent, taskId, timeoutMs}` |
| `tool:Skill` | `{skill, args, agentId, background, status}` |
| `tool:TodoWrite` | `{todos: [{content, status}]}` |
| `tool:TaskStop` | `{task_id, ok}` |
| `tool:<その他>` | `{input, result}` の汎用形 |

`tool:Bash` に **exit code は無い**。実 transcript の `toolUseResult` は `{interrupted, isImage, noOutputExpected, stderr, stdout}` で、終了コードは記録されていない (稀に `returnCodeInterpretation` が付く)。表示は `interrupted` と `stderr` の有無で代替する。

未知のツールは `tool:<Name>` として汎用形で必ず出る。型を足すのは表示を良くするためで、拾うかどうかの条件ではない。

### notice — harness が差し込んだもの

会話でもツールでもない、セッションを動かした事実。csa が `I` に押し込んでいたものの行き先。

| 型 | 意味 | jsonl 上の抽出 | webui の単位 |
|---|---|---|---|
| `notice:slash` | slash command の起動と出力 | `<command-name>` / `<command-message>` / `<local-command-stdout>`、`type:"system"` の `subtype:"local_command"` | `slash-command-invocation` / `-stdout` |
| `notice:interrupt` | 人による中断 | `[Request interrupted` で始まる user 行 | `user-interrupt-marker` |
| `notice:compact` | 文脈圧縮 | `isCompactSummary:true` の user 行 | (要約行) |
| `notice:api-error` | 応答が返らず打ち切られた | `type:"assistant"` かつ `isApiErrorMessage:true` | `AssistantMessageKind` = `api-error` |
| `notice:hook` | hook が差し込んだ文脈 | `type:"attachment"` の `attachment.type` が `hook_additional_context` / `hook_success` | (fold) |
| `notice:task` | 背景タスク・Monitor のイベント通知 | `origin.kind=="task-notification"` かつ `<event>` を持つもの (`<subagent>` を持つものは `message:sub:in`) | `task-notification` |
| `notice:attachment` | 添付・環境注入 | 上記以外の `type:"attachment"` (`environment` / `date` / `model` / `skill_listing` / `queued_command` …) | (fold) |
| `notice:meta` | 上記に当てはまらない harness 注入 | `isMeta:true` の残り、`system-caveat`、`workflow-resume` | `unknown-meta` |

`type` が `mode` / `permission-mode` / `atis-latch` / `ai-title` / `last-prompt` / `queue-operation` / `cost-state` / `file-history-snapshot` / `file-history-delta` / `bridge-session` の行は UI と状態の記録で、どの型にも落とさない (dump の対象外)。実測では 1 セッション 3,429 行のうち 1,300 行以上がこれで、拾うと本文が埋まる。

### ids は型ではなく台帳

`ids` はアイテム型ではなく、**型付きアイテムが持つ id 属性を集めた台帳**として扱う。id は「その行が何であるか」ではなく「その行をどう指すか」なので、型の並びに入れると同じ実体が 2 回出る。

各アイテムは `uuid` (record id、先頭 8 文字を表示) を常に持ち、型に応じて次を持つ。

| id | 持つ型 | 由来 |
|---|---|---|
| `agent_id` | `message:sub:*`, `tool:Agent` | `toolUseResult.agentId` / `input.name` |
| `task_id` | `notice:task`, `tool:Monitor`, `tool:TaskStop` | `<task-id>` / `toolUseResult.taskId` |
| `tool_use_id` | `tool:*` | `tool_use.id` |
| `msg_id` | `message:session:*`, `tool:SendMessage` | `toolUseResult.msg_id` / 封筒の `mid` |
| `sid` | `message:session:*` | 封筒の `from` / `to` |
| `todo` | `tool:TodoWrite` | 項目本文 |
| `cron_id` | `tool:CronCreate` | 返り値の job id |

台帳は dump の末尾に 1 セクションとして出す。`ids` を選択に書けるが、それは「台帳セクションを出す」という指定であって型の選択ではない。

## 2. 表示コンポーネント

型ごとに 1 つ。すべて `[<uuid8>] <型> <見出し>` の 1 行目を持ち、本文をその下にインデントする。id は見出し行に出す (本文に混ぜると読み飛ばせない)。

### `message:user:in`

```
[3f9a21c4] message:user:in  10:14:02
  dump のアイテム型を整理して。csa の分け方は雑だったので捨てていい。
```

### `message:user:out`

```
[a1c07e55] message:user:out  10:31:40
  型の体系を書き直しました。csa の 1 文字記号は tool 配下に畳んでいます。
```

### `message:sub:out` / `message:sub:in`

Agent 呼び出しの往復を 1 かたまりにし、答えを 1 段インデントで子として置く。

```
[b7e41d09] message:sub:out  agent=a471372f2 type=opus5-worker-high  10:15:11
  docs/design/dump-kinds.md を書き直す。範囲は csa と同じ since / until。
  [c2d80f16] message:sub:in  agent=a471372f2 status=ok 4m12s  10:19:23
    型一覧を 4 群 (message / thinking / tool / notice) に整理しました。
```

### `message:session:in` / `:out`

```
[d8b3e720] message:session:in  from=9f2c1ab4 mid=m-7781  10:22:05
  dump の型、webui の Segment と揃えるつもりなら use と result は分けたほうがいい?
[e4a99c31] message:session:out  to=9f2c1ab4 reply_to=m-7781  10:23:40
  テキストでは畳む。1 かたまりで読めるほうが優先。
```

### `thinking`

```
[f10b6d43] thinking  10:30:58
  ids を型にすると同じ実体が 2 回出る。台帳として分けるほうが素直。
```

### `tool:Bash`

```
[07c5e1b8] tool:Bash  jq でセッションの型を数える
  $ jq -r '.type' session.jsonl | sort | uniq -c
  stdout  1174 assistant / 753 user / 684 queue-operation …
  stderr  (なし)
```

### `tool:Read` / `tool:Grep`

```
[19d7a02f] tool:Read  src/sessions/dump.ts  103 行
[2ab84c71] tool:Grep  pattern=session_dump_write path=src  3 hits
```

### `tool:TodoWrite`

```
[3c9f5db6] tool:TodoWrite  3 items
  done     型の体系を決める
  doing    表示コンポーネントを書く
  todo     preset の例を書く
```

### `notice:*`

1 行に畳む。本文が要るのは `notice:compact` だけ。

```
[4d1e8f90] notice:slash  /pre-compact
[5e2a90b1] notice:interrupt  10:41:02
[6f3ba1c2] notice:api-error  応答が打ち切られた
[70c4b2d3] notice:compact  10:44:19
  (要約本文)
```

### ids 台帳

```
--- ids ---
agent  a471372f2  dump-kinds-design   ok    4m12s
agent  afa5b3007  webui-slice3        running
task   b6mmcr0ax  just watch          running
peer   9f2c1ab4   ccmsg-webui/main
```

## 3. 選択と範囲

### 型の選択

`types` は型名の配列。左から順に適用し、`-` 始まりは除外。

```
["message", "thinking", "tool:Bash"]        message:* 全部 + thinking + Bash だけ
["tool", "-tool:Read", "-tool:Grep"]        ツール全部から読み取り系を落とす
["message:user", "message:sub:in", "ids"]   人との往復 + worker の答え + 台帳
```

除外を持つのは、prefix でまとめて取ってから 1 つ落とす形が実際に要るため (`tool` を取ると `tool:Read` が支配的になる)。除外なしだと `tool` を諦めて 10 個以上を列挙することになる。

無指定は既定 = 平坦な全部入り (`notice:attachment` を除く全型)。

### 範囲

契約が既に持つ 4 つをそのまま使う。`since_at` / `until_at` は時刻、`since_uuid` / `until_uuid` は record 位置 (同一時刻の record が切り口の両側に分かれない)。下限は時刻か record のどちらか一方。

csa の turn 番号 / marker は **採らない**。turn 番号はファイルを読み直すたびに振り直される派生値で、`until_uuid` が同じ役割を安定した名前で果たしている。ただし turn は各アイテムの属性としては出す (見出しの `10:14:02` の隣に置ける)。webui の Timeline も位置は offset と uuid で指す。

## 4. preset

契約には焼かず config の `dump.presets` で operator が定義する。

```json
{
  "dump": {
    "presets": [
      {
        "name": "journal",
        "description": "日記用。人との往復と worker の答え、思考は要点だけ",
        "opts": { "types": ["message:user", "message:sub:in", "thinking"] }
      },
      {
        "name": "handoff",
        "description": "後継セッションへの引き継ぎ。直近の会話と、走っているものの台帳",
        "opts": { "types": ["message", "notice:task", "ids"] }
      },
      {
        "name": "audit",
        "description": "何をしたかの追跡。会話は落としてツールと通知だけ",
        "opts": { "types": ["tool", "notice", "ids"] }
      }
    ]
  }
}
```

一覧は `dump_presets_read` で引く。`daemon add` の初期 config にこの 3 つを例として入れる。

## 5. 契約に足す候補

`SessionDumpWriteArgs`:

- `types: string[]` — 型の選択。無指定は既定。`no_thinking` / `no_agent` は `["-thinking"]` / `["-message:sub", "-tool:Agent"]` で表せるので、この 2 つは `types` に吸収する
- `preset: string` — config の preset 名。`types` と併用したら preset を土台に `types` を後から適用する
- `since_at` / `since_uuid` / `until_at` / `until_uuid` — 既存のまま

`SessionDumpWriteResult`: `path` / `instance` / `bytes` は既存のまま。`entries` は型ごとの内訳 (`{ "message:user:in": 12, "tool:Bash": 301, … }`) に変える。総数だけでは何が入ったか読み手に分からない。

新規 op `dump_presets_read`: config が持つ preset の `{name, description, opts}` の配列を返す。

## 6. kawaz に決めてもらうこと

1. **型一覧の確認** — `message` / `thinking` / `tool` / `notice` の 4 群と、その配下の型名。特に `notice:*` は csa の `I` を分解したもので、この粒度でいいか (もっと粗く `notice` 1 つに畳む案もある)。
2. **`message:sub:in` の本文をどこから取るか** — task-notification の `<result>` (main の jsonl だけで完結、要約済み) か、`subagents/*.jsonl` の末尾 assistant text (全文、別ファイルを読む) か。両方出す選択肢もある。
3. **`no_thinking` / `no_agent` を `types` に吸収してよいか** — 既存の引数を残すと同じことを 2 通りで書けることになる。
