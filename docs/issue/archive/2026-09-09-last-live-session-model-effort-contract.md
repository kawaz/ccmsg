---
title: LastLiveSession.model/effort が契約に反し hello meta を凍結している
status: resolved
category: bug
created: 2026-09-09T00:19:04+09:00
last_read:
open_entered: 2026-09-09T00:19:04+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-09-09T04:20:57+09:00
discard_reason:
pending_reason:
close_reason: ["implemented: v0.0.22 で fold が最後の assistant turn の model/effort を出し、last_live は fold 優先・hello meta を fallback に (commit 8d1d74e7)。tail が回っていない session は greeting 由来のまま (last_user_input_at と同じ設計)"]
blocked_by:
origin: 2026-09-08 の設計監査 (fable5-high)
---

# LastLiveSession.model/effort が契約に反し hello meta を凍結している

## 概要

`LastLiveSession.model` / `.effort` は「transcript の最後の turn から読む」
契約のはずだが、実装は hello 時点の meta を凍結して使い続けており、
以降の turn でモデル / effort が変わっても反映されない。

## 背景

2026-09-08 の設計監査で「mesh 前でなくてよい」と判定された所見の一つ。

## 受け入れ条件

- [ ] `LastLiveSession.model/effort` を transcript の最後の turn から読むよう修正する
- [ ] turn 中に model/effort が変わるケースのテストを追加する
