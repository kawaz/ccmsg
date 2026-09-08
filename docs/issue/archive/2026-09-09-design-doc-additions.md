---
title: 設計文書への追記 (dumps/, 起動順, 時間閾値の根拠, hello 直列性, polled_at 省略理由, inbox at-most-once)
status: resolved
category: task
created: 2026-09-09T00:19:04+09:00
last_read:
open_entered: 2026-09-09T00:19:04+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-09-09T03:30:30+09:00
discard_reason:
pending_reason:
close_reason: ["done:v0.0.20 で DESIGN-ja/DESIGN に §1.3 時間閾値、§3.6 dumps/ と4種、§3.1 hello直列性、§4.3 at-most-once、§6.2 polled_at、§8.3 起動順を反映 (commit dc8345eb)"]
blocked_by:
origin: 2026-09-08 の設計監査 (fable5-high)
---

# 設計文書への追記 (dumps/, 起動順, 時間閾値の根拠, hello 直列性, polled_at 省略理由, inbox at-most-once)

## 概要

2026-09-08 の設計監査で「実装済みだが設計文書に反映されていない」と
指摘された項目をまとめて設計文書に追記する:

- `dumps/` を §3.6 に記載
- 起動順 (§8.3) を実装と一致させる
- 時間閾値 (`GATEWAY_LIVE_WINDOW_MS` 5min / `GRANT_MS` 30min / `DRAIN_MS`
  500ms) の根拠を明記
- hello の直列性についての記載
- `polled_at` を省略する理由の記載
- inbox snapshot が at-most-once であることの記載

## 背景

design-impl-bidirectional-check の B 方向 (設計→実装) 確認で見つかった、
実装が先行し文書が追いついていない箇所の一覧。

## 受け入れ条件

- [ ] 上記 6 項目をすべて設計文書に反映する
