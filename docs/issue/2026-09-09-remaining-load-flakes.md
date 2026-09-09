---
title: 負荷下でのみ落ちるテスト 2 件の flake 調査
status: wip
category: bug
created: 2026-09-09T04:21:50+09:00
last_read: 2026-09-09T16:31:05+09:00
open_entered: 2026-09-09T04:21:50+09:00
wip_entered: 2026-09-09T17:19:26+09:00
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

# 負荷下でのみ落ちるテスト 2 件の flake 調査

## 概要

負荷下でのみ稀に落ちるテストが 2 件ある (2026-09-09 観測、未対応)。timeout を伸ばす等の
flake 認定はせず、それぞれ実測で原因を特定する。

1. `test/instance.test.ts` の「a successor takes the address, and the predecessor's own
   path goes with it」が full suite 20 回中 2 回、10.3s timeout。
2. `test/mesh-cluster.test.ts` の「a frame from another instance reaches a subscriber
   here under the instance that produced it」が CPU 8 本の負荷下 15 回中 1 回、timeout
   ではなく即時 throw で fail。

また `just push` の CI 実行で `Failed to start server. Is port 50021 in use?`
(`freePort()` の競合) が 1 回発生した。

## 背景

負荷テストのマトリクス実行中に観測。flake 認定で timeout を伸ばすと根本原因を覆い隠すため、
実測ベースで特定する方針([[empirical-verification]])。`freePort()` は ephemeral port を
実際に bind して返す方式に変える候補がある(現状は空きポート番号を返すだけで、返却後に他プロセス
に取られる TOCTOU の可能性)。

## 受け入れ条件

- [ ] `test/instance.test.ts` の timeout 原因を特定 (再現条件・ボトルネックの特定)
- [ ] `test/mesh-cluster.test.ts` の即時 throw fail の原因を特定
- [ ] `freePort()` の port 競合の原因を特定し、対策(実際に bind して返す等)を検討・実装
- [ ] 上記いずれも timeout 延長や retry 追加による誤魔化しではなく、実測に基づく修正であること

## 進捗 (2026-09-09)

3 件のうち 2 件と、調査で見つかった本番 leak を commit b0973644 で修正:

- instance の起動同期: symlink polling をやめ、子 daemon の stderr に出る `started` event を待つ (`child.exited` と race)
- mesh-cluster の test client: reply 探索中に通過した topic frame を保持し `next()` で払い出す
- 本番 leak: `bindForMesh` で `mesh.identify()` 失敗時に `ws.close()` してから rethrow (回帰テスト追加)

負荷下 20 反復で当該 2 件は 0 fail。

## 残り

- (a) `freePort()` の lease 化 (`test/cluster.ts:40-44`): bind → close で番号だけ返すため実 bind まで所有権が無い TOCTOU。正しい形は fixture が listener を保持し `serveWs` / Instance start に既存 Listener を注入する (`serveWs` の署名変更を伴う)
- (b) 第 3 の flake: `test/mesh-cluster.test.ts:504`「an instance that stops is out of reach at once」が負荷下 2/20 で `eventually(…, 1_000)` を超える。1s は §7.5「link 終了で即不到達」を守る意図的な予算なので延長せず、link close の観測 → reachable 確認のイベント駆動に組み替える (§7.5 の観測点の設計判断を含む)
