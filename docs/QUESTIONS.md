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

### CT-Q12 origin と endpoint を分けた時、refresh token の置き場をどうするか (契約 + daemon + webui)

CT-Q11 = a の反映中に判明。裁定メモの「cookie は使っていない」は誤りで、契約 (`src/common/auth.ts`、DR-0020) は refresh token を **endpoint が Set-Cookie する cookie** と定めている (access token だけが本文、refresh は HttpOnly cookie で browser が送る)。page の origin が endpoint と別になると、この cookie は third-party cookie になり、Safari (ITP) と Chrome の既定で送られない。DR-0027 は cookie に触れずに書かれているので、決めるまで契約 v2.2.0 は push しない。

- [ ] a: cookie のまま、`SameSite=None; Secure; Partitioned` (CHIPS) にする。cookie は top-level site (= hosting origin) ごとに分かれるので、credential が origin ごとに 1 つという CT-Q11 の形とそのまま重なる。HttpOnly が保てる。悪い面: 対応 browser が限られる (Chrome 114+、Firefox 131+、Safari は新しめ) ので、未対応 browser では毎回 passkey で assert し直しになる (統括推し)
- [ ] b: refresh token を本文で返し、page が hosting origin の storage に持つ。browser を選ばない。悪い面: HttpOnly が無くなり、hosting site の XSS で refresh token ごと取られる (CT-Q11 の「どこかから読んだ webui のコードに token を渡す」の被害が refresh の寿命まで伸びる)
- [ ] c: refresh token を廃止し、access token が切れたら passkey で assert し直す。最も単純で漏れる物が減る。悪い面: 寿命ごとに user verification が要る (寿命を長くすれば漏れた時の被害が伸びる)


## 確認待ち

(なし)
