# Codex CLI の走行中セッションへのメッセージ配送経路

- Date: 2026-09-09

## 判明した事実

- 実機の `codex-cli 0.153.4` は `codex queue --thread <UUID-or-exact-name> --message <TEXT>` を持つ。これは端末へのキー入力ではなく、app-server の JSON-RPC `thread/queue/add` に user input を送り、session queue に永続化する正規経路である。
- 同一 release tag の upstream integration test では、queue を idle thread に追加すると user message として直ちに turn が始まり、active thread に追加した項目は queue に残って現在の turn の後に実行され、not-loaded な cold thread に追加した項目は `thread/resume` 時に user message として実行された。この成功経路は実機 0.153.4 では未観測である。
- `codex queue` は local shared app-server daemon、明示した remote app-server、または条件によって embedded app-server を使う。走行中 TUI へ届けるには、その TUI と sender が同じ daemon-backed thread を参照する必要がある。独立した embedded app-server を持つ任意の TUI process へ横から注入する一般的な process-local socket ではない。
- Codex の thread identifier は UUID である。実機の `SessionStart.session_id`、`SessionEnd.session_id`、legacy `notify` の `thread-id`、`codex exec --json` の `thread.started.thread_id`、rollout filename 末尾の UUID は同一だった。
- rollout transcript は通常 `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDTHH-MM-SS-<thread-id>.jsonl` にある。JSONL の先頭 `session_meta` item の `payload.id` も同じ thread UUID である。revert では stable thread ID の後に別 rollout ID が `_` で付く。
- `features.hooks = true` と `hooks.json` を隔離した `CODEX_HOME` に置き、`codex exec` を localhost mock Responses API で正常完了させたところ、`SessionStart` と `SessionEnd` の command hook が発火した。
- `SessionStart` stdin は `session_id`、`transcript_path`、`cwd`、`hook_event_name`、`model`、`permission_mode`、`source` を持つ。観測した `source` は `startup` だった。`SessionEnd` stdin は `session_id`、`transcript_path`、`cwd`、`hook_event_name`、`reason` を持ち、観測した `reason` は `other` だった。
- user-level `notify = [command, ...]` は completed turn 後に command の末尾 argv として JSON を渡す。実機 payload は `type`、`thread-id`、`turn-id`、`cwd`、`client`、`input-messages`、`last-assistant-message` を持ち、`client` は `codex_exec` だった。stdin ではない。
- `codex exec resume <thread-id> <prompt>` は保存済み thread を別の non-interactive client で再開して新 turn を送る経路であり、すでに動いている対話 TUI に user turn を注入する経路ではない。
- rollout JSONL の直接追記は recorder / thread store の管理外であり、live thread への通知も起こさない。配送口には使えない。
- MCP server は Codex が tool を呼ぶ方向、hooks と `notify` は Codex が外部 command / MCP handler を呼ぶ方向である。外部 sender から Codex の live conversation へ user input を届ける逆方向の入口ではない。

## 実用的な示唆

Codex plugin の配送経路は `codex queue --thread <sid> --message <text>`、または同じ意味の app-server `thread/queue/add` を候補にできる。Claude Code の messaging socket と異なり、配送先は process ではなく daemon-backed thread queue である。この差を session capability として表現し、embedded TUI など queue endpoint を共有しない session を送達可能と扱わない必要がある。

`SessionStart` hook だけで ccmsg の `sid` と `transcript_path` を登録できる。Codex では `sid = session_id = thread UUID`、`transcript_path = rollout JSONL path` と直接対応する。`SessionEnd` も同じ値を返すので unregister に使える。

legacy `notify` は turn 完了通知には使えるが、SessionStart / SessionEnd の代替ではない。session lifecycle 登録は hooks、turn 完了 event は必要なら `notify` と責務を分ける。

## 配送経路マトリクス

「対話 TUI」は sender と同じ daemon-backed thread を開く TUI を指す。「非対話」は `codex exec` client または cold thread を指す。

