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

### CT-Q10 session と run の分離、重複起動の凍結と制限モード (契約)

kawaz の指摘 (2026-09-14): 同じ sid のプロセスが 2 つ起動しうる (走行中の sid を resume する等)。今の daemon は `HarnessSessions.scan()` と接続を `Map<Sid, …>` で持つので後勝ちで 1 行に畳み、重複の存在自体が見えない。fork した時点以降の jsonl は信頼できず、読み位置の byte もずれる。どちらを畳むべきかは自動判断できない (新しい方がバイナリが新しい可能性がある一方、teammate は古い方が保持している等)。

方向 (統括案、kawaz と合意済みの骨子):

- **session** (鍵 sid) = transcript / fold した状態 / dump / 履歴。**run** (鍵 pid、`terminal_id` = `<scheme>:<id>` 例 `hyoui:<id>`) = 生存 / terminal / 接続 / stop・notify・message.send の宛先。`peers` の行は sid ごとに `runs: [{pid, started_at, terminal_id, route (new/resume/continue/fork)?, version?, connected (teammate / subagent / 接続の数と誰か), last_activity_at}]` を持つ
- run の状態: `starting` (sid 未定、hyoui 経由で起動した時だけ知れる) → 挨拶で sid が付く → `loading` (fold 中) → `live` / `waiting` …。CT-Q9 はここに吸収
- **重複 (run が 2 つ以上)**: `SessionState` を `duplicated` (仮) にし、fold と transcript の追記配信を止め、最後に信頼できた値を凍結表示。cache のその sid の entry は解消後に捨てて頭から畳み直す。ccmsg は自動で片方を畳まない、jsonl を修復しない、どちらが正しいかを推定しない
- **URL** `sid[.pid]` と制限モード: **制限モードは URL の形で決まる** (`sid.pid` = 制限モード、`sid` = 通常モード)。重複中かどうかは別軸。`sid` の画面は run が 1 つなら通常どおり、複数なら「どの run か」を選ばせて `sid.pid` へ。`sid.pid` の画面 (制限モード) で使えるのは判断材料の表示・terminal リンク・その run の `session.stop` (pid 必須、sid だけの stop は run が複数なら `ambiguous_run` で pid 一覧を返す)・最後に信頼できた値の凍結表示。封印は `message.send` / `notify` (inbox に保留、解消後に配る)、fold の更新、dump / file 系 op。単一化が確認されているのに `sid.pid` で来ていれば「通常モードへ戻る」案内を出して `sid` へ遷移。消えた pid の URL は「その run は終了した」を示して `sid` へ誘導

裁定が要る点:

- [ ] a: 重複中の `message.send` は inbox に保留して解消後に配る (統括推し) / 断る
- [ ] b: 判断材料の最終セット (上の `runs` の要素で足りるか、足すもの・引くもの)
- [ ] c: この骨子で契約の DR 草案を統括が起草してよいか (契約 minor: `runs`、run 状態、`duplicated`、`ambiguous_run`、`terminal_id` の scheme 形式)

## 確認待ち

(なし)
