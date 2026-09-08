---
title: sandbox_grant が URL を発行するが配信経路が無い
status: open
category: design
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

# sandbox_grant が URL を発行するが配信経路が無い

## 概要

sandbox_grant は capability URL を発行するが、`SandboxGrants.find` の
呼び出し元が存在せず、発行された URL を実際に配信する経路が無い。

## 背景

2026-09-08 の設計監査で「mesh 前でなくてよい」と判定された所見の一つ。
capability を撤回する (機能自体を削る) か、配信経路を実装するかの設計判断が必要。

## 受け入れ条件

- [ ] capability 撤回 or 配信実装のどちらで進めるか判断する
- [ ] 選んだ側の実装 (or 削除) を完了する
