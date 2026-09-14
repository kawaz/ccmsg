# TUI と併用する permission / waiting 制御

- Date: 2026-09-14
- Status: Concluded
- 対象: Claude Code 2.1.270

## 動機

ccmsg は稼働中の TUI セッションに対して messaging socket から入力を注入し、transcript から出力を読める。一方、workspace trust、tool permission、`AskUserQuestion` など、TUI が人間の選択を待つ状態を外部から解除できるかは別問題である。本調査では、本番 config を変更せず、TUI を表示したまま waiting 系だけを外部制御できる経路の有無を確認した。

## 検証環境

すべてのケースで `CLAUDE_CONFIG_DIR` は `/private/tmp/cli-research-2026-09-14/` 配下の `mktemp -d`、cwd も同配下の新規ディレクトリとした。TUI はケースごとに新規 tmux session で起動し、`tmux capture-pane -p` で観測した。認証は現在の shell から認証に必要な環境変数だけを値を表示せず子プロセスへ渡した。本番の config home、ccmsg daemon、settings は使っていない。各プロセスは検証後、そのケースで起動した tmux session だけを終了した。

一次資料として、現行 `claude --help` / `claude -p --help` / `claude agents --help`、claude-plugin-reference の `reference/cli.md` と `reference/hooks.md`、既存研究 `2026-09-08-session-injection-and-json-port.md` と `2026-09-08-claude-agent-sdk-capabilities.md` を参照した。plugin reference の最終一括検証は 2.1.199 であるため、今回扱う挙動は 2.1.270 で再検証した。

## 結果の要約

**TUI を主口にしたまま、permission dialog だけを `--permission-prompt-tool` や `--permission-prompts` へ外出しする経路はない。** TUI 起動では両 option を受理するが、permission dialog は通常どおり TUI に表示される。`PreToolUse` / `PermissionRequest` hook は dialog の前に allow / deny を確定できるが、hook が `ask` を返した後の TUI dialog を messaging socket などから選択する構造化 API は確認できなかった。

**stream-json は TUI の片側だけを JSON に置換できない。** `--input-format stream-json` は `--output-format stream-json` を必須とし、両方を指定すると SDK/headless の JSON 入出力になる。`--output-format stream-json` 単独は prompt を与えれば headless 出力として動き、TUI を残さない。

**workspace trust は tool permission より前の独立 gate である。** `--dangerously-skip-permissions`、`--allow-dangerously-skip-permissions`、`--permission-mode bypassPermissions`、`--add-dir`、`--safe-mode` のいずれも TUI の trust dialog を消さなかった。trust 待ちのプロセスは `claude agents --json` にまだ登録されない。

## 1. `--permission-prompt-tool` / `--permission-prompts` と TUI

現行 help には両 option が存在する。

```text
--permission-prompts <target>  Who answers permission prompts with --print: "host" ... or "none"
--permission-prompt-tool <tool>  MCP tool to use for permission prompts (only works with --print)
```

TUI で Bash を必ず確認対象にするため、毎ケース次の inline settings と prompt を使った。

```bash
CLAUDE_CONFIG_DIR="$cfg" claude --session-id "$uuid" --model haiku \
  --settings '{"permissions":{"ask":["Bash(*)"]}}' \
  <option-under-test> \
  'Use the Bash tool exactly once to run printf PERMISSION_PROBE. Do not use any other tool.'
```

| TUI 起動 option | 引数受理 | capture-pane | `agents --json` |
|---|---:|---|---|
| 無指定 | yes | `Do you want to proceed? 1. Yes / 2. No` | `status:"waiting", waitingFor:"permission prompt"` |
| `--permission-prompts none` | yes | 同じ TUI dialog | 同じ |
| `--permission-prompt-tool stdio` | yes | 同じ TUI dialog | 同じ |
| `--permission-prompt-tool bogus` | yes | 同じ TUI dialog。MCP tool not found error は出ない | 同じ |

観測抜粋:

```text
Bash(printf PERMISSION_PROBE)
  Waiting…

Permission rule Bash requires confirmation for this command.
Do you want to proceed?
❯ 1. Yes
  2. No
```

結論: **両 option は TUI argv として拒否されないが、TUI mode では permission dialog の委譲先を変えない。TUI dialog が表示され、外部 tool の答えが先行する挙動も観測しなかった。** 存在しない MCP tool 名でも TUI dialog が出たため、TUI 経路では `--permission-prompt-tool` の解決自体が行われていないと判断できる。

`--print` / stream-json では挙動が異なる。既存の 2.1.263 実測どおり、`--permission-prompts none` は自動 deny、`--permission-prompts host --permission-prompt-tool stdio` は stdout の `control_request` に委譲する。これは TUI 併用ではなく、host が UI を担う headless 構成である。

