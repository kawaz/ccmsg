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

### CT-Q11 webui の origin と instance の endpoint を分けられるようにするか (契約 + daemon + webui)

kawaz 2026-09-16: webui で開いている URL と接続先 endpoint は異なってよいはず。CORS / cookie / CSP / 攻撃の可能性まで含めて設計拡張を検討。

層ごとの整理: WS 接続には CORS が効かず (ブラウザは `Origin` を送るだけ)、認証は subprotocol の token (契約は `Origin` を見ない)。HTTP の認証 op (passkey register / assert / token refresh) には CORS が効く。cookie は使っていないので cross-site cookie の問題は無い。webui の CSP `connect-src` は allowlist で build するか全許可。本質は信頼の向きが逆転すること (今: endpoint が配る webui を信じる → 分けると: どこかから読んだ webui のコードに自分の instance の token を渡す)。daemon で防げるのは origin 束縛と CORS allowlist まで。

- [ ] a: 分ける。instance の設定に許可 origin の一覧を持ち、credential を (endpoint, origin) に束ねる (`Origin` はページ JS が偽装できない。非ブラウザ client は UDS / mesh の別経路)。HTTP 認証 op はその一覧で CORS に答える。webui は `connect-src` を allowlist で build。一覧に無い origin からの登録・接続は断る (統括推し。信頼の境界を「許可した origin」に置く形)
- [ ] b: 分けない (endpoint が配る webui だけ)。現状維持
- [ ] c: 分けるが origin 束縛は入れない (token だけ)。漏れた token を他 origin のページから使える経路が残る

## 確認待ち

(なし)
