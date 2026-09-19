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

外へ出る経路は裁定済み (kawaz 2026-09-19): `_top` は sandbox 属性で塞ぐ (`allow-top-navigation` なし)、`_blank` / `window.open` も `allow-popups` なしで封じる (PWA では元々動かない)。残るのは script の可否だけ。統括の推しは a (閉じ込めは別 site + トップレベル遷移不可 + 親経由でしかバイト列が届かない、で効いている。許した上で CSP は `default-src 'self'` 相当に絞る)。

- [ ] a: 許す (site の分離で足りるという判断)
- [ ] b: 許さない (静止した物だけ描く)
- [ ] c: 先に「閲覧 site から何が届くか」(endpoint への CORS、閲覧 site 自身の storage) を洗ってから決める

## 確認待ち

(なし)