| 経路候補 | 対話 TUI に届くか | 非対話 / cold thread に届くか | thread ID を指定できるか | 根拠 |
|---|---|---|---|---|
| `codex queue` / `thread/queue/add` | はい。idle なら即 turn、active なら current turn 後 | はい。not-loaded thread では永続 queue となり resume 時に実行 | はい。UUID または CLI では exact session name | 実機 CLI / JSON-RPC source / upstream integration test |
| app-server `turn/start` | はい。ただし app-server client が対象 thread を直接操作する低水準 API | はい。loaded thread に新 turn を開始 | はい | generated JSON schema / app-server source |
| `codex exec resume <id> <prompt>` | いいえ。既存 TUI への注入ではなく別 exec client による resume | はい | はい | 実機 help / exec source |
| rollout JSONL への追記 | いいえ | いいえ | filename から取得のみ | recorder / thread-store source。外部追記 API なし |
| MCP notification / MCP server | いいえ | いいえ | Codex の tool context には session 情報があり得るが配送 API ではない | MCP の呼出方向 |
| `notify = [cmd]` | いいえ | いいえ | payload に `thread-id` が入る | 実機 payload / source |
| command hooks | いいえ | いいえ | stdin に `session_id` と `transcript_path` が入る | 実機 payload / source |
| tmux 等の端末入力 | 条件付き。ただし正規 Codex protocol ではない | 対象外 | process / pane の識別が別途必要 | 調査対象外の fallback |

## session identifier と transcript

| ccmsg 概念 | Codex の対応 | 実機観測 |
|---|---|---|
| `sid` | thread UUID | hooks、notify、exec event、rollout filename で同一 |
| `transcript_path` | rollout JSONL path | hooks が絶対 path を直接供給 |
| session start | `SessionStart` hook | `source: startup` で発火 |
| session end | `SessionEnd` hook | `reason: other` で発火 |
| live delivery address | daemon endpoint + thread UUID | `codex queue` が `thread/queue/add` を送信 |
| turn ID | thread 内の turn UUID | notify の `turn-id`。thread UUID とは別 |

rollout の通常 basename は `rollout-<UTC timestamp>-<thread UUID>.jsonl`。先頭行は次の形で、以降も各行が timestamp / type / payload を持つ JSON object だった。

```json
{"timestamp":"<timestamp>","type":"session_meta","payload":{"id":"<thread-uuid>","timestamp":"<timestamp>","cwd":"<repo>","originator":"codex_exec",...}}
```

user input と assistant output は `response_item` として記録された。

```json
{"timestamp":"<timestamp>","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"probe lifecycle"}]}}
{"timestamp":"<timestamp>","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"probe complete"}]}}
```

## hooks と notify の実機観測

### 条件

- `codex-cli 0.153.4`
- 本物の `~/.codex` は未使用。`CODEX_HOME=<temporary directory>` を指定
- localhost の最小 Responses API mock を custom provider として設定し、外部 credential なしで `codex exec` を正常完了
- command hook の trust は実験用 `--dangerously-bypass-hook-trust` で明示的に bypass
- hook command は stdin を、notify command は末尾 argv を隔離先へ保存

実行の骨格:

```sh
CODEX_HOME=<CODEX_HOME> PROBE_DIR=<probe-dir> codex exec \
  --skip-git-repo-check \
  --dangerously-bypass-hook-trust \
  --json \
  'probe lifecycle'
```

終了 status は 0。exec の主要 event は次の通りだった。

```json
{"type":"thread.started","thread_id":"<thread-uuid>"}
{"type":"turn.started"}
{"type":"item.completed","item":{"type":"agent_message","text":"probe complete",...}}
{"type":"turn.completed","usage":{...}}
```

### `SessionStart` stdin

```json
{
  "session_id": "<thread-uuid>",
  "transcript_path": "<CODEX_HOME>/sessions/2026/09/09/rollout-2026-09-09T16-41-57-<thread-uuid>.jsonl",
  "cwd": "<repo>",
  "hook_event_name": "SessionStart",
  "model": "<model>",
  "permission_mode": "bypassPermissions",
  "source": "startup"
}
```

### `SessionEnd` stdin

```json
{
  "session_id": "<thread-uuid>",
  "transcript_path": "<CODEX_HOME>/sessions/2026/09/09/rollout-2026-09-09T16-41-57-<thread-uuid>.jsonl",
  "cwd": "<repo>",
  "hook_event_name": "SessionEnd",
  "reason": "other"
}
```

### `notify` 末尾 argv

```json
{
  "type": "agent-turn-complete",
  "thread-id": "<thread-uuid>",
  "turn-id": "<turn-uuid>",
  "cwd": "<repo>",
  "client": "codex_exec",
  "input-messages": ["probe lifecycle"],
  "last-assistant-message": "probe complete"
}
```

