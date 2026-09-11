---
title: 1 ホスト複数クラスタの設計 (クラスタ間リンク種別、launchd/webui 配線)
status: open
category: design
created: 2026-09-11T13:37:44+09:00
last_read:
open_entered: 2026-09-11T13:37:44+09:00
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

# 1 ホスト複数クラスタの設計 (クラスタ間リンク種別、launchd/webui 配線)

## 概要

kawaz の想定 (2026-09-11 r303m11): 1 ホストに複数クラスタ (本人 / 家族 / ホームエージェント等) を立て、クレデンシャルはクラスタ内 instance に紐づき、クラスタがセグメント単位の役割を持つ。

統括の見立て: クラスタ = 共通 config の置き場 (`CCMSG_CONFIG_DIR`) 1 つ = mesh 1 つ = 認証境界 1 つ、とすれば今の設計 (auth.records の mesh 内複製、peers.json による mesh 相手、dir ごとの config.ts / instances/) の延長でそのまま複数化できる。

## 背景

足りないものが 3 つある。

1. **クラスタ間リンク** = 認証記録を複製せず許す op を絞った第 2 のリンク種別。今の mesh は「全面信頼 + 複製」の 1 種類しか無い。これが「セグメント単位の役割」の実体になる
2. **launchd unit 名の衝突**: `com.github.kawaz.ccmsg` 固定のため、複数クラスタの `service register` が衝突する。config dir 由来の接尾辞が要る
3. **Caddy / webui の入口配線**: クラスタごとに入口を分ける必要がある

## 受け入れ条件

- [ ] クラスタ = dir で確定するか裁定する (1 監督者で複数クラスタは認証境界が 1 プロセス内で混ざるので不採用が統括の推し)
- [ ] クラスタ間リンクで許す op の集合を決める
- [ ] 相手クラスタの instance をどう名乗らせるか (`hello.instance` の `mesh` claim との関係) を決める
- [ ] 用語を確定する (ユーザ向けは mesh = 配線、cluster / group = 所属)
- [ ] launchd unit 名の config dir 由来の接尾辞方式を決める
- [ ] Caddy / webui のクラスタ別入口配線方式を決める

## TODO

<!-- wip 時のみ -->
