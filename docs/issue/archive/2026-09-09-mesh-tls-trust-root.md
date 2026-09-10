---
title: mesh の信頼の根を TLS サーバ証明書で担保する (現状は plain ws 依存)
status: resolved
category: design
created: 2026-09-09T01:37:50+09:00
last_read:
open_entered: 2026-09-09T01:37:50+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-09-10T15:23:24+09:00
discard_reason:
pending_reason:
close_reason: ["done:kawaz 裁定 (2026-09-10, TL-Q1=a) — mesh の TLS は前段 (caddy) の終端で足りる、証明書運用を daemon の責務にしない。DESIGN の前提に「TLS は前段の責務」を明記 (後続 commit)"]
blocked_by:
origin: 自リポ TODO
---

# mesh の信頼の根を TLS サーバ証明書で担保する (現状は plain ws 依存)

## 概要

mesh-peer-auth の信頼の根は TLS サーバ証明書 (2 層) だが、daemon の listener は素の
`ws` しか話せず証明書を与える config が無い。現状 mesh の安全性は「到達できる
ネットワークが信頼できること」(例: tailnet) に依存している。以下を独立作業として行う:

- entry config への証明書設定 (or ACME / tailscale cert 経由の取得)
- `wss` の InstanceId 対応
- テスト用 CA の注入経路
- mesh-peer-auth §10.2 PKI レイヤのテスト実施

## 背景

mesh-peer-auth 設計は TLS サーバ証明書チェーンを信頼の根に据えているが、実装側は
listener が plain `ws` のみで証明書を扱う config が存在しない。設計と実装の乖離。

## 受け入れ条件

- [ ] entry config で証明書 (ファイル指定 or ACME / tailscale cert 自動取得) を指定できる
- [ ] `wss` 接続時の InstanceId 検証が実装される
- [ ] テスト用 CA を注入してテストで検証できる経路がある
- [ ] mesh-peer-auth §10.2 PKI レイヤのテストが実施され green

## TODO

<!-- wip 時のみ -->

## 補足: Bun `Bun.serve().stop()` の実測 (関連調査で判明)

Bun 1.3.13 実測: サーバ側から `ws.close()` を呼ぶと、その `Bun.serve()` インスタンスの
`stop()` が resolve しない (listen アドレス自体は即座に解放される)。現状
`src/transport/ws.ts` の `serveWs.close()` は 250ms の `Promise.race` でこの挙動を
回避している。Bun 側に issue を出す価値がある一次情報として記録。
