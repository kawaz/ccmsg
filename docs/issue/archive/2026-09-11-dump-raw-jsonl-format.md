---
title: dump-raw-jsonl-format
status: resolved
category: design
created: 2026-09-11T13:03:09+09:00
last_read:
open_entered: 2026-09-11T13:03:09+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-09-14T00:00:00+09:00
discard_reason:
pending_reason:
close_reason: ["契約 1.23.0 で session.dump.write に format(items|records|text) 追加、daemon v0.13.0 実装(2026-09-14)","records = 選択 item に対応する元 record を1本のjsonlで出力(1 recordから複数itemでも1行、行数≠item数)","text = daemon側でmarkdown描画","1 dumpは1 transcript(セッション本体かagent1体)に閉じるので複数ファイル出所の印は不要","entries/idsは形式に関わらず選んだitemについて述べる","CLI ccmsg dump --format","既定(format無し)は従来通りCLI側描画(--max-charsを保つため)","done"]
blocked_by:
origin: 自リポ TODO
---

# dump-raw-jsonl-format

## 概要

`dump` の出力形式を 3 つにする (kawaz 2026-09-11):

1. **item JSON** — 現行 `--json`。契約の型付き item をそのまま出す
2. **元 jsonl の型 grep** — ccmsg の分類 (`--types` / preset) で選んだ item に対応する、元の transcript record をそのまま jsonl で出す。claude jsonl を読める外部ツールに「分類だけ」貸す用途
3. **テキスト** — 現行既定の markdown

(2) は item id `<record uuid>:<index>` が元 record を指すので、選択結果から元 record を引ける。

置き場は daemon 側 `session.dump.write` の format 指定が筋。元ファイルを読めるのは daemon で、CLI が `transcript.read` で取り直すのは二度手間になる。

## 背景

kawaz からの依頼。既存の dump は item JSON / markdown の 2 形式だが、外部ツール (claude jsonl を直接読めるもの) に ccmsg の分類ロジックだけを使わせたい需要があり、元 record をそのまま返す第 3 の形式が要る。

## 決めること

- (a) main と `agent-*.jsonl` の複数ファイルにまたがる時の出所の表し方: 行に file を付けるか、ファイルごとに分けるか
- (b) 1 item が複数 record (tool の use + result 等) に対応する時は、該当 record を全部出す (= 行数が item 数と一致しなくてよい) でよいか
- (c) 契約 `session.dump.write` の args に format を足す (契約 minor)

## 受け入れ条件

- [ ] (a)(b)(c) の裁定が終わっている
- [ ] 契約 `session.dump.write` に format 引数が追加され、3 形式を返せる
- [ ] daemon 側実装が 3 形式に対応
