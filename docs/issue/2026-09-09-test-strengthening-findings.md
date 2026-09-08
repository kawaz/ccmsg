---
title: テスト強化の積み残し (M3 タイマー根拠テスト / M4-M6 実 op 呼び出し / fake が実装仮定を写している問題)
status: open
category: task
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

# テスト強化の積み残し (M3 タイマー根拠テスト / M4-M6 実 op 呼び出し / fake が実装仮定を写している問題)

## 概要

2026-09-08 の設計監査で指摘されたテスト設計上の弱点:

- M3 のタイマー一覧とその根拠を検証するテストが無い
- M4/M6 のテストが実際に op を呼んでいない (モックで済ませている疑い)
- delivery/direct テストの fake (`FakeSessions` の分類注入、`FakeHarness`
  の `peer_message_status`) が実装の仮定をそのまま写してしまっている
  (= fake が実装のバグごと固定化するリスク)

## 背景

`tdd-and-test-design` 観点で、テストが「動く仕様書」になっているかの検査で
見つかった問題。

## 受け入れ条件

- [ ] M3 タイマー一覧の根拠テストを追加する
- [ ] M4/M6 で実際に op を呼ぶテストに書き換える
- [ ] delivery/direct テストの fake を実装から独立した仕様ベースに見直す
