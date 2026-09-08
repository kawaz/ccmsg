---
title: 各種堅牢化の積み残し (lock 競合窓 / readSlice 多バイト境界 / regex ReDoS / file_read 全読み / topics クロージャ蓄積)
status: resolved
category: bug
created: 2026-09-09T00:19:04+09:00
last_read:
open_entered: 2026-09-09T00:19:04+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-09-09T03:56:18+09:00
discard_reason:
pending_reason:
close_reason: ["done:v0.0.21 で lock の競合窓 / readSlice の多バイト境界 / regex 検索の時間予算 (2s、実測根拠) / file_read の上限読み / onClose の 1 回登録を実装 (commit d3537f19)"]
blocked_by:
origin: 2026-09-08 の設計監査 (fable5-high)
---

# 各種堅牢化の積み残し (lock 競合窓 / readSlice 多バイト境界 / regex ReDoS / file_read 全読み / topics クロージャ蓄積)

## 概要

2026-09-08 の設計監査で指摘された、個別 issue を立てるほどではないが
放置すべきでない堅牢化項目のまとめ:

- ロック取得の競合窓 (`openSync` の `wx` フラグと pid 書き込みの間に隙がある)
- `readSlice` の多バイト文字境界処理
- `session_search` の regex が ReDoS を起こしうる
- `file_read` が対象を全読みしている (部分読みへの余地)
- topics の `onClose` クロージャが蓄積し続ける (leak の懸念)

## 背景

いずれも「mesh 前でなくてよい」と判定されたが、放置すると個別に踏み抜く
リスクがある堅牢化項目。まとめて棚卸しし、必要なら個別 issue に分割する。

## 受け入れ条件

- [ ] 各項目について実際にリスクがあるか確認する
- [ ] 修正が必要な項目を洗い出し、必要なら個別 issue に切り出す
- [ ] 対応不要と判断した項目は理由を明記する
