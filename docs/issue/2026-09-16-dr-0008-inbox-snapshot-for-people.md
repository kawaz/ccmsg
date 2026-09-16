---
title: DR-0008 §2.5 の inbox snapshot 規定と実装が逆向き
status: open
category: design
created: 2026-09-16T16:03:27+09:00
last_read:
open_entered: 2026-09-16T16:03:27+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: DR の状態列を入れる作業 (2026-09-16) で発見
---

# DR-0008 §2.5 の inbox snapshot 規定と実装が逆向き

## 概要

DR-0008 §2.5 は「sid を持たない接続 (人が見ている) には空の snapshot を返す」と決めている。
しかし実装 (`src/messaging/inbox.ts:161`) は人に全 inbox を非消費の view として返しており、
`docs/DESIGN.md:564` も後者を正本として書いている。DR 側に更新も Superseded 注記も無く、
DR と実装が逆向きのまま放置されている。

## 背景

DR-0008 の状態列を入れる作業中に `/tmp/dr-index-status-report.md` で発見。以下の 3 箇所が矛盾している:

- `docs/dr/DR-0008.md` §2.5: sid なし接続には空 snapshot
- `src/messaging/inbox.ts:161`: 人には全 inbox を非消費 view で返す実装
- `test/delivery.test.ts:342,361`: 後者 (全 inbox 返却) を検証するテスト
- `docs/DESIGN.md:564`: 後者を正本として記述

同じ調査で、DR 本文が実装より古い箇所が daemon 側に他 3 件・契約側に 1 件見つかっている
(元の report は `/tmp/` にあり再起動で消えるため、この issue を着手する際に先に転記すること)。

## 受け入れ条件

- [ ] 実装 (全 inbox 非消費 view) と DR-0008 §2.5 のどちらを正とするか決める
- [ ] 正としなかった側を書き換える (DR を実装に合わせて改訂 or Superseded 注記、あるいは実装を空 snapshot に戻す)
- [ ] `docs/DESIGN.md:564` の記述が最終的な正本と一致していることを確認する
- [ ] `/tmp/dr-index-status-report.md` に列挙されている残り 4 件 (daemon 3 件 + 契約 1 件) をこの issue または別 issue に転記する

## 同種の drift (実装が先に進み DR が古い。状態判定には効かせていない)

- daemon DR-0006 §2.6: dump 形式の数が実装と違う
- daemon DR-0009 §2.1: 分類の所在が実装と違う
- daemon DR-0014 §2.1: 封筒の欄数が実装と違う
- 契約 DR-0026 §2: `starting` の定義が実装より緩い。実装は `HARNESS_COMMANDS = ["claude", "codex"]` の argv0 判定で更に絞る。DR 本文に `HARNESS_COMMANDS` を書き足すのが筋 (契約リポ)
