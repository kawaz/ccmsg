# dump のアイテム型

dump は transcript の行をそのまま並べるのではなく、**アイテム型**に分類してから型ごとの表示コンポーネントでテキストに落とす。webui の Timeline が行を単位に分けてコンポーネントを割り当てているのと同じ構造を、出力先がテキストになっただけのものとして持つ。

主語は既定で **main セッション**、指定すればその配下の worker 1 体。「誰が誰に」は主語から見た `in` / `out` で表す。範囲は時刻または record 位置で切る。

## 1. 型の体系

型名は `:` 区切りの階層。prefix 指定で配下をまとめて選べる (`tool` は `tool:*` 全部、`message:user` は in と out の両方)。

### message — 会話

| 型 | 意味 | jsonl 上の抽出 | webui の単位 | csa |
|---|---|---|---|---|
| `message:user:in` | 人 → main の発言 | `type:"user"` かつ下記 `notice` / `system` のどれでもない行。`content` が string、または text / image ブロックのみの配列 | `UserMessageKind` = `user-prompt` / `slash-command-prompt` | `U` |
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

未知のツールも「専用表示が無い型も必ず出る」の原則どおり汎用形で出る (後述)。

### notice — 人が harness を操作した

会話でもツールでもない、**人が harness を操作した**事実。csa が `I` に押し込んでいたもののうち、人に由来する分の行き先。

| 型 | 意味 | jsonl 上の抽出 | webui の単位 |
|---|---|---|---|
| `notice:slash` | slash command の起動と出力 | `<command-name>` / `<command-message>` / `<local-command-stdout>`、`type:"system"` の `subtype:"local_command"` | `slash-command-invocation` / `-stdout` |
| `notice:interrupt` | 人による中断 | `[Request interrupted` で始まる user 行 | `user-interrupt-marker` |

`notice` を `system` に吸収せず残すのは、**dump の読み手が最初に知りたいのが「なぜここで話が途切れたか」**だから。中断と slash 起動は人がキーボードを叩いた事実で、会話の断絶を説明する。harness が自分の都合で差し込んだもの (下記 `system:*`) とは、読み飛ばしてよいかどうかが逆になる。

### system — user 行の形をした harness 自身のメッセージ

wire 上は `type:"user"` / `type:"assistant"` / `type:"attachment"` に化けているが、誰の発言でもない harness の報告。

| 型 | 意味 | jsonl 上の抽出 | webui の単位 |
|---|---|---|---|
| `system:compact` | 文脈圧縮の要約 | `isCompactSummary:true` の user 行 | (要約行) |
| `system:api-error` | 応答が返らず打ち切られた | `type:"assistant"` かつ `isApiErrorMessage:true` | `AssistantMessageKind` = `api-error` |
| `system:task` | 背景タスク・Monitor のイベント通知 | `origin.kind=="task-notification"` かつ `<event>` を持つもの (`<subagent>` を持つものは `message:sub:in`) | `task-notification` |
| `system:caveat` | slash command に付く定型注意書き | `<local-command-caveat>` | `system-caveat` |
| `system:resume` | workflow の再開命令 | `Resume the paused workflow by calling: Workflow({` で始まる user 行 | `workflow-resume` |
| `system:attachment:<kind>` | 添付・環境注入 | `type:"attachment"` の `attachment.type` (`environment` / `date` / `model` / `skill_listing` / `queued_command` / `prompt_snapshot` …) をそのまま `<kind>` に採る | (fold) |
| `system:unknown` | 上記に当てはまらない `isMeta:true` の残り | `isMeta:true` | `unknown-meta` |

`system:attachment:<kind>` だけ 3 段なのは、`attachment.type` が harness の追加で増え続ける開いた集合だから。列挙して固定すると、知らない `kind` が来たときに `system:unknown` に落ちて何が来たか分からなくなる。wire の値をそのまま型名の末尾に採れば、未知の添付も名前を保ったまま出る。

### hook — operator が仕込んだコードの出力

`type:"attachment"` のうち `attachment.type` が `hook_additional_context` / `hook_success` のもの。`system:*` と分けるのは、hook が **harness の報告ではなく operator 自身が書いたコードの出力**だから。dump の読み手にとって、自分が仕込んだものが効いているかは harness の内部事情とは別の関心になる。

型は `hook:<hookEvent>` (`hook:SessionStart` / `hook:PreToolUse` / `hook:UserPromptSubmit` …)。フィールドは次のとおり。

| フィールド | 由来 |
|---|---|
| `hook_name` | `hookName`。matcher 付きの完全名 (`PreToolUse:Bash` / `SessionStart:clear`) |
| `outcome` | `additionalContext` (文脈注入) / `output` (stdout をそのまま) / `block` (実行を止めた) |
| `content` | `content`。注入された本文 |
| `command` / `exit_code` / `stderr` / `duration_ms` | `hook_success` のみ持つ |
| `tool_use_id` | `toolUseID`。`PreToolUse` / `PostToolUse` では対象のツール呼び出しを指す |

