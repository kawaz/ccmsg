---
title: auth の WS テストが並行実行下でポート衝突して落ちる
status: resolved
category: bug
created: 2026-09-15T13:02:52+09:00
last_read:
open_entered: 2026-09-15T13:02:52+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-09-15T13:43:08+09:00
discard_reason:
pending_reason:
close_reason: ["done: v1.1.0 で test/mesh.ts の leasePort() (kernel に空きを取らせて release してから bind) に統一 (commit 88e6dd9a)。test/auth.test.ts と test/client-address.test.ts の連番採番を置換。just ci 4 回連続 pass"]
blocked_by:
origin: ccmsg TODO
---

# auth の WS テストが並行実行下でポート衝突して落ちる

## 概要

`just ci` の全ファイル並行実行で `test/auth.test.ts` の "a POST carrying no
Origin is refused" が `serveWs` (`src/transport/ws.ts:65`) の bind で失敗する。
同ファイル単体実行 (`bun test test/auth.test.ts`) は 35 pass で通り、`just ci`
再実行でも通ることがある。

## 背景

原因は flaky ではなく、ポートの排他が無いこと。

- `test/auth.test.ts:46` が `let nextPort = 45_000 + Math.floor(Math.random() * 10_000)`
  で基点をランダムに選び、以降 +1 していくだけ
- 同時に走る他のテストファイルや同一マシン上の他プロセスが既に握っている
  ポートを踏むと `EADDRINUSE` で落ちる
- `test/client-address.test.ts:148` も `let nextPort = 39_820` の固定基点で同種の構造

方向性 (採否・実装は未検討、フラグのみ):

- `port: 0` で bind して実際に割り当たった番号を読む
- または bind の失敗を検知して次のポートで retry する

## 受け入れ条件

- [ ] `test/auth.test.ts` と `test/client-address.test.ts` のポート採番が、他プロセス
      や他テストファイルとの並行実行下でも衝突しない
- [ ] `just ci` の並行実行を複数回繰り返しても再現しないことを確認

## TODO

<!-- wip 時のみ -->