未検証: 実在 MCP permission tool に到達したことを tool 側のログで確認する TUI ケース。`bogus` でも lookup error が出ず TUI dialog が表示されたため、結論を変える可能性は低いが、MCP server の invocation count 自体は取っていない。

## 2. stream-json の片側だけを使えるか

引数制約と実動作を次のコマンドで確認した。

```bash
CLAUDE_CONFIG_DIR="$cfg" claude --input-format stream-json
CLAUDE_CONFIG_DIR="$cfg" claude --output-format stream-json --verbose 'say hi'
CLAUDE_CONFIG_DIR="$cfg" claude --input-format stream-json --output-format text --verbose
CLAUDE_CONFIG_DIR="$cfg" claude --input-format stream-json --output-format stream-json --verbose
```

| 入力 | 出力 | 結果 | TUI |
|---|---|---|---|
| `stream-json` | default / `text` | exit 1: `--input-format=stream-json requires output-format=stream-json.` | 無し |
| default text prompt | `stream-json` + `--verbose` | JSONL の `system/init`、assistant、result を出して終了 | 無し |
| default text prompt | `stream-json`、`--verbose` 無し | exit 1: `--output-format=stream-json requires --verbose` | 無し |
| `stream-json` | `stream-json` + `--verbose` | JSONL 双方向 host mode | 無し |

`--output-format stream-json --verbose 'say hi'` の stdout 先頭は次のとおりだった。

```json
{"type":"system","subtype":"init","cwd":"/private/tmp/cli-research-2026-09-14/...","session_id":"...","tools":[...],"permissionMode":"default"}
```

結論: **入力 JSON / 出力 TUI は不可能で、出力 JSON / 入力 TUI も不可能。** output-only は「TUI の表示だけ JSON 化」ではなく prompt 引数または stdin text を入力にする headless one-shot である。permission prompt は TUI に残らず、headless の host / none / permission prompt tool の経路で処理される。

未検証: `--output-format json` の単発出力は今回の問いが JSONL を対象としているため再試験していない。TUI と共存しない点は help の `only works with --print` と既存実測で確定している。

## 3. permission 系だけを外部制御する経路

### `PreToolUse` hook

各 decision を返す command hook を `--settings` で与えた。

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow|deny|ask","permissionDecisionReason":"probe ..."}}
```

| hook decision | TUI 結果 | 外部制御としての性質 |
|---|---|---|
| `allow` | confirmation 無しで tool 実行。`touch ALLOW_PROBE` の生成を実ファイルで確認 | dialog 前の自動承認として利用可能 |
| `deny` | `Error: probe deny` で tool を止め、session は idle に戻る | dialog 前の自動拒否として利用可能 |
| `ask` | 通常の TUI permission dialog、`waitingFor:"permission prompt"` | dialog を外部へ移さず、TUI に委ねる |

明示的な `permissions.ask:["Bash(*)"]` と hook `allow` を同居させると dialog が出た。複数 permission source ではより制限的な判定が勝るためであり、hook allow が既存 ask rule を緩和する用途には使えない。hook allow 単独では confirmation を省略して実行できた。

`PermissionRequest` hook も一次資料上は `behavior: allow|deny|ask` で dialog 表示直前に同種の決定を返せる。今回、実機では `PreToolUse` の三値を確認し、`PermissionRequest` の三値マトリクスは再実行していない。

### `--permission-prompt-tool` と MCP

TUI では前節のとおり、`stdio` と存在しない tool 名のどちらでも TUI dialog が表示された。したがって MCP tool を指定しても「全部 TUI、permission だけ MCP」の構成にはならない。MCP / stdio へ委譲する正式経路は stream-json host mode である。

### hook が `ask` を返した後

permission 待ちの session の messaging socket `/tmp/cc-socks/<pid>.sock` に次を送った。

```json
{"type":"user","message":{"content":"Yes, approve the pending permission prompt."}}
```

送信前後とも `claude agents --json` は次の状態のままで、TUI dialog も残った。

```json
{"status":"waiting","waitingFor":"permission prompt"}
```

結論: **messaging socket の user message は permission dialog の選択入力ではなく、会話 prompt queue への注入なので、pending permission を承認できない。** TUI のキー入力を tmux 等で代行することは技術的には可能だが、画面座標・選択肢に依存する端末自動操作であり、permission 用の構造化外部経路ではない。

未検証: `/tmp/cc-socks` の `control` frame に非公開の permission response subtype が追加されていないかのバイナリ全探索。既存 wire protocol、`agents --json`、help、実際の socket 注入ではその経路を確認できなかった。

## 4. workspace trust を settings 先書き以外で越えられるか

各ケースで新規 config と新規 cwd を作り、初回 theme / security notice の onboarding 後、trust の選択は行わず capture した。

```bash
CLAUDE_CONFIG_DIR="$cfg" claude --session-id "$uuid" <option-under-test>
```

| option | trust dialog |
|---|---|
| 無指定 | 表示 |
| `--dangerously-skip-permissions` | 表示 |
| `--allow-dangerously-skip-permissions` | 表示 |
| `--permission-mode bypassPermissions` | 表示 |
| `--add-dir "$cwd"` | 表示 |
| `--safe-mode` | 表示 |

全ケースで次の画面を観測した。

```text
Accessing workspace:
/private/tmp/cli-research-2026-09-14/...

