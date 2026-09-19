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

## 方針: 撤回で進める

判断は済んでいる。**capability を撤回する側**で閉じる (根拠: ccmsg-webui `docs/decisions/DR-0005-a-viewing-site-draws-files-through-a-service-worker.md` §2.4)。

webui はファイルを、webui とも endpoint とも site の違う閲覧 site で描く。その site には親頁から `MessageChannel` のポートが 1 本渡るだけで、バイト列は親が接続中のチャネルの `file.read` で取って返す。**権限は「親がそのセッションに接続していて `file.read` を通せること」そのもの**なので、URL に権限を載せる仕組みが要らない。

URL に権限を載せる形は、漏れれば権限も漏れる・失効を別に設計する必要がある・history と Referer に残る、を引き受けることになるが、上の形はそのどれも持たない。

撤回の実装 (`SandboxGrants` とその周辺の削除) はこの issue の範囲。

## 受け入れ条件

- [x] capability 撤回 or 配信実装のどちらで進めるか判断する (撤回。上記「方針」)
- [ ] 選んだ側の実装 (or 削除) を完了する
