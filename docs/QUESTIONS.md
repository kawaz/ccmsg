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

### CT-Q9 セッションのライフサイクルに `starting` / `loading` を足すか (契約)

`SessionState` は `waiting` / `live` / `live_unmanaged` / `paused` / `disappeared`。kawaz の指摘 (2026-09-14): 最初の状態が来る前を分けると、(1) process (pid / hyoui) は掴めているが transcript がまだ無い (初回ディレクトリの trust 確認で TUI が止まっている等)、(2) transcript はあるが状態の畳みが終わっていない、の 2 段階に語が無い。(3) 畳み済み = `live` / `waiting`、(4) 畳み済みで process 無し = `paused` / `disappeared` は既にある。CT-Q8 は a (開始応答は畳み終えてから) で裁定済みで、その待ちの間の理由を `peers` の状態が述べる形になる。

`starting` の価値 (kawaz 2026-09-14): 「claude を起動したはずなのに webui に流れてこない」時に、起動に失敗したのか TUI で止まっているのかが分かり、TUI で止まっているなら hyoui の terminal へのリンク導線を置ける。含意: `starting` の行には挨拶も transcript も無いので、`terminal_id` は launcher / hyoui の観測から埋める (挨拶由来ではない)。行の鍵 (sid 未定の間は hyoui の sid か pid か) は契約 minor で決める。

鍵の問題 (kawaz 2026-09-14): `starting` の段階で sid は経路により未定 (`new` は `--session-id` で先に生成できる、`resume` / `fork` は引数で決まる、`--continue` は起動後に claude が決めるので先に決められない)。統括の案: `starting` の鍵は sid でなく**起動** (hyoui の `terminal_id`) にし、sid は transcript / 挨拶から取る方針に一本化。`new` の追跡は pid で結ぶ (launcher は子の pid を知る、挨拶の meta に pid を載せて一致させる)。契約は `SessionRow` を sid 必須のまま保ち、挨拶前の起動は別 topic (`launches`、鍵 `terminal_id`、pid / cwd / 経路 / 開始時刻 / `starting` | `failed`) にする。`loading` は sid 確定後なので `SessionState` に足す。`--session-id` の事前生成は URL が先に決まる利点があるので `new` で併用可 (前提にはしない)。

- [ ] a': 上の 2 段構え (`launches` topic + `SessionState.loading`) で契約 minor を起こす (統括推し)
- [ ] a: `starting` (transcript 未出現、ccmsg が起動に関与したか pid を観測できた時だけ知れる) と `loading` (transcript あり、畳み中) を足す (推し)
- [ ] b: 別の語 (`preparing` は `UndeliveredReason` に既にあるので避ける)
- [ ] c: 足さない (CT-Q8 a の待ちだけで表す)

## 確認待ち

(なし)
