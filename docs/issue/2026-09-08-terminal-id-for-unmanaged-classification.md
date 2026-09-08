---
title: terminal_id を管理外 classify 判定のために埋める経路を決める
status: open
category: design
created: 2026-09-08T23:43:28+09:00
last_read:
open_entered: 2026-09-08T23:43:28+09:00
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

# terminal_id を管理外 classify 判定のために埋める経路を決める

## 概要

`AgentInfo.terminal_id` を harness の poll では埋めていない (契約は「走っているプロセスの env から読む」、poll 毎に全セッションの env を読むのはコストが見合わないため `session_rename` 時にだけ読む)。結果として `classify` の「生存 (管理外) = ccmsg とも terminal とも繋がっていない」判定で terminal 側が常に不明になり、接続していない生存セッションが必ず `live_unmanaged` になる。

## 背景

`terminal_id` を埋める経路の候補として以下がある:

- hello 時に 1 回だけ env を読む
- セッション集合の変化時にだけ env を読む
- terminal gateway 側から逆引きする

どの経路を採るかを決める必要がある。

## 受け入れ条件

- [ ] `terminal_id` を埋める経路を決定する
- [ ] `classify` の管理外判定が意図通りに動くことを確認する
