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

### DS-Q2 dump のアイテム型の体系 (起草中)

kawaz 指示 (2026-09-10 r298m27): 分類は csa timeline の型 (T/U/R…) と同じ「TL アイテムの型」で、階層名 (`message:user:in` / `tool:Bash` …) を enum 的に列挙して出し分け、型ごとにテキスト表示コンポーネントを持つ。範囲は since / until。主語は main。preset は config 定義 (裁定済み)。`docs/design/dump-kinds.md` を型の体系で書き直し中。上がったら型一覧の確認を本節に差し替える。

### CW-Q1 Codex の「入力待ち」を app-server 購読で拾うか

Codex は承認待ち / 入力待ちをファイルに残さない (rollout の永続化方針が transient として落とす、sqlite の turn status は `inProgress` のみ)。知っているのは app-server の `thread/status/changed` (`WaitingOnApproval` / `WaitingOnUserInput`) で、JSON-RPC 購読が要る = §5.1 の入力 (自 config home のファイル + 自分への接続) に無い種類の上流。v0.3.0 では「Codex の waiting は検出しない (生存 (管理外) のまま、hyoui で見る)」と DESIGN に明記。

- [ ] a: 検出しないまま (増やさない。待ちは hyoui の端末リンクで見る)
- [x] b: instance が Codex の app-server を購読して waiting を拾う (上流の種類が 1 つ増える。Claude の gateway と同じ「push で来る証拠」の扱いにする)

### CM-Q1 config のマージ規則をどこに書くか

調査: [research/2026-09-10-config-merge-policy.md](research/2026-09-10-config-merge-policy.md)。現行 `settingsFor()` は **トップレベルの浅いマージ** (`{...defaults, ...instance}`): `entry` / `upstream` / `peers` は instance 側にあればフィールド丸ごと置換、入れ子の不足分は defaults から継承しない。DESIGN §8.2 はこの粒度を明記していない。先行事例 (Kubernetes strategic merge / RFC 7396 / Helm / systemd drop-in / Nix modules / .gitattributes 等) の比較表は research にある。

- [ ] a: **schema 側にフィールドパス別の規則を持つ** (推し。object は field merge、scalar / array は replace を既定、set 的な配列だけ `merge: set` のように宣言。規則は `daemon config --help` 等で利用者に見える。`peers` は「完成済み一覧」の意味から replace のまま)
- [ ] b: 値側で操作を書く (`{"$replace": [...]}` / `null` で削除、RFC 7396 系)
- [ ] c: 現行の浅いマージのまま、DESIGN §8.2 に「トップレベル置換」と明記するだけ

## 確認待ち

(なし)
