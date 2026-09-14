---
title: 直送メッセージの返信案内 `ccmsg reply <mid>` が、旧 plugin の `ccmsg` (r<N>m<M> 形式) と混同されて拒否される
status: open
category: bug
created: 2026-09-14T13:37:15+09:00
last_read:
open_entered: 2026-09-14T13:37:15+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: 別セッション (旧 plugin `claude-ccmsg` 0.152.x hook) からの報告
---

# 直送メッセージの返信案内 `ccmsg reply <mid>` が、旧 plugin の `ccmsg` (r<N>m<M> 形式) と混同されて拒否される

## 概要

別セッション (旧 plugin `claude-ccmsg` 0.152.x の hook が有効なセッション) からの報告 (2026-09-14): v2 の直送メッセージに添えられた `ccmsg reply bfa02646…/1` を実行したところ、CLI が `r<N>m<M>` 形式を要求して拒否した。そのセッションは旧 plugin の launcher (`~/.claude-personal/plugins/cache/claude-ccmsg/claude-ccmsg/<ver>/bin/ccmsg`) を `ccmsg` として使っており、v2 の CLI (`~/.local/bin/ccmsg`) と `reply` の引数形式が違う (v2: `ccmsg reply <mid> <text> [--to <sid>]`、v1: `ccmsg reply <rNmN> <msg>`)。

## 背景

移行期に 2 つの `ccmsg` が同居していて、v2 の案内文 (`src/cli.ts:486` / `src/plugin/skill.ts:30`) が「`ccmsg` が v2 に解決される」ことを前提にしているのが原因。

## 決めること

- v2 の直送メッセージと skill の案内文で、コマンドを絶対パス (plugin の launcher、または `~/.local/bin/ccmsg`) で名指すか、`ccmsg2` のような衝突しない名前にするか
- 旧 plugin が有効なセッションに v2 の直送が届く経路 (誰が届けたか) を確認し、届く以上は案内も通る形にする

## 受け入れ条件

- [ ] 旧 plugin の hook が有効なセッションで v2 の直送を受け、案内どおりに実行した返信が届く

## 関連

- 旧 plugin `kawaz/claude-ccmsg`、v2 plugin `src/plugin/`
