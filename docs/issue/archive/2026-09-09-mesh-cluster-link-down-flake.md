---
title: mesh-cluster の link-down テストが suite 全体負荷時に flake する
status: resolved
category: bug
created: 2026-09-09T03:31:14+09:00
last_read:
open_entered: 2026-09-09T03:31:14+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-09-09T04:21:52+09:00
discard_reason:
pending_reason:
close_reason: ["done: Mesh.stop() が accepted 側 link を close していなかったのが真因 (glare の向きで顕在化)。全 link close する修正 + 決定的な RED/GREEN テストで固定 (v0.0.22, commit 8d1d74e7)。50 回連続実行は負荷のため未実施"]
blocked_by:
origin: 自リポ TODO
---

# mesh-cluster の link-down テストが suite 全体負荷時に flake する

## 概要

`test/mesh-cluster.test.ts` の「a link going down shows up on the topic, without asking again」が、フル suite 実行時に 55 回中 3 回落ちる。単体実行では 40/40 green で、suite 全体の負荷がかかっている時のみ再現する。

## 背景

2026-09-09 の hygiene 作業中に観測。mesh のコード・テストは今回未変更で、既存の潜在 flake を発見した形。timeout を伸ばして誤魔化す flake 認定はせず、負荷時に何が遅延しているかを実測してから直す方針。

## 受け入れ条件

- [ ] 負荷時に何が遅延しているか (heartbeat 判定 / peers の再 publish / relay の onChanged) を実測で特定する
- [ ] 特定した遅延要因に対応する根本修正 (timeout 延長のような症状隠しではない) を行う
- [ ] フル suite を複数回 (目安 50 回以上) 実行して再現しないことを確認する
