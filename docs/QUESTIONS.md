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

契約 minor A (「client が見えていないものを見えるようにする」6 件を optional の足し算で 1 回に)。素材は `/tmp/ccmsg-contract-minor-draft.md`、issue は契約リポ `docs/issue/`。

### CT-Q1 say の未読をどこに載せるか

`say-unread-on-wire`。fold 由来でない値を `peers` の行に載せてよいか、が論点。

- [ ] a: `PeerInfo.say_unread_at` (一覧の行に印を出せる) (推し: 用途が一覧の印なので置き場は行)
- [ ] b: `SessionStatusSnapshot` に (1 セッションの状態としては筋が通るが一覧に印を出せない)

### CT-Q2 通知に種別を持たせるか

`notification-lacks-mid`。`reply_to` (返事の鍵) を足すのは確定。`say.post` 由来と `notify.send` 由来を型で分けるか。

- [ ] a: 分けない。`reply_to` の有無で読み手が判断 (推し: 「通知の種別」を契約の語彙にしない)
- [ ] b: `kind` の union を持つ

### CT-Q3 fold の起点を契約に載せるか

`session-status-partial-marker`。`external_files` が空を「無い」と描く実害を直す。

- [ ] a: `folded_from` (byte offset、transcript の offset 語彙をそのまま。読み手が何が欠けているか言える) (推し)
- [ ] b: `partial: boolean` (最小だが打てる手が無い)

### CT-Q4 dump を client が読む経路

`dump-file-unreadable-from-clients`。起票時の推し (a) から変わる。

- [ ] a: `FileKind` に `"dump"` の面を足す (`file.read` の既存の paging / binary / mtime を再利用。`file.edit` が書けないよう読み専用の union を切り出す) (推し: 既存の枠組みで解ける)
- [ ] b: `session.dump.read` を新設 (dump が instance に閉じることを型で表すが、読み op と paging が二重になる)

### CT-Q5 `file.read` の paging の形

`file-read-paging-and-external-listing` の (1)。(2) の外部ファイル列挙は `session.status` の `external_files` で足りるので契約変更なし (webui タスクへ)。

- [ ] a: 前向き `offset` / `max_bytes` (無指定 = 先頭で現状互換) (推し: 対象の性質に形を合わせる、を既定方針として DESIGN に明記)
- [ ] b: `transcript.read` と同形の後ろ向き `before` / `max_bytes` (契約内の既成語彙だが無指定の意味が変わる)

### CT-Q6 raw 形式の dump で `entries` / `ids` が述べるもの

`dump-raw-jsonl-format` の契約部分。`format: "items" | "records" | "text"` 引数は実装選択として決める。

- [ ] a: 選んだ item の数を述べる (ファイルの行数とは一致しない。`SessionDumpFile` 型は `items` 形式専用と明記) (推し)
- [ ] b: ファイルの行数を述べる (選択の結果が分からなくなる)

### CT-Q7 人が `inbox` を読むこと (minor B、後回し)

`inbox-invisible-to-user-and-lacks-tombstone`。現行の session 向け snapshot は返すと同時に配送済みの印を付ける。

- [ ] a: 人の読みは閲覧 (印を付けない)。同じ topic で role により副作用が違うことを契約に述べる。中身を見せる (推し)
- [ ] b: 人には件数だけ (`peers` の行に載せる)
- [ ] c: 人は読まない (`roles` から user を外す、現状維持)

## 確認待ち

(なし)
