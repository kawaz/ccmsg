---
title: 全体テスト走行中に terminals.test.ts が 1 回だけ timeout する
status: resolved
category: bug
created: 2026-09-18T11:31:55+09:00
last_read:
open_entered: 2026-09-18T11:31:55+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-09-19T13:17:22+09:00
discard_reason:
pending_reason:
close_reason: ["done: DirectoryWatch が未作成ディレクトリ後発作成時に対象 watcher を再 arm せず socket 作成を永久に観測できなかった真因を特定、確認時と後発 watcher arm 直後の両方に再arm+再読の補償を追加 (37d42a97)、test を固定5秒競争から通知契機の観測に変更、bun test 10連続 1221 pass/0 fail・対象テスト20回反復 280 pass/0 fail で確認"]
blocked_by:
origin: 自リポ TODO
---

# 全体テスト走行中に terminals.test.ts が 1 回だけ timeout する

## 概要

2026-09-18、DR-0030 の daemon 反映中に観測 (auth とは無関係)。全体テストで 1 回だけ `test/terminals.test.ts` の "say a terminal opened and closed, and say so before they exist" が 5004ms で timeout した。その後 3 回連続実行と単体実行では通っている。原因は未特定 (調査未完了)。

2026-09-18、auth.signout 実装中にも全体走行 (`just ci`) で 1 回だけ 1 fail を観測した。テスト名は取得できず (tail のみ確認、ログ未保存)。以後 `bun test` 3 連続 + `just ci` 1 回の計 4 走行はいずれも 1215 pass 0 fail。同型の単発 timeout かは未確認 (調査未完了)。

## 背景

test-integrity により flaky 扱いにしない。待っている事象 (hyoui socket dir の `fs.watch` の発火、terminals topic の snapshot) が固定 timeout に頼っていないか確認し、事象で待つ形に直す。

## 受け入れ条件

- [ ] 全体走行 10 回で当該 test が pass する
- [ ] timeout 値に依存しないことがコードで示せる (固定 timeout ではなく事象で待つ実装になっている)
