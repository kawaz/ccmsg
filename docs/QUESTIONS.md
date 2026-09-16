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

### CT-Q13 DR-0027 / DR-0028 の監査で出た 3 点 (契約 + daemon)

fable-high の監査 (`/tmp/contract-origin-audit.md`) で、裁定の文からは決まらない点が 3 つ。α / β / γ は独立。

α: **`Origin` を送らない client が access token で接続してきた時**。DR-0027 の案は「非 browser client は束縛の対象外」だが、access token で開く接続は browser の person client だけ (CLI は UDS) なので、免除すると却下案 c (origin 束縛なし) が非 browser に限って復活する。

- [ ] α-a: `Origin` 不在は不一致として upgrade を拒否する (統括推し。token を持つのは browser だけなので免除する相手が居ない)
- [ ] α-b: 不在は束縛の対象外として通す (DR-0027 の現状)

β: **既存の credential record (origin フィールドが無い) の扱い**。契約は `origin` 必須なので古い record は `auth.records` で schema に落ちる。

- [ ] β-a: 契約は必須のまま、daemon が読む時に不在の `origin` を endpoint の origin で埋める (統括推し。旧 record は page origin = endpoint の時に登録されたものなので推測ではなく事実。`rp_id` の Optional も同じ扱いで外せる)
- [ ] β-b: 契約側で `origin` を Optional にして不在は endpoint の origin とみなす (契約に旧形式の名残が残る)
- [ ] β-c: 旧 record を捨てて登録し直す (4 instance とも kawaz の手元なので可能だが、設計としては a で足りる)

γ: **CORS の許可集合に足した「生きている登録 URL が名指す origin」を、受け手 instance が知る手段**。preflight と最初の `auth.challenge` は登録 token を運ばず、DR-0021 は登録 URL の検査を発行者だけに限り、DR-0020 の複製 record は credential / family の 2 種だけ。endpoint の後ろに複数 instance (LB) が居ると、発行者以外は登録 URL の origin を知らない。

- [ ] γ-a: 登録 URL は発行 instance の endpoint を名指し、登録はその instance にしか届かない前提を DR に明記する (統括推し。今の運用は 1 endpoint = 1 instance で、LB 下の複数 instance は設計に無い。要る時に複製を足す)
- [ ] γ-b: 未消費の登録 (token と origin) も複製 record に加える (DR-0020 の 2 種を 3 種に)


## 確認待ち

(なし)
