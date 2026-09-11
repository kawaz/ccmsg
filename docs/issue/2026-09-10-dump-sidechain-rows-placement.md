---
title: dump-sidechain-rows-placement
status: open
category: design
created: 2026-09-10T14:32:54+09:00
last_read: 2026-09-11T13:00:43+09:00
open_entered: 2026-09-10T14:32:54+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: 自リポ TODO
---

# dump-sidechain-rows-placement

## 概要

session_dump_write が出力する日記に、subagent (sidechain) の発話をどう配置するかを裁定する。実測結果は [Transcript の sidechain 保存形式と dump の現状](../findings/2026-09-10-transcript-sidechain-format.md) を参照。

現状、実 transcript 3 session では worker turn は `<sid>/subagents/agent-<agentId>.jsonl` に分離され、main JSONL には Agent tool use/result と progress がある。session_dump_write は main JSONL だけを読むため、この形式の worker response は落ちる。一方、main JSONL に isSidechain: true の行を置いた隔離 daemon 実測では、既定の dump は main と sidechain を同じ said_by: agent として平坦に含め、no_agent: true の場合だけ sidechain を落とした。どちらの場合も日記の読み手には統括と worker の区別や親子関係が残らない。

## 背景

選択肢は次の 3 つ。

(a) worker の response を統括の turn に畳む。日記は連続した「私」の記録として短く読めるが、統括自身の発言と委譲先の回答が混ざり、誰が判断したかを失う。

(b) worker の response を Agent 呼び出しの子として 1 段インデントする。日記の「私」は統括のまま、worker は「私が頼んだ相手の答え」として読める。親子構造の復元と、別ファイル・同一 JSONL の両保存形式に対する重複排除が必要になる。

(c) worker turn を除外する。日記の「私」は統括だけに限定できるが、統括の判断材料だった worker の回答が消え、Agent 呼び出しから後続判断へのつながりが読めない。

推奨は (b) で、thinking は含めず response だけを Agent 呼び出しの子として 1 段インデントする。日記の「私」を統括に固定しつつ、委譲した事実と受け取った回答を区別して残せるため。worker の内部思考は統括の日記ではなく、情報量も大きいため含めない。

## 受け入れ条件

- [ ] kawaz が (a)(b)(c) の扱いを裁定する
- [ ] 裁定内容を docs/DESIGN-ja.md §3.6 の dump 節へ 1 段落で記載する
- [ ] 裁定どおりに実装し、別ファイルの subagent transcript と同一 JSONL の isSidechain 行を含むテストで固定する