`hookName` をそのまま型名にしないのは、実際の値が `PreToolUse:Bash` のように **`:` を含む**ため。型名の階層区切りと衝突して `hook:PreToolUse:Bash` が 3 段に見えるが、`Bash` は階層の一段ではなく matcher なので、prefix 選択の意味が壊れる。イベント名までを型にし、matcher はフィールドに置く。

### 専用表示が無い型も必ず出る

型に専用の表示コンポーネントが無い場合、**汎用形で出す**。落とさない。

- `tool:<未知>` → `{input, result}`
- `system:attachment:<未知>` / `system:unknown` → 見出し 1 行 + `attachment` オブジェクトの JSON 要約 (深さ 2、長い値は長さに畳む)
- `hook:<未知のイベント>` → 上記のフィールド表で出せる分だけ

型を足すのは表示を良くするためであって、**拾うかどうかの条件ではない**。分類が知らない形の行が来ても、型名と生の要約は必ず出力に現れる。知らないものが黙って消えるのが、dump にとって最も困る壊れ方になる。

`type` が `mode` / `permission-mode` / `atis-latch` / `ai-title` / `last-prompt` / `queue-operation` / `cost-state` / `file-history-snapshot` / `file-history-delta` / `bridge-session` の行は UI と状態の記録で、どの型にも落とさない (dump の対象外)。実測では 1 セッション 3,429 行のうち 1,300 行以上がこれで、拾うと本文が埋まる。

### ids は型ではなく台帳

`ids` はアイテム型ではなく、**型付きアイテムが持つ id 属性を集めた台帳**として扱う。id は「その行が何であるか」ではなく「その行をどう指すか」なので、型の並びに入れると同じ実体が 2 回出る。

各アイテムは `uuid` (record id、先頭 8 文字を表示) を常に持ち、型に応じて次を持つ。

| id | 持つ型 | 由来 |
|---|---|---|
| `agent_id` | `message:sub:*`, `tool:Agent` | `toolUseResult.agentId` / `input.name` |
| `task_id` | `system:task`, `tool:Monitor`, `tool:TaskStop` | `<task-id>` / `toolUseResult.taskId` |
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

### `notice:*` / `system:*`

1 行に畳む。本文が要るのは `system:compact` だけ。

```
[4d1e8f90] notice:slash  /pre-compact
[5e2a90b1] notice:interrupt  10:41:02
[6f3ba1c2] system:api-error  応答が打ち切られた
[70c4b2d3] system:compact  10:44:19
  (要約本文)
[81d5c3e4] system:attachment:queued_command  /pre-clear
```

### `hook:*`

見出しに完全名と結果の種類、注入された本文を 1 段下げる。

```
[92e6d4f5] hook:PreToolUse  PreToolUse:Bash  additionalContext  tool=toolu_01Ne9BDS
  docs/issue/ の issue を Bash 経由で直接読もうとしている。read コマンドを使うこと。
[a3f7e506] hook:SessionStart  SessionStart:clear  output  exit=0  12ms
  日本語で応答する設定を再確認してください。
```

### ids 台帳

```
--- ids ---
agent  a471372f2  dump-kinds-design   ok    4m12s
agent  afa5b3007  webui-slice3        running
task   b6mmcr0ax  just watch          running
peer   9f2c1ab4   ccmsg-webui/main
```

## 3. 分類の置き場

分類 (jsonl の 1 行 → 型 + フィールド) は **契約 package の subpath に 1 つ置く**。想定は `@ccmsg/protocol/transcript-items`。daemon の dump と webui の Timeline は同じものを import し、**型に専用コンポーネントを当てる**ところだけをそれぞれ持つ。dump はテキストの表示コンポーネント、webui は React コンポーネント。型が増えたら両方に描き方を足す (足すまでは汎用形で出る)。

契約 package に置くのは、型名が `types` 引数と `dump.presets` の config に現れる **wire の語彙**だから。分類の実装と、その結果を選択する引数の schema が離れると、片方だけ増えて名前がずれる。

### webui の現状と移行

webui は今 3 系統を並べていて、階層を持たない。

| 現状 | 何を分類するか | 移行先 |
|---|---|---|
| `UserMessageKind` | `type:"user"` 行 | `message:user:in` / `message:session:in` / `notice:*` / `system:*` |
| `AssistantMessageKind` | `type:"assistant"` 行 | `message:user:out` / `system:api-error` |
| `Segment` | 1 行の中の content ブロック | `thinking` / `tool:*` |

