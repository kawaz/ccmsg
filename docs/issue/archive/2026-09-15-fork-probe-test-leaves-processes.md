---
title: test の fork probe (偽 `claude` シェル) がプロセスを残す
status: discarded
category: bug
created: 2026-09-15T11:28:42+09:00
last_read:
open_entered: 2026-09-15T11:28:42+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered: 2026-09-15T12:14:09+09:00
resolved_entered:
discard_reason: ["v2(kawaz/ccmsg)にはfork probeのhelperが存在しない。残骸はv1(kawaz/claude-ccmsg)の起動時fork probe(2026-09-02のcommit 3d139b9aで削除済み)が削除前のtest実行で置いたもので、v2で直す対象は無い","ホスト上の残骸52プロセスは2026-09-15にpid指定で回収済み","v2のtest/harness.ts reapOrphans()はtracked rootをargvに含むプロセスを回収する一般形を既に持つ"]
pending_reason:
close_reason: ["discarded"]
blocked_by:
origin: 自リポ TODO
---

# test の fork probe (偽 `claude` シェル) がプロセスを残す

## 概要

2026-09-15 にホスト上で `ccmsg-fork-probe-*` の偽 `claude` シェル (`/bin/sh <tmp>/ccmsg-fork-probe-<id>/bin/claude …`) と `cat <tmp>/…/release` が計 52 個、12 日間 (9/2 から) 残っていた。`release` は FIFO で、test が release を書かずに終わると `cat` と、それを待つ偽 `claude` が永久に残る。test の fail や中断で cleanup が走らなかったと見られる。

## 背景

fork probe test helper が生成する偽 `claude` シェルは FIFO (`release`) への書き込みを合図に終了する設計になっている。test が正常終了しなかった場合にこの FIFO へ書き込む cleanup 経路が保証されておらず、プロセスが残置される。

## 受け入れ条件

- [ ] test を途中で kill しても `ccmsg-fork-probe-*` のプロセスが残らない (test で kill を模擬)
- [ ] `just ci` 後に `pgrep -f ccmsg-fork-probe` が 0

## TODO

<!-- wip 時のみ -->
