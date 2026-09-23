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
- **選択肢・確認項目は `- [ ] a: …` 形式（チェックボックス + ラベル）で書く**。Q / C で記法を分けない。回答は「チェックを付ける」でも「XX-Q1a」と言葉で返すでも通る（複数まとめてチェックし「チェックしたよ」の一言で済ませる運用を想定）

</details>

## 裁定待ち

### FV-Q9: 閲覧 site の FQDN は `tmpspace.net` 側の sub でよいか

webui DR-0005 の閲覧 site は webui (`ccmsg2.kawaz-mbp16-20211217.kawaz.jp`、site = `kawaz.jp`) と**別 site** (= 別の登録可能ドメイン) に置く。hosting (canddy-app-proxy の Caddyfile) には `*.kawaz-mbp16-20211217.tmpspace.net` の wildcard が既にあり (tailnet only、WebAuthn 封じ済み、今は DR-0030 の `ccmsg-files-<sbx>` 配信に使っている)、site = `tmpspace.net` なので分離が成立する。統括の案は a。

- [ ] a: `ccmsg2-view.kawaz-mbp16-20211217.tmpspace.net` (統括が Caddy に静的配信を足し、`CCMSG_VIEW_ORIGIN` / `CCMSG_WEBUI_ORIGIN` を渡して build する)
- [ ] b: 別の名前 (指定してほしい)

## 確認待ち

### FV-C1: iPhone の PWA で `_blank` / `window.open` がどう動くか (FV-Q6 の前提)

裁定 (FV-Q6 の外へ出る経路) は「`_blank` / `window.open` は許す、PWA で動かないのは PWA の制限として受ける」だが、iPhone の PWA での実際の挙動を見てから確定する (kawaz 2026-09-19)。統括は iPhone を触れないので実機は kawaz。

手順 (1 回で足りる。`window.open` も WebKit では同じ popup 扱い): ホーム画面に追加した ccmsg の PWA で、外部 URL (`https://…`) を含む markdown を Files で開き、プレビューのリンクをタップする (md のリンクは別タブで開く作り)。

- [ ] a: Safari (別アプリ) に飛ぶ
- [ ] b: アプリ内ブラウザ (SFSafariViewController 風) で開き、閉じると PWA に戻る
- [ ] c: 何も起きない
- [ ] d: PWA 自身がその URL に遷移してしまう (= scope 外に出る、`_top` と同じ困り方)

d なら `_blank` も塞ぐ側に倒す。a / b / c なら裁定どおり許す。PWA かどうかは `matchMedia('(display-mode: standalone)')` (標準) と iOS の `navigator.standalone` で判定できるので、d の場合も「PWA の時だけ `allow-popups` を外す」という切替が取れる。同じ判定で全体設計 (ツールバーの戻る / 進む / リロードの出し分け等) を PWA 前提で切り替える余地もある (kawaz 2026-09-19)。