行を分類する 2 つとブロックを分類する 1 つが同じ平面に並んでいるのが、階層を持てない理由になっている。共通の分類はアイテムを **行より細かくブロック単位**で出し (assistant 1 行が `thinking` + `tool:Bash` + `message:user:out` の 3 アイテムになる)、webui 側は今の `ParsedLine` の下にそれを敷く。`UserMessageKind` / `AssistantMessageKind` は共通分類からの導出に置き換わり、`Segment` は「共通アイテム + webui だけの表示都合」の和になる。

webui が `bash-use` と `bash-result` を別 Segment に持つのは残せる。共通分類が返すのは畳んだ 1 アイテム (`tool:Bash`) で、webui はそれを描くときに use と result の 2 ブロックに開く。逆向き (webui の 2 分割を共通分類に持ち上げる) にしないのは、開いた形から畳むには対応付けをもう一度やる必要があり、分類の責務が呼び出し側に漏れるため。**畳んだものを開くのは表示の自由、開いたものを畳むのは分類のやり直し**になる。

## 4. 選択と範囲

### 型の選択

`types` の要素は **型** (prefix 可、`-` 始まりは除外) か **`@<preset 名>`** (合成、後述)。左から順に適用する。

```
["message", "thinking", "tool:Bash"]        message:* 全部 + thinking + Bash だけ
["tool", "-tool:Read", "-tool:Grep"]        ツール全部から読み取り系を落とす
["message:user", "message:sub:in", "ids"]   人との往復 + worker の答え + 台帳
```

除外を持つのは、prefix でまとめて取ってから 1 つ落とす形が実際に要るため (`tool` を取ると `tool:Read` が支配的になる)。除外なしだと `tool` を諦めて 10 個以上を列挙することになる。

無指定は既定 = 平坦な全部入り (`system:attachment` を除く全型)。

### 範囲

契約が既に持つ 4 つをそのまま使う。`since_at` / `until_at` は時刻、`since_uuid` / `until_uuid` は record 位置 (同一時刻の record が切り口の両側に分かれない)。下限は時刻か record のどちらか一方。

csa の turn 番号 / marker は **採らない**。turn 番号はファイルを読み直すたびに振り直される派生値で、`until_uuid` が同じ役割を安定した名前で果たしている。ただし turn は各アイテムの属性としては出す (見出しの `10:14:02` の隣に置ける)。webui の Timeline も位置は offset と uuid で指す。

## 5. 主語の指定

やり方を盗みたい相手が worker のことがある。親の dump に出るのは Agent 呼び出しの指示と返ってきた答えだけで、その worker が実際に何を叩いて何を読んだかは worker 自身の transcript にしかない。dump の対象はセッションだけでなく **worker 1 体**も指せる。

### 対象の記法

```
<sid>                      main セッション (既定)
<sid>/agent-<agentId>      その worker (= <sid>/subagents/agent-<agentId>.jsonl)
```

`agent-` の接頭辞はファイル名の形をそのまま採る。sid と agent id はどちらも不透明な文字列で、区切りを見ただけでどちらがどちらか分かる必要があるため。

### 主語が worker のときの各型

型の定義は変えない。主語が入れ替わることで指すものが移る。

| 型 | 主語が main | 主語が worker |
|---|---|---|
| `message:user:in` | 人 → main の発言 | **親 → worker の指示書** (Agent tool の `input.prompt`。worker の transcript では `parentUuid` が `null` の先頭 user 行) |
| `message:user:out` | main → 人 への応答 | **worker → 親 への回答** (assistant の text。末尾のものが最終回答、途中のものも同型) |
| `message:sub:out` / `:in` | main → subagent とその答え | **worker が呼んだ孫 Agent** とその答え |
| `message:session:*` | main と他セッションの往復 | worker が `ccmsg` を叩いた場合のみ現れる |
| `thinking` / `tool:*` / `notice:*` | main のもの | **worker のもの** |

`ids` 台帳も主語相対になる。worker を主語にした台帳の `agent_id` はその worker が起動した孫であって、自分自身ではない。

worker の transcript は 1 ファイルで完結し、全行が `isSidechain: true` で同じ `agentId` を持つ (実測 3 セッション 201 件で全件)。親の main JSONL 側に同じ turn が重複することはないので、主語を worker にした dump は親の dump と行を共有しない。

### 掘り下げの導線

1. 親を `howto` で見る (`{"sid": "<sid>", "preset": "howto"}`)
2. `ids` 台帳の `agent_id` から、うまくやっていそうな worker を選ぶ
3. その worker を主語にして同じ preset で掘る (`{"sid": "<sid>", "agent_id": "a471372f2", "preset": "howto"}`)
4. 孫がいれば台帳にまた `agent_id` が出るので、同じ手順を繰り返す

