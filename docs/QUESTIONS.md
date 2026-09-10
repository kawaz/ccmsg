# 裁定・確認待ち一覧 (ユーザ用)

## 運用規約

<details>
<summary>ゼロコンテキストエージェント向け（本セクションは消さない）</summary>

- 裁定/確認待ち項目を 1項目=1ラベル=1セクション で記載
- ラベル形式: XX-Q1（XX は 2-3 文字、バッチやセッション内で一意、Qn単独の使い回し禁止、長期一意性は不要)
- 依頼形式: 「👺XX-Q1 の裁定お願いします」（参照用途ではラベルに👺を付けない。誤陽性がユーザのハイライト/アラームを汚す）
- チャット提示と同一ターンで本ファイルに記録 + path 指定 commit (push はリリース窓に同乗)
- 裁定が下りたら該当セクションを即削除し、内容は正規の記録先 (DR / issue / journal / close_reason) へ反映。本ファイルは常に「現在待ち」だけを持つ
- 参照は[]()で提示（リポ内は相対、リポ外はフルパス）
- 初版質問/依頼は長文で書かない（ユーザが説明を求めらたら本ファイルに説明を追加し、チャットで👺ラベルで再依頼）
- **選択肢・確認項目は `- [ ] a: …` 形式（チェックボックス + ラベル）で書く**。
  Q / C で記法を分けない。回答は「チェックを付ける」でも「XX-Q1a」と言葉で返すでも通る
  （複数まとめてチェックし「チェックしたよ」の一言で済ませる運用を想定）

</details>

## 裁定待ち

### DS-Q2 dump のアイテム型の体系の確認

起草: [design/dump-kinds.md](design/dump-kinds.md)。主語は main、`:` 区切りで prefix 選択可 (`tool` = `tool:*`)。4 群:

- `message:user:{in,out}` (人との会話)、`message:sub:{out,in}` (Agent への指示 / worker の答え)、`message:session:{out,in}` (ccmsg の他セッション)
- `thinking` (空白のみ除外)
- `tool:<ToolName>` (use と result を `tool_use.id` で対にして 1 アイテム。Bash / Read / Edit / Grep / Agent / SendMessage / Monitor / Skill / TodoWrite … は個別フィールド、未知は `{input, result}`)
- `notice:{slash,interrupt,compact,api-error,hook,task,attachment,meta}` (csa の `I` の分解先)
- `ids` は型でなく台帳 (各アイテムが `uuid` + 型に応じた `agent_id` / `task_id` / `tool_use_id` / `msg_id` / `sid` / `cron_id` を持ち、末尾で集約)

範囲は契約既存の `since_at` / `since_uuid` / `until_at` / `until_uuid` (csa の turn 番号は派生値なので採らず、turn はアイテムの属性で出す)。opts は `types: string[]` (prefix 可、`-thinking` で除外)、`preset`。実測の注意: `tool:Bash` に exit code は記録されていない (`interrupted` / `stderr` の有無で代替)。

- [ ] a: この型体系で契約 → daemon に進んでよい
- [ ] b: 直したい型がある → 自由記述で

### DS-Q3 アイテム分類の置き場

[design/dump-kinds.md](design/dump-kinds.md) §3。dump と webui が同じ仕分けを使うのは前提で、分類コードをどこに置くか。

- [ ] a: 契約 package (`@ccmsg/protocol/transcript-items`) に分類コードを置き、daemon と webui が import (webui は生 jsonl を手元で分類。移行が小さいが、jsonl 形式の追従が契約 release に結びつく)
- [ ] b: 分類は daemon だけ、契約は型の enum + item の形の語彙のみ、daemon が型付き item を wire に流し webui は生 jsonl を読まない (推し。責務が切れ、codex の rollout 形式も daemon で吸収。代償: `transcript:<sid>` topic の意味論変更 = 契約 minor + webui Timeline モデルの作り直し)

## 確認待ち

(なし)
