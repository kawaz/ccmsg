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

### WU-Q3 webui のキーバインドの修飾キーの綴り (webui DR-0003 §5 Q4)

研究: webui `docs/research/2026-09-17-key-binding-notation.md`。Command と Control は論理 OR でまとめない (mac では別キー)。抽象指定は「今の platform の主要修飾子 1 つに解決」の意味 (Electron `CommandOrControl` / Zed `platform-`)。

- [ ] a: `Primary` + 個別指定 (`Meta` / `Ctrl`) を併設。`Primary` は mac では Meta、他では Control の 1 つに解決。内部は `{ code, modifiers }`、入力は `Primary+Shift+KeyK` (`CmdOrCtrl` を入力の別名に)、表示は mac `⌘⇧K` / 他 `Ctrl+Shift+K`、照合は `KeyboardEvent.code`。悪い面: 抽象語 1 つを覚える、platform 解決の規則が内部に増える (統括推し)
- [ ] b: OS 別の既定表 (`Meta+…` と `Ctrl+…` だけ、設定 section を OS ごとに)。悪い面: 同じ意図を二度書く、持ち運び時に欠落
- [ ] c: 個別指定だけの単一表。悪い面: 同じ action に重複 binding、一覧が冗長
- 正規名を `Primary` でなく `CmdOrCtrl` にする案もあり (長いが意味が自明)

## 確認待ち

(なし)