同じ preset がそのまま使えるのは、型が主語相対に定義されているため。「親の指示を読んで、思考と Bash とファイル操作を追う」という関心の切り方が、どの階層でも同じ名前で通る。

## 6. preset

契約には焼かず config の `dump.presets` で operator が定義する。

```json
{
  "dump": {
    "presets": [
      {
        "name": "file",
        "description": "ファイル操作。読み書きと探索をひとまとめに",
        "opts": { "types": ["tool:Read", "tool:Write", "tool:Edit", "tool:Glob", "tool:Grep"] }
      },
      {
        "name": "howto",
        "description": "調査のノウハウだけ。何を考えて何を叩いて何を読み書きしたか",
        "opts": { "types": ["thinking", "message:user", "message:sub", "tool:Bash", "@file"] }
      },
      {
        "name": "journal",
        "description": "日記用。人との往復と worker の答え、思考は要点だけ",
        "opts": { "types": ["message:user", "message:sub:in", "thinking"] }
      },
      {
        "name": "handoff",
        "description": "後継セッションへの引き継ぎ。直近の会話と、走っているものの台帳",
        "opts": { "types": ["message", "system:task", "ids"] }
      },
      {
        "name": "audit",
        "description": "何をしたかの追跡。会話は落として操作と通知だけ",
        "opts": { "types": ["@file", "tool:Bash", "notice", "ids"] }
      }
    ]
  }
}
```

一覧は `dump_presets_read` で引く。`daemon add` の初期 config にこの 5 つを例として入れる。

### preset の合成

`types` の要素として `@<preset 名>` を書くと、その preset の `types` がその位置に展開される。ファイル操作のように「複数の型をいつも一緒に選ぶ」まとまりは、型名の側で `tool:file` のような中間階層を作るのではなく、preset の参照で表す。

型名は行の実体に 1 対 1 で対応させる (`tool:Read` は Read ツールの呼び出しそのもの)。`Read` / `Write` / `Edit` を「ファイル操作」として束ねるのは **その時の関心の切り方** であって行の実体ではないので、束ね方が増えるたびに型名が増えるのは筋が悪い。関心の切り方は operator が config で名付けて足せる側 (preset) に置く。

- 展開は再帰する (`@howto` が `@file` を含み、`@file` がさらに別の preset を参照してよい)
- 循環参照は **config の検証で拒否**する (dump のたびに展開して落ちるのでは遅い)。存在しない preset 名も同様
- 展開後に左から順に適用するので、除外は展開結果にも効く (`["@file", "-tool:Grep"]` はファイル操作から Grep だけを落とす)

```
["@howto"]                    調査のノウハウ一式
["@file", "-tool:Grep"]       ファイル操作から探索を落とす
["@journal", "system:task"]   日記に背景タスクの通知を足す
```

## 7. 契約に足す候補

`SessionDumpWriteArgs`:

- `agent_id: string` — 主語をこの worker にする。無指定なら main セッション。`sid` と合成した 1 本の文字列 (`<sid>/agent-<id>`) にはしない: `sid` は既に `Sid` として検証されていて、合成すると検証が効かなくなり、パースの責務が daemon 側に増える。人が打つ `<sid>/agent-<id>` の表記は CLI が区切って 2 つの引数に割る
- `types: string[]` — 型の選択。要素は型 (prefix 可、`-` で除外) か `@<preset 名>` (config の preset をその位置に展開、再帰可、循環は config 検証で拒否)。無指定は既定。`no_thinking` / `no_agent` は `["-thinking"]` / `["-message:sub", "-tool:Agent"]` で表せるので、この 2 つは `types` に吸収する
- `preset: string` — config の preset 名。`types` と併用したら preset を土台に `types` を後から適用する
- `since_at` / `since_uuid` / `until_at` / `until_uuid` — 既存のまま

`SessionDumpWriteResult`: `path` / `instance` / `bytes` は既存のまま。`entries` は型ごとの内訳 (`{ "message:user:in": 12, "tool:Bash": 301, … }`) に変える。総数だけでは何が入ったか読み手に分からない。

新規 op `dump_presets_read`: config が持つ preset の `{name, description, opts}` の配列を返す。

## 8. kawaz に決めてもらうこと

1. **型一覧の確認** — `message` / `thinking` / `tool` / `notice` の 4 群と、その配下の型名。特に `notice:*` は csa の `I` を分解したもので、この粒度でいいか (もっと粗く `notice` 1 つに畳む案もある)。
2. **`message:sub:in` の本文をどこから取るか** — task-notification の `<result>` (main の jsonl だけで完結、要約済み) か、`subagents/*.jsonl` の末尾 assistant text (全文、別ファイルを読む) か。両方出す選択肢もある。
3. **`no_thinking` / `no_agent` を `types` に吸収してよいか** — 既存の引数を残すと同じことを 2 通りで書けることになる。
