# DR-0006: dump は型付き item の成果物として書き出す

Status: Accepted (2026-09-11。統括裁定。sidechain の配置は issue `2026-09-10-dump-sidechain-rows-placement` の裁定)
Date: 2026-09-11
Sponsor: kawaz 依頼 (2026-09-10)「後任セッションに渡せる日記」。配置の裁定は統括
関連: 設計 §5 (transcript の分類と dump)、`docs/design/dump-kinds.md` (型の体系の正本)、[DR-0002](DR-0002-contract-holds-the-vocabulary.md)、[DR-0007](DR-0007-classify-by-who-the-conversation-is-with.md)、issue archive `2026-09-10-dump-sidechain-rows-placement`、issue `2026-09-11-dump-raw-jsonl-format` / `2026-09-11-dump-timeline-shared-selection`

## 1. 背景

`session.dump.write` は transcript を読んで、後任セッションに渡せる成果物を書く。当初の実装は main の jsonl の行をそのまま並べるもので、次の 3 つが欠けていた。

- worker (sidechain) の発話が `<sid>/subagents/agent-<id>.jsonl` に分離されているため落ちる
- 行を並べるだけなので、統括と worker の区別も親子関係も読み手に残らない
- 何を残して何を落とすかが `no_thinking` / `no_agent` の 2 つの bool でしか言えない

## 2. 決定

### 2.1 dump が持つのは行ではなく item

transcript の行を **item に分類してから**書く。型名は `.` 区切りの階層で、prefix が配下をまとめて指す (`message.user.in` / `thinking` / `tool.Bash` / `notice.slash` / `system.compact` / `hook.<Event>`)。型の体系の正本は `docs/design/dump-kinds.md`。

**item は行より細かい。** 1 つの assistant record は、思考と言葉と、そこにあった呼び出しそれぞれになる。**呼び出しと結果は実体どおり 2 item**で、`result_item` / `parent_item` で互いを指す。

### 2.2 呼び出しの答えは自分の時刻に単独で置く

結果が何 turn も後に来るものがある (`Agent` は worker が走り終わるまで、`Monitor` は監視対象が動くまで返らない)。分類の段階で 1 つに畳むと、**離れて存在する 2 つの事実をどちらの時刻に置くかを分類が決めてしまう**。実体が 2 行なら 2 item で出し、時刻はそれぞれが持つ。

**畳むかどうかは描画側が決める。** 接していれば `→` で 1 かたまりに寄せ、離れていれば答えが届いた所に `←` で描く。読み手が追うのは起きた順なので、後から返ってきた答えは後の瞬間として描かれる。

### 2.3 worker の内部は主語の行に inline しない

主語は既定でセッション、指定すればその配下の agent 1 体 (`agent_id`)。**worker の中で起きたことを統括の行に流し込まない。** worker を読みたければ、その `agent_id` を主語にして次の dump を取る (`ids` ledger が主語にできるものを並べる)。

型定義は主語によって変わらない。`in` / `out` は主語の立ち位置から読む。これが **1 つの preset を鎖の下まで持って行ける**理由で、末尾の ledger から取った `agent_id` がそのまま次の dump の主語になる。

### 2.4 何を残すかは `types` が左から右に決める

要素は型名 (prefix でよい)、`-` で始まる除外、`@<preset>` (設定した選択をその場に展開、再帰する)。省略時は `system.attachment` 以外の全部。

**preset は契約ではなく設定 (`dump.presets`) に置く。** preset が名指すのは関心であって wire の性質ではない。循環や、誰も設定していない preset 名は **設定を読む時に弾く** — request ごとに見つけるのでは遅すぎる。`daemon add` が 5 つの例を `config_v2.ts` に書き、`dump.presets.read` がそれを並べる。

`no_thinking` / `no_agent` は `["-thinking"]` / `["-message.sub", "-tool.Agent"]` を意味し、最後に適用される。これらは使い走りの機構を落として **teammate とのやり取りは残す** — teammate と交わすのは会話であって、会話を残せと言った dump から会話を落とすことになる。

### 2.5 ファイルの形も契約が持つ

応答は item ではなくパスを返すので、そのパスを渡された後任セッションが、何も規定していない形式を読むことになってはいけない。`SessionDumpFile` = `{sid, agent_id?, written_at, types, items, ids}`。`types` は **適用後の選択** (preset を展開し、除外を含んだ形) — ファイルは作った request より長く生きるので、何の dump で何が落とされたかを自分で言えなければならない。`ids` ledger は型ではなく、選択で落とせない。

### 2.6 出力は 3 形式、今あるのは 1 つ

| 形式 | 状態 |
|---|---|
| item の JSON (`session.dump.write`) | 実装済み。機械が読む形 |
| 元 jsonl を型で grep した生の行 | issue `2026-09-11-dump-raw-jsonl-format` |
| 人が読むテキスト | 実装済み (`ccmsg dump` の描画)。webui の Timeline と選択を共有する形は issue `2026-09-11-dump-timeline-shared-selection` |

### 2.7 M4 との関係

dump は transcript から導出されるが、**生成時刻と範囲で固定された 1 度の切り取り**で、元を追いかけ続けることはしない。M4 が禁じているのは「派生値を disk に置き、元との整合を取り続けること」で、その害は整合の手順が生まれることにある。dump にその手順は生まれない。立場は「人が op に作らせた成果物」で、launcher が起こした子プロセスや sandbox が発行した URL と同じ、頼まれて世に残した効果であって instance の状態ではない。誰も捨てない。

## 3. 不採用

| 案 | 理由 |
|---|---|
| worker の発話を統括の行に inline する | 主語が誰かが読み手に残らない。worker を読みたい時は主語を変えて取ればよい |
| worker を落とす (main の jsonl だけ読む) | 起票の発端がこれ。worker の答えが日記から消える |
| 呼び出しと結果を分類の段階で 1 item に畳む | 離れて存在する 2 つの事実の時刻を分類が決めてしまう。非同期をそのまま見せる描き方が作れなくなる |
| preset を契約に置く | preset が名指すのは関心であって wire の性質ではない |
| `no_thinking` / `no_agent` で teammate とのやり取りも落とす | 会話を残せと言った dump から会話が消える |
| 未知の型を落とす | 分類は誤りうる。落とすと元の行に戻る道が消える (未知の tool は汎用の `{input}` / `{result}`、未知の添付は `kind` のまま、どれにも当たらない record は `system.unknown`) |

## 4. 影響

- 設計 §5、`docs/design/dump-kinds.md`
- 契約に `SessionDumpFile` と item の型名の語彙
