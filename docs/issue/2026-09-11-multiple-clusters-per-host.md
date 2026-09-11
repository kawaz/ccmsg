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
- [x] 用語を確定する (ユーザ向けは mesh = 配線、cluster / group = 所属)
- [ ] launchd unit 名の config dir 由来の接尾辞方式を決める
- [ ] Caddy / webui のクラスタ別入口配線方式を決める

## 用語定義 (確定, 2026-09-11 r303m12)

kawaz の用語定義:

- **instance** = `CLAUDE_CONFIG_DIR` 1 つ。プライバシーと権限が閉じた最小単位
- **cluster** = ユーザ 1 人の管理単位 = `CCMSG_CONFIG_DIR` 1 つ (複数 instance、監督者 1 つ、mesh 1 つ、認証記録の複製範囲 1 つ)。ユーザは複数 instance を 1 cluster として管理できるが、同ホスト上の別 cluster に属する instance の `CLAUDE_CONFIG_DIR` には関与しない (同ホストのディスク権限管理はスコープ外)
- **mesh** = cluster 内の instance 同士の配線

DESIGN の locality `cluster` (全 instance 分の答え) はこの cluster 全体に問う意味で整合する。ユーザ向け用語は instance / cluster / mesh で揃える。

## 構造の確定 (2026-09-11 r303 m16/m17)

正本は TS config 作業の `/tmp/ccmsg-config-layout.md` (実装後は DESIGN §8.2 に移す)。

1 監督者で複数 cluster を持てる。レイアウトは `clusters.json` → `clusters/cluster-<id>.json` (name / peers / instances) → `instances/instance-<id>.ts`。権威はデータであり、ディレクトリ走査は使わない。id は `add` 時に `instanceIdentity` と同じ生成方式で state dir にも書く。これにより launchd unit 名の衝突は解消する (1 unit で全 cluster を賄える)。

### 将来案 (r303 m18)

管理用 webui と `passkey add --admin` = cluster 自体 (add / remove / mesh) を操作できる人の credential を、instance とは別の括り (admin-credentials) で instance と同じ仕組みにより管理する。

### 要検討

監督者に HTTP の入口を持たせる時の認証境界 (どの instance の Caddy にぶら下げるか / 監督者専用の口を設けるか)。

## TODO

<!-- wip 時のみ -->
