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

### 👺EP-Q1: webui のホスト先と endpoint の URL 形

[DR-0001](decisions/DR-0001-passkey-auth-for-people.md) §2.3 の制約 (passkey を使う webui は endpoint と同じ registrable domain) を満たす配置。

- [ ] a (推奨): ホストごとに 1 origin `https://ccmsg.<host>.kawaz.jp/`、webui はその直下、instance はパス (`/personal/ws` `/emrd/ws` `/bare/ws`) で相乗り
- [ ] b: instance ごとにサブドメイン (`personal.ccmsg.<host>.kawaz.jp`)、webui は `--rp-id` で共通 suffix を指定
- [ ] c: 人の入口だけ LB 名 `https://ccmsg.<host>.kawaz.jp/` に集約 (mesh の `self` は instance 固有 URL のまま)

a は証明書 1 枚・caddy のパス振り分けだけで済み、mesh-peer-auth §4.2 の相乗り前提と同じ形。

### 👺EP-Q2: 名前解決と証明書の経路

- [ ] a: 既存の `*.kawaz-mbp16-20211217.kawaz.jp` と同じ (tailnet IP の DNS + caddy が DNS-01 で取得)。別 PC も同じ形
- [ ] b: tailscale の `ts.net` 名 + `tailscale cert` (サブドメインが切れないのでパス相乗り必須)

### 👺EP-Q3: 本番 config の `self` / `peers` と passkey 登録の開始

EP-Q1 / Q2 が決まったら統括が行う作業の確認。

- [ ] a: 3 instance の `~/.config/ccmsg/config.json` に `self` / `entry.origins` (webui の origin) を書き、caddy 設定を用意 (caddy の設定ファイルの場所と反映手順を教えてほしい)、`ccmsg daemon passkey add personal --name <ラベル>` を統括が発行して URL とコードを r292 に貼る

## 確認待ち

(なし)
