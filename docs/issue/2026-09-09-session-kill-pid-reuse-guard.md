---
title: session_kill の pid 再利用ガードが argv0 のみで startedAt 照合が無い
status: open
category: bug
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

# session_kill の pid 再利用ガードが argv0 のみで startedAt 照合が無い

## 概要

`session_kill` の pid 再利用ガードが argv0 の一致だけで判定しており、
`<pid>.json` に記録された `startedAt` と実プロセスの起動時刻を照合していない。
OS が pid を再利用した場合、無関係な別プロセスを誤って kill するリスクがある。

## 背景

2026-09-08 の設計監査で「mesh 前でなくてよい」と判定された所見の一つ。

## 受け入れ条件

- [ ] `<pid>.json` の `startedAt` と実プロセスの起動時刻を照合するガードを追加する
- [ ] pid 再利用ケースを想定したテストを追加する
