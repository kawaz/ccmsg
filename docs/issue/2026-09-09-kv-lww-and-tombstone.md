---
title: kv の LWW (updated_at 後勝ち) と delete の tombstone が未実装
status: open
category: task
created: 2026-09-09T00:19:04+09:00
last_read:
open_entered: 2026-09-09T00:19:04+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: 2026-09-08 の設計監査 (fable5-high)
---

# kv の LWW (updated_at 後勝ち) と delete の tombstone が未実装

## 概要

kv ストアの LWW (last-write-wins、`updated_at` 後勝ち) と delete 時の
tombstone が未実装。mesh の mirror 前提を満たすために必要な仕組み。

## 背景

2026-09-08 の設計監査で「mesh 前でなくてよい」と判定された所見の一つ。
mesh 実装に着手する前に解消しておく必要がある。

## 受け入れ条件

- [ ] `updated_at` ベースの LWW マージを実装する
- [ ] delete 操作が tombstone を残す形に実装する
- [ ] mirror シナリオを想定したテストを追加する
