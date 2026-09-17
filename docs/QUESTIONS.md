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

### CU-Q1〜Q6 契約 DR-0030 (identity はユーザ、instance は所有物、💭 提案) の未決

契約 `docs/decisions/DR-0030-identity-is-a-user-who-owns-instances.md` §未決。各項の a が統括推し。

CU-Q1 refresh の rotate をどの instance でもできるようにするか (HA で発行 instance が落ちている時)
- [ ] a: 所有者の instance ならどこでも rotate できる。悪い面: 並行 rotate の世代競合を LWW で決めると、消えた側の提示が replay と区別できず family の失効が誤発火しうる (猶予中の前世代を複数許して緩めると replay 検知が弱まる)
- [ ] b: 現行 (`iss` だけが書き、他は転送)。`iss` が落ちている間は refresh できず再 assert (UV) に落ちる

CU-Q2 一覧 op の名前
- [ ] a: `auth.account.read` (ユーザ / passkey / 所有 instance の 3 つを答えるので、どれか 1 つを名前にしない)
- [ ] b: `auth.self.read` / `auth.user.read` / `auth.credentials.read` のどれか

CU-Q3 所有を外す操作を誰が持つか
- [ ] a: CLI と認証済みチャンネルの両方。ただし「今入っている instance の所有を自分で外す」は塞ぐ
- [ ] b: CLI だけ

CU-Q4 ユーザが `display_name` を持つか
- [ ] a: 持つ (所有者が複数いる instance の一覧で user id 22 文字だけでは見分けられない)
- [ ] b: 持たない

CU-Q5 1 つの instance が複数の所有者を持ってよいか
- [ ] a: よい (所有 record は複数行、`granted_by` を持つ)
- [ ] b: 1 人だけ (record は instance ごとに 1 行の上書き)

CU-Q6 `auth.enroll` (2 台目の instance をユーザに紐付ける) でも 6 桁を要るか
- [ ] a: 要る (assert は「本人か」を確かめるだけで、「この instance を足すと今その端末で判断したか」は 6 桁が唯一の材料)
- [ ] b: 要らない (URL の所持 + 既存 passkey の UV で足りる)

### WS-Q3 webui の画面全体の状態機械 (webui DR-0004、💭 提案) の未決

webui `docs/decisions/DR-0004-one-state-machine-decides-what-the-screen-is.md` §7。8 つの姿 (offline / registering / authenticating / connecting / receiving / live / stale / outdated) を `phase` (computed 1 本) が答え、`App.tsx` は switch するだけ。各項の a が統括推し。

WS-Q3 接続済みで workspace を見ている最中に、同じタブで登録 URL (`…/#register=…`、例: 2 本目の passkey を足す) を開いたら画面をどうするか
- [ ] a: 登録画面を上に重ね、workspace は後ろに残す。接続も切らない (画面にあるものを消さない)
- [ ] b: 今の実装のまま、workspace を登録画面に置き換える (やめると戻る)


## 確認待ち

(なし)
