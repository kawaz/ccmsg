---
title: InstancePingResult.network が常に unknown で NetOnlineEvent が未発行
status: resolved
category: bug
created: 2026-09-09T00:19:04+09:00
last_read:
open_entered: 2026-09-09T00:19:04+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-09-09T04:20:58+09:00
discard_reason:
pending_reason:
close_reason: ["done: v0.0.22 で network を mesh の到達状況から導出 (off / unknown / online / offline)、net_online は反転時に両方向で 1 回 (commit 8d1d74e7)"]
blocked_by:
origin: 2026-09-08 の設計監査 (fable5-high)
---

# InstancePingResult.network が常に unknown で NetOnlineEvent が未発行

## 概要

`InstancePingResult.network` が常に `unknown` を返し、`NetOnlineEvent` が
実装で発行されていない。

## 背景

2026-09-08 の設計監査で「mesh 前でなくてよい」と判定された所見の一つ。

## 受け入れ条件

- [ ] `InstancePingResult.network` が実際のネットワーク状態を返すよう実装する
- [ ] `NetOnlineEvent` を適切なタイミングで発行する
- [ ] オンライン/オフライン遷移のテストを追加する
