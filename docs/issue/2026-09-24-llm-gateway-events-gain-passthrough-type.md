---
title: llm-gateway の events / webhook に新しい種類 `passthrough` が増える (受け手は未知の種類を無視できるか)
status: open
category: task
created: 2026-09-24T13:48:26+09:00
last_read:
open_entered: 2026-09-24T13:48:26+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: llm-gateway
---

# llm-gateway の events / webhook に新しい種類 `passthrough` が増える (受け手は未知の種類を無視できるか)

## 概要

llm-gateway の次のリリース (v0.57.0 予定、DR-0030 の汎用パススルー route) から、`/llm-gateway/events` の SSE と webhook のバッチに、既存の `request` / `response` / `cache_expired` に加えて **`passthrough`** という種類の知らせが流れる。SSE の event 名は `passthrough`、JSON の欄は `ts` / `seq` / `boot` / `ns` / `upstream` / `method` / `path` / `status` / `duration_ms` / `secret` (id のみ、値は載らない)。既存 3 種の JSON の形は変わらない。

## 背景

llm-gateway 側で汎用パススルー route (DR-0030) を追加するにあたり、その通過ログも既存の events / webhook のストリームに乗せる方針になった。受け手側 (ccmsg) が型分岐で未知の種類を落とさず無視できる実装になっているかを事前に確認したい。llm-gateway 側では DR-0012 に「受け手は知らない種類の知らせを無視する」を明記する予定。

## 確認してほしいこと

- ccmsg の受け手 (webui のリング、webhook の受け口) が **知らない種類の知らせを無視して落ちない**か (型で分岐している箇所で `_ =>` があるか、JSON parse が未知の `type` で失敗しないか)
- 無視できない箇所があれば、llm-gateway 側で webhook の種類を絞る変更も可能なので llm-gateway に返してほしい

## 受け入れ条件

- [ ] ccmsg が `passthrough` の知らせを受けても既存の表示・処理が壊れないことを確認 (または壊れる箇所を llm-gateway に報告)
