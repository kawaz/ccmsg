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

### DS-Q1 dump に worker (subagent) の発話をどう出すか

現行 Claude Code は worker の記録を `<sid>/subagents/agent-<id>.jsonl` に分離しており、`session_dump_write` は main しか読まないので worker の応答は dump に一切出ない ([findings](findings/2026-09-10-transcript-sidechain-format.md)、[issue](issue/2026-09-10-dump-sidechain-rows-placement.md))。

- [ ] a: 統括の turn に畳む (誰が判断したかが消える)
- [ ] b: Agent 呼び出しの子として 1 段インデント、thinking は含めず response だけ (推し。日記の「私」は統括のまま、頼んだ相手の答えとして読める)
- [ ] c: worker を除外する (判断材料が消える)

### TL-Q1 mesh の TLS は caddy 終端で足りるとして issue を閉じるか

[issue mesh-tls-trust-root](issue/2026-09-09-mesh-tls-trust-root.md) は daemon 自身に証明書を持たせる前提で書かれたが、本運用は caddy が TLS 終端し peers は `https://ccmsg-{xxx}.<host>/` で wss 到達済み。

- [ ] a: caddy 終端が正、daemon は plain ws のまま (issue を close、DESIGN に「TLS は前段の責務」と明記)
- [ ] b: daemon にも証明書設定を持たせる (caddy 無し構成を想定する場合)

### XR-Q1 cross ルート 6 本の path 名

`ccmsg2.<host>/` から各 instance へ振り分ける cross ルート (3 instance × 人 / gateway) の path 名を指定してほしい。現状は `/{personal,emrd,bare}/` だけ。

- [ ] a: 現状の `/{xxx}/` で足りる (追加不要)
- [ ] b: 別名にする → 名前を自由記述で

## 確認待ち

### NT-C1 npm token の rotate

webui-slice1 worker が `~/.npmrc` の token を transcript に出した件 (2026-09-09)。

- [ ] rotate 済み
- [ ] 当該セッション jsonl の掃除済み