❯ No, exit
  Yes, I trust this folder
```

`--dangerously-skip-permissions` と `bypassPermissions` が消すのは tool permission であり、workspace trust ではない。`--allow-dangerously-skip-permissions` は bypass を選択可能にするだけで、既定適用すらしない。`--add-dir` は tool access の許可範囲を増やす option で、起動 cwd 自体の trust 承認ではない。`--safe-mode` も customization を止める診断 mode で、trust gate は残る。

stream-json / `-p` では trust dialog を出さずに処理できることを、隔離 config で `claude -p 'say hi' --output-format json` が成功することでも追認した。しかし TUI を維持する案ではない。

結論: **確認した documented option / env の範囲に、TUI の workspace trust を非対話で承認するものはない。** settings の project entry 先書きまたは TUI の選択以外は確認できなかった。

未検証: managed policy に workspace trust を事前承認する非公開 field があるか。`CLAUDE_CODE_SAFE_MODE=1` は `--safe-mode` と同値なので別ケースにしていない。`--bare` は認証要件が通常 mode と異なるため完全マトリクスから外したが、onboarding 段階で trust を免除する根拠は得られなかった。

## 5. `claude agents --json` の `waiting` 条件と解除経路

同じ一時 `CLAUDE_CONFIG_DIR` から `claude agents --json` を実行した。

| TUI 状態 | `agents --json` | 外から解除できる構造化経路 |
|---|---|---|
| workspace trust dialog | `[]`。session 未登録 | 無し。TUI 選択または trust state の先書き |
| model / tool 実行中 | `status:"busy"` | waiting ではない。interrupt 系は別責務 |
|通常入力欄 | `status:"idle"` | messaging socket の user message で次 turn を起動可能 |
| tool permission dialog | `status:"waiting", waitingFor:"permission prompt"` | TUI では無し。hook が dialog 前に allow / deny するか、最初から stream-json + permission host を使う |
| `AskUserQuestion` | `status:"waiting", waitingFor:"input needed"` | TUI 用の選択肢回答 API は確認できず、TUI キー入力が必要 |

`AskUserQuestion` の観測抜粋:

```text
☐ Choice
Which option would you prefer?
❯ 1. Option A
  2. Option B
  3. Type something.
```

対応する状態:

```json
{"kind":"interactive","status":"waiting","waitingFor":"input needed"}
```

workspace trust 待ちは process が存在し TUI dialog が表示されていても `claude agents --json` が空配列だった。したがって **`state: waiting` という単一 field ではなく、2.1.270 の interactive schema は `status:"waiting"` と `waitingFor` を使う。** trust はその schema に載る前の状態である。

既存 2.1.263 の観測にあった background session の `state:"working|done|failed"` は interactive の `status` とは別 field である。今回の問いに該当する interactive waiting では `state` field 自体が出力されなかった。

「その他」の waiting 候補として MCP elicitation、login/auth dialog、plan approval、background agent の `agent_needs_input` notification が一次資料に存在するが、`agents --json` の `waitingFor` 値との対応は今回実機再現していない。確認できた一覧は permission prompt と `AskUserQuestion` の二種、および trust が一覧外であることまでである。

## 実用上の判断

TUI を残す設計では、外部 controller が安全にできることは次に限られる。

- `agents --json` で `waitingFor` を観測する。
- permission policy を hook で dialog 前に allow / deny する。
- idle session へ messaging socket から通常の user message を注入する。

permission や `AskUserQuestion` の具体的な pending dialog を外から構造化回答する必要があるなら、TUI を主口にしてはいけない。最初から `--input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio`、または Claude Agent SDK を host として起動し、表示 UI を host 側に実装する必要がある。workspace trust を TUI のまま無対話通過させる起動 option は確認できないため、TUI 常駐プロセスの自動起動には trust 済み workspace という前提が残る。
