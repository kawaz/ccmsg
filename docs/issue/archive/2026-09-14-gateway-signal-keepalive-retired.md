---
title: llm-gateway の合図方式 keepalive 撤去に伴う ccmsg 側の受け口撤去
status: resolved
category: task
created: 2026-09-14T17:02:13+09:00
last_read:
open_entered: 2026-09-14T17:02:13+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-09-20T23:19:36+09:00
discard_reason:
pending_reason:
close_reason: ["done: cache_keepalive / keepalive_paused / cache_paused の受け口を撤去、約束の名前は request event の cache_notice から取る経路が残り DR-0012 の窓の引き直しは動く", "done: [llm-gateway keepalive ping] を subscribe stream へ流す経路は daemon src に元から無かった", "done: 契約 v2.9.0 で cache_paused を撤去、daemon / webui とも追従済み"]
blocked_by:
origin: llm-gateway 統括セッション
---

# llm-gateway の合図方式 keepalive 撤去に伴う ccmsg 側の受け口撤去

## 概要

llm-gateway v0.48.0 (DR-0027 段階 B、2026-09-14 展開済み) で合図方式の keepalive を撤去した。ccmsg 側で不要になったものを撤去する。

## 背景

llm-gateway 側の設計変更 (合図方式 keepalive → replay ベースへの移行) に伴い、ccmsg 側が持っていた受け口が不要になった。正本は llm-gateway `docs/decisions/DR-0027-keepalive-by-replay.md` 決定 7、`docs/decisions/DR-0012` の現行記述。

撤去対象:

1. `cache_keepalive` webhook / SSE event の受け口 (gateway はもう送らない)
2. `[llm-gateway keepalive ping] nonce=…` を subscribe stream へ流す経路とその文面
3. `keepalive_paused` event と `cache_paused` 欄 (どちらも gateway 側から消えた。停止は控えを落とすだけの操作になり、状態としては残らない)。webui が `cache_paused` を読んでいるなら参照を外す

維持される event (変更不要): `cache_notice` / `cache_expired` / request event の `cache_since` `next_keepalive_at` `cache_count` `cache_until` `cache_until_count` `cache_breakeven_*` (v0.48.0 から系列の 1 本目から出る。応答が cache に乗らなかった 1 本は直後の `cache_expired` が名指しで取り消す)。

## 受け入れ条件

- [ ] `cache_keepalive` webhook / SSE event の受け口を削除
- [ ] `[llm-gateway keepalive ping] nonce=…` を subscribe stream へ流す経路と文面を削除
- [ ] `keepalive_paused` event の受け口と `cache_paused` 欄を削除
- [ ] webui が `cache_paused` を参照していないか確認、参照していれば除去
- [ ] 維持される event (`cache_notice` / `cache_expired` / `cache_since` 等) には手を入れない

## TODO

<!-- wip 時のみ -->
