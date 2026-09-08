---
title: session_status の fold が workspace_folders 等を常に空にし containment を誤判定させる
status: resolved
category: bug
created: 2026-09-09T00:19:04+09:00
last_read:
open_entered: 2026-09-09T00:19:04+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-09-09T02:32:31+09:00
discard_reason:
pending_reason:
close_reason: ["done: v0.0.17 で fold が external_files/todos/background/teammates/workflows/agent_tree を導出、workspace_folders は .code-workspace から読む (commit 9508beb6)", "note: 窓外/宣言なしの区別は protocol issue へ"]
blocked_by:
origin: 2026-09-08 の設計監査 (fable5-high)
---

# session_status の fold が workspace_folders 等を常に空にし containment を誤判定させる

## 概要

session_status の fold 処理が `api_error` と `last_user_input_at` しか
埋めておらず、`workspace_folders` / `external_files` / `todos` /
`agent_tree` が常に空になる。結果として containment の workspace / external
面が常に `path_forbidden` と判定される。

## 背景

2026-09-08 の設計監査で「mesh 前でなくてよい」と判定された所見の一つ。

## 受け入れ条件

- [ ] fold 処理で workspace_folders / external_files / todos / agent_tree を実データから埋める
- [ ] containment 判定が実データに基づいて正しく動くことをテストで確認する
