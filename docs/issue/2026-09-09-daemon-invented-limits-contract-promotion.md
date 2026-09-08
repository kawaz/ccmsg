---
title: daemon 発明の上限値 (TITLE_MAX / READ_LIMIT 等) を契約に昇格すべきか
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

# daemon 発明の上限値 (TITLE_MAX / READ_LIMIT 等) を契約に昇格すべきか

## 概要

daemon 実装が独自に決めている上限値 (`TITLE_MAX` / `READ_LIMIT` /
`transcript_read` の既定 max 等) が、設計文書上の契約になっていない。
実装詳細のままでよいか、正式な契約 (設計文書の一部) に昇格すべきかの
判断が必要。

## 背景

2026-09-08 の設計監査で「mesh 前でなくてよい」と判定された所見の一つ。

## 受け入れ条件

- [ ] 各上限値について契約化すべきか実装詳細のままでよいか判断する
- [ ] 契約化すると判断したものは設計文書に反映する
