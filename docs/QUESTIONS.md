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

### CM-Q2 TS config のファイル構成

裁定済み (2026-09-10 r298m35): config は JSON + マージ規則でなく **TS** で書く。defaults は `({builtin, config: builtin のコピー}) => config`、instance は `({builtin, default, config: default のコピー}) => config` を export し、`builtin` / `default` は immutable で渡す (= 深い / 浅いの問題が消える。v0.3.5 の `MERGE_RULES` は撤去)。残る問い:

- [ ] a: `~/.config/ccmsg/config.ts` (defaults) + `~/.config/ccmsg/instances/<name>.ts` (instance ごと 1 ファイル、自動発見。`daemon add` はテンプレを 1 ファイル生成、`remove` は削除) (推し)
- [ ] b: `config.ts` 1 ファイルで defaults と instances 配列の両方を返す (`daemon add` は使えなくなり、人が編集)

### DS-Q4 dump に worker (sidechain) の発話をどう置くか

issue [dump-sidechain-rows-placement](issue/2026-09-10-dump-sidechain-rows-placement.md) の裁定。起票後にアイテム型体系が入り、統括の dump には委譲が `message.sub.out` (Agent 呼び出し)、回答が `message.sub.in` (結果) として既に並ぶ。worker の内部 (自分の thinking / tool / 親への返答) は `sid/agent-<id>` を主語にした別 dump で読める。残る問いは、統括の dump の中に worker の内部を**入れ子で inline するか**:

- [ ] a: inline しない。統括の dump は「頼んだ / 返ってきた」の 2 行で足り、worker の中身は `ccmsg dump <sid>/agent-<id>` で別に読む (推し: 日記の「私」が統括に固定され、重複排除も要らない。既に実装済みなので issue は close)
- [ ] b: `message.sub.in` の下に worker の回答本文だけを 1 段インデントで inline する (Agent 結果は要約なので、本文が要る時に別 dump を開かずに済む)
- [ ] c: worker の thinking も含めて全部 inline する (情報量が大きく、統括の日記でなくなる)

## 確認待ち

(なし)
