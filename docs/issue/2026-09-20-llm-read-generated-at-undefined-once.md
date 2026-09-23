---
title: llm-read-generated-at-undefined-once
status: open
category: bug
created: 2026-09-20T22:50:31+09:00
last_read: 2026-09-24T00:52:04+09:00
open_entered: 2026-09-20T22:50:31+09:00
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

# llm-read-generated-at-undefined-once

## 概要

`test/llm-read.test.ts:146` が full run で 1 回だけ失敗した観測記録。現象: `expect(answer.generated_at).toBe(NOW)` が `Received: undefined` で落ちた (= `llm.usage.read` が ok:true 以外を返したか、gateway の document が届かなかった)。実出力は「Received: undefined / at <anonymous> (test/llm-read.test.ts:146:33)」で、同一 run の他 1220 件は pass。

## 背景

発生は 2026-09-20 の daemon issue バッチ作業中 (sandbox capability 撤去の commit 直前の ci)。変更範囲は files / upstream keepalive / auth store で llm-read とは無関係。

再現状況: 同ファイル単独実行 (`bun test test/llm-read.test.ts`) で 7 pass、その後の `just ci` の full run 4 回すべて green で再現せず。原因未特定 (fakeGateway の起動と最初の取得が競合する疑いがあるが未調査)。flaky として片付けず、次に落ちた時のために観測を残す。

## 受け入れ条件

- [ ] 失敗時に `llm.usage.read` が何を返したか (error code / 本文) が分かる形で記録できていること
- [ ] 再現条件が特定できていること

## TODO

<!-- wip 時のみ -->
