---
title: mesh の cut テストが時々落ちる (先行して存在する race)
status: open
category: bug
created: 2026-09-15T12:54:07+09:00
last_read: 2026-09-15T13:05:35+09:00
open_entered: 2026-09-15T12:54:07+09:00
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

# mesh の cut テストが時々落ちる (先行して存在する race)

## 概要

`test/mesh.test.ts` の "a peer this host has stopped being one of is cut, and stays cut" が時々落ちる。単体実行でも `just ci` でも再現する、先行して存在する race。

## 背景

2026-09-15、worker の実測: 単体 5 回で 1 回、`just ci` 4 回で 1 回 fail。当該 worker の変更を含まない baseline (`f9840fca`) を別 workspace に出して同じ 5 回を回しても 1 回落ちたので、worker の変更由来ではなく先行して存在する race。

### 真因の仮説 (未確定)

mesh の再接続 (20 ms) と test の `Bun.sleep(200)` の競合。cut された peer が sleep の間に再接続の試行を挟み、「stays cut」の assert 時点で link の状態が期待と違う。

### 直すこと

`test-integrity` rule に従い flaky 扱いにせず真因を確定する。再接続の試行と cut の順序を決定的にする (test 側が「再接続の試行が 1 回済んだ」事象を待つ、または mesh 側が cut 後の再接続を開始しない不変条件を持つ)。sleep を伸ばして通すのは不可。

## 受け入れ条件

- [ ] 単体 50 回連続で pass
- [ ] `just ci` 10 回で pass
- [ ] 真因が findings か test コメントに書いてある

## 関連

- `test/mesh.test.ts`、`src/mesh/mesh.ts` の再接続と cut
