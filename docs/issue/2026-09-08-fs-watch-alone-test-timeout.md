---
title: fs-watch-alone-test-timeout
status: open
category: bug
created: 2026-09-08T13:39:55+09:00
last_read:
open_entered: 2026-09-08T13:39:55+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: inbox 実装中の `just ci`
---

# fs-watch-alone-test-timeout

## 概要

`test/sessions.test.ts` の「the file watch alone carries a change, with the poll too slow to help」がスイート全体を走らせた時に 5s timeout で落ちることがある (2026-09-08、inbox 実装中の `just ci` で 1 回、単体実行 3 回連続は通る)。macOS/Bun の FSEvents 遅延が原因と推定しているが未検証。

## 背景

flaky 認定で放置せず、以下を判断する:

1. fs.watch イベントの到達を観測して遅延の実測値を取る
2. テストの前提 (5s 以内に fs.watch が届く) が設計 §5.1 の「監視は取りこぼしうる」と矛盾していないか
3. テストを「watch が届いた時に poll より先に反映される」の形に変えるべきか

## 受け入れ条件

- [ ] fs.watch イベント到達の遅延実測値が取れている
- [ ] テストの前提と設計 §5.1 の整合性が判断されている
- [ ] 上記判断に基づき、テストの現状維持 or 修正のいずれかが実施されている

## TODO

<!-- wip 時のみ -->
