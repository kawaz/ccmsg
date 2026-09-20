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

### TQ-Q1: 翻訳の待ち行列を分けるか、要求ごとに予算を切るか

翻訳の待ち行列は instance 全体で 1 本なので、無関係なセッションの翻訳が互いを待つ (最悪 `MAX_MS` 120 秒 × 待ち行列長、[./issue/2026-09-14-translate-queue-instance-wide.md](./issue/2026-09-14-translate-queue-instance-wide.md))。helper は 1 行 1 答なので、1 本の helper に対する直列化自体は避けられない。統括の推しは a。

- [ ] a: helper 1 本のまま、要求ごとに予算を切る (helper を増やすと上限・増減の契機・異常時の回収という管理対象が生まれる。ただし行列の順番は変わらないので、issue の受け入れ条件を「1 要求が行列を `MAX_MS` 以上塞がない」に改める必要がある)
- [ ] b: セッション (または要求元の接続) 単位に行列を分け、helper を複数持つ (受け入れ条件のとおり「別セッションの短い翻訳が待たずに返る」が成り立つ。helper の上限と増減の契機を決める必要がある)

### FV-Q9: 閲覧 site の登録可能ドメイン (別 site にするために)

webui DR-0005 の閲覧 site は webui / endpoint と **別 site** (= 別の登録可能ドメイン、cookie の分割単位) でないと隔離が成立しない。今の hosting は全部 `*.kawaz-mbp16-20211217.kawaz.jp` で登録可能ドメインは `kawaz.jp` なので、`ccmsg2-view.kawaz-….kawaz.jp` では同じ site になる。実装 (webui v1.14.0) はビルド時定数 `CCMSG_VIEW_ORIGIN` 未設定なら閲覧機能を出さない形で入っている。

- [ ] a: kawaz が持っている別ドメインの sub を使う (例: `view.<別ドメイン>`。どれかを指定)
- [ ] b: 新しくドメインを取る
- [ ] c: 当面は閲覧機能を出さない (定数未設定のまま)

決まれば統括が Caddy (canddy-app-proxy) に静的配信を足し、`CCMSG_VIEW_ORIGIN` / `CCMSG_WEBUI_ORIGIN` を渡して build する。

### FV-Q6: 閲覧 site の CSP で script を許すか

webui DR-0005 の閲覧 site ([/Users/kawaz/.local/share/repos/github.com/kawaz/ccmsg-webui/main/docs/decisions/DR-0005-a-viewing-site-draws-files-through-a-service-worker.md](/Users/kawaz/.local/share/repos/github.com/kawaz/ccmsg-webui/main/docs/decisions/DR-0005-a-viewing-site-draws-files-through-a-service-worker.md)) は webui とも endpoint とも site が違うので、閉じ込めは site の分離で効いている。許せばビルドした docs や図が動く形で見え、許さなければ描けるのは静止した物だけ。

外へ出る経路は裁定済み (kawaz 2026-09-19): `_top` は sandbox 属性で塞ぐ (`allow-top-navigation` なし)、`_blank` / `window.open` は `allow-popups` で許す (PWA で動かないのは PWA の制限として受ける)。残るのは script の可否だけ。統括の推しは a (閉じ込めは別 site + トップレベル遷移不可 + 親経由でしかバイト列が届かない、で効いている。許した上で CSP は `default-src 'self'` 相当に絞る)。

- [ ] a: 許す (site の分離で足りるという判断)
- [ ] b: 許さない (静止した物だけ描く)
- [ ] c: 先に「閲覧 site から何が届くか」(endpoint への CORS、閲覧 site 自身の storage) を洗ってから決める

## 確認待ち

### FV-C1: iPhone の PWA で `_blank` / `window.open` がどう動くか (FV-Q6 の前提)

裁定 (FV-Q6 の外へ出る経路) は「`_blank` / `window.open` は許す、PWA で動かないのは PWA の制限として受ける」だが、iPhone の PWA での実際の挙動を見てから確定する (kawaz 2026-09-19)。統括は iPhone を触れないので実機は kawaz。

手順 (1 回で足りる。`window.open` も WebKit では同じ popup 扱い): ホーム画面に追加した ccmsg の PWA で、外部 URL (`https://…`) を含む markdown を Files で開き、プレビューのリンクをタップする (md のリンクは別タブで開く作り)。

- [ ] a: Safari (別アプリ) に飛ぶ
- [ ] b: アプリ内ブラウザ (SFSafariViewController 風) で開き、閉じると PWA に戻る
- [ ] c: 何も起きない
- [ ] d: PWA 自身がその URL に遷移してしまう (= scope 外に出る、`_top` と同じ困り方)

d なら `_blank` も塞ぐ側に倒す。a / b / c なら裁定どおり許す。PWA かどうかは `matchMedia('(display-mode: standalone)')` (標準) と iOS の `navigator.standalone` で判定できるので、d の場合も「PWA の時だけ `allow-popups` を外す」という切替が取れる。同じ判定で全体設計 (ツールバーの戻る / 進む / リロードの出し分け等) を PWA 前提で切り替える余地もある (kawaz 2026-09-19)。
