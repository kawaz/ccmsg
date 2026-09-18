---
title: 全体テスト走行中に terminals.test.ts が 1 回だけ timeout する
status: open
category: bug
created: 2026-09-18T11:31:55+09:00
last_read:
open_entered: 2026-09-18T11:31:55+09:00
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

# 全体テスト走行中に terminals.test.ts が 1 回だけ timeout する

## 概要

2026-09-18、DR-0030 の daemon 反映中に観測 (auth とは無関係)。全体テストで 1 回だけ `test/terminals.test.ts` の "say a terminal opened and closed, and say so before they exist" が 5004ms で timeout した。その後 3 回連続実行と単体実行では通っている。原因は未特定 (調査未完了)。

## 背景

test-integrity により flaky 扱いにしない。待っている事象 (hyoui socket dir の `fs.watch` の発火、terminals topic の snapshot) が固定 timeout に頼っていないか確認し、事象で待つ形に直す。

## 受け入れ条件

- [ ] 全体走行 10 回で当該 test が pass する
- [ ] timeout 値に依存しないことがコードで示せる (固定 timeout ではなく事象で待つ実装になっている)
