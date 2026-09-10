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

### DS-Q1 dump のタイプ大分類

起草: [design/dump-kinds.md](design/dump-kinds.md)。用途 = 5 軸 (発話者 / 種別 / 範囲 / 付随物 (id 台帳) / subagent 配置) の既定値セット (preset) として整理。id 台帳は agent / background Bash / Monitor / TODO / cron / session が transcript の構造化 field から取れ、ccmsg の room / sid は Bash 文字列にしか無いので取れない。

- [ ] a: 大分類は 日記 / 引き継ぎ / 監査 / 抜粋 の 4 種でよい (監査・抜粋は構造から導いたもので実需未確認。不要なら「日記 / 引き継ぎ の 2 種」と返して)
- [ ] b: preset 名は `journal` / `handoff` / `audit` / `excerpt` (推し。preset を持たず軸だけ、も可)
- [ ] c: preset 無指定の既定は 日記 (推し。現状の平坦な全部入りを既定に残す、も可)
- [ ] d: subagent 配置の既定は「Agent 呼び出しの子として 1 段インデント、response のみ」(推し)

### CW-Q1 Codex の「入力待ち」を app-server 購読で拾うか

Codex は承認待ち / 入力待ちをファイルに残さない (rollout の永続化方針が transient として落とす、sqlite の turn status は `inProgress` のみ)。知っているのは app-server の `thread/status/changed` (`WaitingOnApproval` / `WaitingOnUserInput`) で、JSON-RPC 購読が要る = §5.1 の入力 (自 config home のファイル + 自分への接続) に無い種類の上流。v0.3.0 では「Codex の waiting は検出しない (生存 (管理外) のまま、hyoui で見る)」と DESIGN に明記。

- [ ] a: 検出しないまま (増やさない。待ちは hyoui の端末リンクで見る)
- [ ] b: instance が Codex の app-server を購読して waiting を拾う (上流の種類が 1 つ増える。Claude の gateway と同じ「push で来る証拠」の扱いにする)

## 確認待ち

(なし)
