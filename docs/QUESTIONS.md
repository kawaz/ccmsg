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

### FV-Q6: 閲覧 site の CSP で script を許すか

webui DR-0005 の閲覧 site ([/Users/kawaz/.local/share/repos/github.com/kawaz/ccmsg-webui/main/docs/decisions/DR-0005-a-viewing-site-draws-files-through-a-service-worker.md](/Users/kawaz/.local/share/repos/github.com/kawaz/ccmsg-webui/main/docs/decisions/DR-0005-a-viewing-site-draws-files-through-a-service-worker.md)) は webui とも endpoint とも site が違うので、閉じ込めは site の分離で効いている。許せばビルドした docs や図が動く形で見え、許さなければ描けるのは静止した物だけ。

同じ CSP が iframe から外へ出る経路 (`target=_blank` / `window.open` / `top`) を塞ぐ側も持つので、1 つの表として決める。

- [ ] a: 許す (site の分離で足りるという判断)
- [ ] b: 許さない (静止した物だけ描く)
- [ ] c: 先に「閲覧 site から何が届くか」(endpoint への CORS、閲覧 site 自身の storage) を洗ってから決める

### FV-Q7: 閲覧 site の FQDN を webui はどこから知るか

閲覧 site は他のどれとも site が違う必要があり、FQDN の管理はフロント (hosting) の責務。webui はその住所を知る必要がある。

- [ ] a: ビルド時の定数
- [ ] b: instance が名乗る (契約に足す)
- [ ] c: 設定の 1 項 (人が入れる)

### FV-Q8: 閲覧 site 側が親を確かめるか

親が `postMessage` する時に `targetOrigin` を指定するのは前提として、受ける側 (閲覧 site) が「この親は webui だ」を確かめるか。確かめないと他の頁が閲覧 site を埋め込んでポートを渡せるが、渡せる物はその頁が自分で持っている接続だけ。

- [ ] a: `event.origin` を確かめる — **統括の推し**
- [ ] b: 確かめない (渡せる物が自分の接続だけなので実害が無い)

## 確認待ち

(なし)
