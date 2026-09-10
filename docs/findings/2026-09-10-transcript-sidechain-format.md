# Transcript の sidechain 保存形式と dump の現状

- Date: 2026-09-10

## 判明した事実

- 実 transcript の保存形式は 1 種類ではない。全体走査では、session 配下の `subagents/agent-<agentId>.jsonl` と、project 直下の sidechain-only JSONL の両方に `isSidechain: true` が存在した。
- 異なる 3 project の親 session を確認した範囲では、main JSONL に sidechain turn はなく、worker の全 turn は `<sid>/subagents/agent-<agentId>.jsonl` に分離されていた。main JSONL には `Agent` の `tool_use`、対応する `tool_result`、worker の進捗を表す `progress` が記録される。
- `Agent` の呼び出しと worker transcript は、main JSONL の `tool_use.id` → `tool_result.tool_use_id` → `toolUseResult.agentId` → subagent ファイル名の `<agentId>` → subagent 各行の `agentId` で接続できた。
- subagent ファイル内では各行に `agentId: string` と `isSidechain: true` があり、root 以外の行は `parentUuid: string` で同じファイル内の `uuid: string` を参照する。したがって worker 内の turn と tool call の鎖は `parentUuid` で辿れる。
- `session_dump_write` は session の main JSONL だけを読む。別ファイルの `subagents/*.jsonl` は探索しないため、現在の 3 session 形式では worker の response を dump に含めない。
- main JSONL に `isSidechain: true` の行がある入力では、既定の dump は main turn と sidechain turn を区別せず同じ `entries` 配列へ平坦に含める。`no_agent: true` は sidechain turn を除外し、`no_thinking: true` は main と sidechain の両方から thinking だけを除外する。

## 実用的な示唆 / ベストプラクティス

日記用途で worker の回答を残すには、main JSONL の `Agent` 呼び出しだけでなく `subagents/*.jsonl` を明示的に読み、`agentId` と tool use/result の対応から配置を復元する必要がある。main JSONL に sidechain 行が混ざる形式も存在するため、実装は別ファイルだけを前提にせず、同一 worker turn の重複排除も責務として持つ必要がある。

現 dump の平坦な `entries` だけでは、agent の発話が統括の発話か worker の発話かを読み手が判別できない。日記の「私」を統括に固定するなら、worker response は Agent 呼び出しの子として明示的に区別する必要がある。

## 検証の詳細

### 実 transcript 3 session の構造

会話本文、project 名、session id、agent id は記録せず、構造だけを集計した。

| 観測対象 | Session A | Session B | Session C |
|---|---:|---:|---:|
| main JSONL の行数 | 14,653 | 9,135 | 7,976 |
| main JSONL の `isSidechain: true` 行 | 0 | 0 | 0 |
| main JSONL の `Agent` tool use | 28 | 106 | 51 |
| main JSONL の `progress` 行 | 0 | 7,009 | 4,785 |
| `<sid>/subagents/*.jsonl` | 28 files | 109 files | 51 files |
| 抽出した subagent ファイルの全行が `isSidechain: true` | yes | yes | yes |
| 抽出した subagent ファイルごとの `agentId` 種類数 | 1 | 1 | 1 |
| 先頭以外の行から同一ファイル内の親を `parentUuid` で参照 | yes | yes | yes |

3 session の main JSONL で `Agent` の結果に `agentId` が存在した 201 件は、すべて同名の `agent-<agentId>.jsonl` があり、そのファイルの全行の `agentId` と一致した。`toolUseResult.agentId` がない結果もあり、呼び出し件数と `agentId` 件数は常に同じではない。

全体走査では 330 project、10,989 JSONL に `isSidechain: true` が見つかった。`<sid>/subagents/*.jsonl` に加え、project 直下に sidechain-only の JSONL がある形式も実在した。後者の確認例では user 行と assistant 行の 2 行構成で、両行に同じ `agentId` があり、assistant 行の `parentUuid` が user 行の `uuid` を参照していた。

### 親子関係に使えるフィールド

| 場所 | フィールド | 型 | 関係 |
|---|---|---|---|
| main assistant row の `message.content[]` | `type`, `name`, `id` | string | `type: "tool_use"`, `name: "Agent"` の `id` が Agent 呼び出し id |
| main user row の `message.content[]` | `type`, `tool_use_id` | string | `type: "tool_result"` の `tool_use_id` が Agent 呼び出しの `id` を参照 |
| main user row | `toolUseResult.agentId` | string | 完了した worker の識別子 |
| subagent file name | `agent-<agentId>.jsonl` | path segment | main の `toolUseResult.agentId` と一致 |
| subagent 各 row | `agentId` | string | 同一 worker の所属を表し、ファイル名と一致 |
| subagent 各 row | `uuid`, `parentUuid` | string | `parentUuid` が同じファイル内の直前祖先 row の `uuid` を参照 |
| main progress row | `data.agentId` | string | worker の進捗通知が属する agent を表す。row 直下には `agentId` がない |

### daemon のコード上の扱い

`src/sessions/dump.ts` の `dumpWrite` は `TranscriptFiles.session(sid)` が返す main JSONL を 1 ファイルだけ読み、各行を `readRecord` に通す。`readRecord` は `isSidechain === true` を `sidechain: true` に変換するが、dump entry 自体には sidechain 情報を残さない。

`collect` は既定で sidechain record も `entries` に追加し、`no_agent: true` の場合だけ `record.sidechain` を除外する。`no_thinking: true` は sidechain 判定と独立して thinking field を省く。

`src/transcript/fold.ts` の session 状態 fold は、main session の model、API error、last user input の判定では sidechain を除外する。一方、file path の観測では sidechain tool call も対象にする。この fold と dump は目的が異なり、sidechain の扱いも同一ではない。

### 隔離 daemon の UDS 実測

OS temp dir の下に config home、config dir、state dir、project transcript を作り、`ccmsg daemon run` を foreground child process として起動した。公開 port は設定せず、生成された UDS に `hello` と `session_dump_write` を送った。fixture は main user、thinking と response を持つ sidechain assistant、thinking と response を持つ main assistant の 3 行である。daemon は `instance_shutdown` で終了し、exit code 0 を確認した。

| 呼び出し | dump entries | sidechain assistant | main assistant | thinking |
|---|---:|---|---|---|
| 既定 | 3 | 含む | 含む | 両 assistant に含む |
| `no_agent: true` | 2 | 除外 | 含む | main assistant に含む |
| `no_thinking: true` | 3 | 含む | 含む | 全 entry から除外 |

既定の dump では発話者は user、agent、agent の順になり、sidechain assistant と main assistant は同じ `said_by: "agent"` だった。sidechain marker、agent id、Agent 呼び出しとの親子関係は dump に残らなかった。
