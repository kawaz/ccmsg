---
title: gateway webhook の session_id が config home でスコープされない
status: resolved
category: design
created: 2026-09-09T00:19:04+09:00
last_read:
open_entered: 2026-09-09T00:19:04+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-09-09T03:56:15+09:00
discard_reason:
pending_reason:
close_reason: ["done: v0.0.21 で gateway の活動時刻はこの instance が知る sid (接続中 / last_live / 自 config home の sessions/) にだけ効かせ、llm_requests には流す形に実装 (commit d3537f19)。§5.1 に明記"]
blocked_by:
origin: 2026-09-08 の設計監査 (fable5-high)
---

# gateway webhook の session_id が config home でスコープされない

## 概要

gateway webhook が受け取る `session_id` が config home 単位でスコープ
されていないため、別 config home に存在するセッションが「生存」している
と誤判定される可能性がある。

## 背景

2026-09-08 の設計監査で「mesh 前でなくてよい」と判定された所見の一つ。
設計文書 §5.1 と §5.2 のどちらを正とするか、設計判断が必要。

## 受け入れ条件

- [ ] §5.1 / §5.2 のどちらが正かを判断し、文書と実装を一致させる
- [ ] config home をまたいだ session_id 衝突がテストで再現・防止確認できる