認証を構成しない隔離 `CODEX_HOME` では、login gate で session 作成前に待機し hooks は発火しなかった。これは hooks の不発ではなく、session lifecycle より前の認証条件である。custom provider と localhost mock を設定すると上記の lifecycle 全体が発火した。

## `codex queue` の実機観測

存在しない UUID を、local daemon のない隔離 `CODEX_HOME` に指定した。

```sh
CODEX_HOME=<CODEX_HOME> codex queue \
  --thread 11111111-1111-4111-8111-111111111111 \
  --message probe
```

status は 1 で、stderr は次の通りだった。

```text
Error: failed to queue session message: thread/queue/add failed: failed to read thread: invalid thread-store request: no rollout found for thread id 11111111-1111-4111-8111-111111111111 (code -32603)
```

この試験では本物の session や daemon を操作していない。成功時の idle / active / cold thread の意味論は同じ release tag の upstream integration test で確認した。

CLI source では、UUID でなければ exact session name を lookup し、次の JSON-RPC params を組み立てる。

```json
{
  "threadId": "<thread-uuid>",
  "input": [{"type":"text","text":"<message>","textElements":[]}],
  "clientUserMessageId": "<uuid-v7>"
}
```

## ccmsg 側で不足し得る契約・daemon 能力のフラグ

以下は実装案ではなく、採否を当事者が source と実機で再確認するためのフラグである。

- delivery transport capability: Claude messaging socket と Codex thread queue を区別する表現が必要。`sid` だけでは daemon endpoint / embedded-vs-shared の送達条件を表せない。
- Codex session registration: `SessionStart` payload の `session_id`、`transcript_path`、`cwd`、`source` を hello に写す agent adapter が必要。
- lifecycle reason mapping: Codex `SessionEnd.reason` と既存 goodbye reason の対応確認が必要。
- queue endpoint discovery: local managed daemon の default socket、明示 remote endpoint、embedded app-server のどれに thread が属するかを登録時または配送時に判断する情報が必要。
- delivery acceptance semantics: `thread/queue/add` 成功は「queue に永続化済み」であり、「対話 TUI が現在表示した」「model が処理し終えた」ではない。既存 `message_send` の delivered / held / dropped の意味との対応確認が必要。
- cold thread policy: inactive session の queue を ccmsg の「走行中 session への配送」と認めるか、session listing から除外するかの契約判断が必要。
- deduplication: `clientUserMessageId` を ccmsg message identity と対応させられるか、再試行時の重複防止保証を確認する必要がある。
- version / capability negotiation: `thread/queue/add` は protocol source 上 experimental handshake 対象で、古い daemon は method unsupported を返す。CLI と常駐 daemon の version drift を capability として扱う必要がある。
- direct-input ownership: app-server は thread の direct input 可否を検査する。別 client が所有中の thread、remote workspace、approval 中などの拒否条件を配送 failure taxonomy に写す必要がある。
- queue bounds: upstream test は 1 thread あたり 100 submissions 上限を固定している。queue full を既存 protocol error にどう写すか確認が必要。
- transcript mutability: revert では thread ID と rollout ID が分かれ、同じ thread に新しい immutable rollout file が生じる。登録時の `transcript_path` を永久固定値とみなせるか確認が必要。
- notify schema: payload key が hooks の snake_case と異なる kebab-case であり、`thread-id` と `turn-id` を混同しない parser が必要。
- hook trust / install: command hooks は trust gate を持つ。plugin installer が hook 配置だけでなく user consent と非破壊 merge をどう扱うか確認が必要。

## 走行中の thread が在ることの証拠 (2026-09-10 追記)

`$CODEX_HOME/thread-writer-locks/` に thread 1 つにつき 1 つの lock file が現れる。隔離した `CODEX_HOME` と localhost の mock Responses API で `codex exec` を走らせ、turn の最中と終了後に同ディレクトリを読んだ結果は次の通り。

| 時点 | `thread-writer-locks/` の中身 |
|---|---|
| 起動前 | ディレクトリ自体が無い |
| turn 進行中 (応答を遅延させて観測) | `.coordination.lock` と `<thread-uuid>.lock` |
| 正常終了後 | `.coordination.lock` のみ |
| `SIGKILL` 後 | `.coordination.lock` と `<thread-uuid>.lock` (残留) |

