# dump の種類と軸

`session_dump_write` が切り出す記録は、読み手と目的によって欲しいものが違う。ここでは用途を数種に大分類し、それを直交する軸の既定値セット (preset) として表す案を書く。実装はしない。

## 1. 用途の大分類

| 用途 | 読み手 | 要るもの | 要らないもの |
|---|---|---|---|
| 日記 (journal) | 後から読む人。完了済み session をバッチ処理して書かせる | user 発言、統括の発言、統括の thinking、委譲した事実と受け取った回答 | worker の内部 thinking、tool 実行の逐次 (Read/Edit/Bash の一つ一つ)、progress |
| 引き継ぎ (handoff) | 記憶を消した直後の後継セッション自身 | 直近の会話、現在生きている相手の id 台帳、未完了の作業、決まった方針 | 過去の全 turn、完了済み作業の詳細、thinking |
| 監査 (audit) | 何が実際に実行されたかを検分する人 | tool 実行の入力と結果、発話者の区別、時刻 | thinking、装飾的な発言 |
| 抜粋 (excerpt) | 特定の話題だけを別セッションへ渡したい人 | 指定範囲の会話だけ | 範囲外の一切 |

日記と引き継ぎは kawaz が挙げた 2 例に対応する。監査と抜粋は transcript の構造から導かれるもう 2 つで、既に契約が持つ範囲指定 (`since_*` / `until_*`) は抜粋のためにある。

用途をそのまま enum にすると、用途が増えるたびに contract が増える。用途は軸の既定値セットとして表し、軸は個別に上書きできる形にする。

## 2. 軸の分解

| 軸 | 取りうる値 | 既定 | 現在の契約での対応 |
|---|---|---|---|
| 発話者 | user / 統括 / subagent の任意の組 | 全部 | `no_agent` が subagent を落とす |
| 種別 | 発言 / thinking / tool 実行 (入力) / tool 結果 | 発言のみ | `no_thinking` が thinking を落とす。tool は現在そもそも出ない |
| 範囲 | 全体 / 時刻境界 / record 境界 / 直近 N turn | 全体 | `since_at` / `since_uuid` / `until_at` / `until_uuid`。直近 N は無い |
| 付随物 | id 台帳を付けるか (§3) | 付けない | 無い |
| subagent の配置 | 畳む / Agent 呼び出しの子 / 除外 | 平坦 (現状) | `no_agent` は除外のみ。子として置く手段が無い |

用途を軸の既定値セットとして表すと次になる。

| 用途 | 発話者 | 種別 | 範囲 | id 台帳 | subagent |
|---|---|---|---|---|---|
| 日記 | user + 統括 + subagent | 発言 + 統括の thinking | 全体 | 付けない | 子 |
| 引き継ぎ | user + 統括 | 発言 | 直近 N または record 境界以降 | 付ける | 子 (response のみ) |
| 監査 | 全部 | 発言 + tool 実行 + tool 結果 | 指定範囲 | 付ける | 子 |
| 抜粋 | user + 統括 | 発言 | 指定範囲 | 付けない | 除外 |

thinking の扱いは発話者と種別の掛け合わせになる (日記では統括の thinking は要るが subagent の thinking は要らない)。単一の bool では表せないので、種別を発話者ごとに指定できる形が要る。

## 3. id 台帳

記憶を消した後継セッションは、生きているサブエージェント・バックグラウンドタスク・スケジュールと通信する手段を失う。台帳はその再接続のために要る。実 transcript で確認した出所は次のとおり。

| id の種類 | 出所 | 取り方 |
|---|---|---|
| session id | 全 row の `sessionId` | そのまま |
| subagent の agentId | Agent の tool_result 行の `toolUseResult.agentId`。バックグラウンド起動時の結果は `agentId, isAsync, outputFile, status, description` を持つ | 完了/未完了は同じ結果の `status` で分かる |
| subagent の名前 | Agent の tool_use の `input.name` (指定された場合のみ) | tool_use の `id` から対応する結果へ辿る |
| バックグラウンド Bash の task id | Bash の結果の `backgroundTaskId` | `run_in_background: true` の呼び出しにのみ現れる |
| Monitor の task id | Monitor の結果の `taskId` (`persistent`, `timeoutMs` を伴う) | そのまま |
| TODO の task id | TaskCreate の結果の `task.id` (`subject` を伴う)、TaskUpdate の結果の `taskId` と `statusChange` | 作成と更新を畳んで現在の状態を作る |
| TodoWrite 形式の TODO | `todos` を持つ row、または結果の `newTodos` / `oldTodos` | 最後の row が現在の一覧 |
| cron の job id | CronCreate の結果の `id` (`humanSchedule`, `recurring`, `durable` を伴う) | そのまま |
| Agent 呼び出しと worker transcript の対応 | tool_use の `id` → tool_result の `tool_use_id` → `toolUseResult.agentId` → `agent-<agentId>.jsonl` | findings の表と同じ鎖 |

取れないもの:

- **ccmsg の room / sid**: ccmsg は Bash のコマンド文字列としてしか現れず、構造化された field を持たない。取るならコマンド文字列のパースになり、transcript の読み手の責務を超える。台帳に載せるなら別経路 (instance 自身が知っている接続) から取る。
- **停止済みかどうか**: Monitor / バックグラウンド Bash は、停止した事実が transcript に必ず現れるとは限らない。台帳は「起動された id の一覧」であって「今生きている id の一覧」ではない。生死は id を持って問い合わせて確かめる前提にする。
- **MCP server 経由の id**: tool 名は残るが、id を持つかは server 次第で一般化できない。

台帳は entries とは別の section として置く (会話の流れの中に混ぜると、範囲を切ったときに台帳ごと落ちる)。範囲指定より前に起動された id も台帳には載せる — 生きている相手は範囲の外にいるほうが普通だから。

## 4. subagent の配置

配置は軸の 1 つで、値は「畳む / Agent 呼び出しの子 / 除外」。既定は **Agent 呼び出しの子として 1 段、response のみ** (issue の推し (b))。日記の「私」を統括に固定したまま、委譲した事実と受け取った回答を区別して残せる。

`no_agent` は「除外」に相当する既存の値で、軸に置き換わったあとは軸の 1 値として吸収される。

保存形式が 2 通りある (別ファイルの `subagents/*.jsonl` と、main JSONL の `isSidechain: true` 行) 以上、どの値を選んでも重複排除は必要になる。

## 5. 契約に足す候補

実装しない。候補として:

- `preset`: 用途名。指定すると下の軸の既定値が決まる
- `speakers`: 含める発話者の集合
- `include`: 種別の集合 (発言 / thinking / tool 実行 / tool 結果)。発話者ごとに指定できる形が要る
- `agent_placement`: 畳む / 子 / 除外
- `last_turns`: 直近 N turn (既存の 4 つの境界と排他)
- `ids`: id 台帳を付けるか、付けるならどの種類か
- 結果側: `entries` と並ぶ `ids` section、entry ごとの発話者と親子関係を表す field

`no_thinking` / `no_agent` は `include` / `agent_placement` に吸収される。

## 6. kawaz に決めてもらうこと

1. 用途の大分類はこの 4 種でよいか (日記 / 引き継ぎ / 監査 / 抜粋)。監査と抜粋は transcript から導いたもので、実需があるかは未確認。
2. preset の名前をどうするか (`journal` / `handoff` / `audit` / `excerpt` は仮)。preset を持たず軸だけにする選択肢もある。
3. 既定 (preset 無指定) をどれにするか。現状の平坦な全部入りを既定のまま残すか、日記を既定にするか。
