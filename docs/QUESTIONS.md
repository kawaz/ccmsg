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

### 👺EP-Q4: `ccmsg.<host>.kawaz.jp` は今 旧 daemon (8642、旧 webui + room) に向いている

新系の人の入口をこの名前にすると旧 webui が見えなくなる。

- [ ] a (推奨): 旧系を `ccmsg-old.<host>.kawaz.jp` に退避し、`ccmsg.<host>` を新系へ (旧 room は旧 URL で読める。DR-0032 §2.2「切替は一気に」)
- [ ] b: 新系の入口を当面 `ccmsg2.<host>.kawaz.jp` にし、日常利用が移ってから入れ替え

### 👺EP-Q5: 新 webui の静的ファイルの配信先

daemon は webui を配信しない ([DR-0032](https://github.com/kawaz/claude-ccmsg/blob/main/docs/decisions/DR-0032-repo-split-protocol-first.md) §2.1)。caddy の `ccmsg.<host>/` ルートを `file_server` にする必要がある。

- [ ] a (推奨): canddy-app-proxy の justfile に `webui-build` を足し、`~/.local/share/repos/github.com/kawaz/ccmsg-webui/main` で `bun run build` した `dist/` を caddy の `root` に指す (worktree 直参照、更新は `just webui-build` + reload)
- [ ] b: webui リポの release で `dist` を tarball 化し、canddy-app-proxy 配下に展開して固定

## 確認待ち

(なし)