`<thread-uuid>` は同じ実行の `SessionStart.session_id`・rollout file 名の UUID と一致した。`.coordination.lock` は thread を名乗らない。

upstream (`codex-rs/rollout/src/writer_lock.rs`) では lock は flock (`try_lock`) で保持され、`acquire` の際に `remove_stale_thread_locks` が「flock を取れる lock = 誰も掴んでいない lock」を削除する。したがって `SIGKILL` で残った lock は**次に誰かが thread を書き始めるまで**残り、その時点で掃除される。flock を試せば stale 判定は可能である。

## ccmsg のセッションが Codex から起動された場合の環境 (2026-09-10 追記)

親セッションの環境をそのまま継承する。Claude Code のセッションから `codex exec` を起動し、`SessionStart` hook の `env` を保存した結果、hook の環境には次が同時に立っていた。

- `CODEX_HOME` (起動側が指定した値)
- `CLAUDE_CONFIG_DIR`、`CLAUDE_CODE_SESSION_ID`、`CLAUDE_CODE_MESSAGING_SOCKET` 等、親 Claude Code セッションのもの一式

**hook の環境に thread id は入らない**。入っていたのは `CODEX_HOME` だけで、`CODEX_THREAD_ID` / `CODEX_SESSION_ID` は無かった。hook が thread を知る経路は stdin の `session_id` である。

**ツール実行の環境には入る**。本物の Codex セッションでコマンドを走らせると `CODEX_THREAD_ID` と `CODEX_SESSION_ID` の両方が立ち、値はどちらも同じ thread UUID (= `SessionStart.session_id` と同じ形、UUIDv7) だった。

## 一次資料

実機 0.153.4 に最も近い公開 tag として `rust-v0.153.0`、commit `41e22fee981a63b3698df7ed36bad393cda24715` を参照した。0.153.0 から 0.153.4 の patch 差は未観測だが、この文書で引用した CLI help、hook payload、notify payload、queue failure は 0.153.4 実機でも一致した。

- [Codex CLI top-level commands (`queue`)](https://github.com/openai/codex/blob/rust-v0.153.0/codex-rs/cli/src/main.rs)
- [`codex queue` implementation](https://github.com/openai/codex/blob/rust-v0.153.0/codex-rs/cli/src/queue_cmd.rs)
- [session queue command and `thread/queue/add` request](https://github.com/openai/codex/blob/rust-v0.153.0/codex-rs/tui/src/session_queue_commands.rs)
- [`ThreadQueueAddParams` protocol type](https://github.com/openai/codex/blob/rust-v0.153.0/codex-rs/app-server-protocol/src/protocol/v2/thread.rs)
- [app-server queue processor](https://github.com/openai/codex/blob/rust-v0.153.0/codex-rs/app-server/src/request_processors/thread_queue_processor.rs)
- [queue integration tests: active, idle, cold resume, bounds](https://github.com/openai/codex/blob/rust-v0.153.0/codex-rs/app-server/tests/suite/v2/thread_queue.rs)
- [hook command input schema](https://github.com/openai/codex/blob/rust-v0.153.0/codex-rs/hooks/src/schema.rs)
- [`SessionStart` implementation](https://github.com/openai/codex/blob/rust-v0.153.0/codex-rs/hooks/src/events/session_start.rs)
- [`SessionEnd` implementation](https://github.com/openai/codex/blob/rust-v0.153.0/codex-rs/hooks/src/events/session_end.rs)
- [legacy `notify` payload and argv invocation](https://github.com/openai/codex/blob/rust-v0.153.0/codex-rs/hooks/src/legacy_notify.rs)
- [rollout recorder and JSONL layout](https://github.com/openai/codex/blob/rust-v0.153.0/codex-rs/rollout/src/recorder.rs)
- [rollout filename parser / renderer](https://github.com/openai/codex/blob/rust-v0.153.0/codex-rs/rollout/src/rollout_file_name.rs)
- [official app-server documentation](https://github.com/openai/codex/tree/rust-v0.153.0/codex-rs/app-server)
- [Codex configuration reference](https://developers.openai.com/codex/config-reference/)
- [Codex MCP documentation](https://developers.openai.com/codex/mcp/)