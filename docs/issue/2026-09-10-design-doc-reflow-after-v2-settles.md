---
title: design-doc-reflow-after-v2-settles
status: open
category: task
created: 2026-09-10T14:35:49+09:00
last_read:
open_entered: 2026-09-10T14:35:49+09:00
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

# design-doc-reflow-after-v2-settles

## 概要

`docs/DESIGN-ja.md` / `docs/DESIGN.md` (と契約リポの DESIGN、README-ja) は v2 の構築中に節を足し続けた結果、追記順の構成になっている (エコシステムレビュー C-3)。v2 が安定した時点 (契約の major 前、passkey / mesh / dump の裁定待ち issue が閉じた後) で、初見の読者が上から読める順序に reflow する: §1 目的と増やさないもの → 契約との関係 → 認証 (人 / instance / gateway) → 状態モデル → topic と配送 → mesh → 運用 (daemon / service / plugin) → テスト方針。あわせて行長を揃える改行 (hard-wrap) を解消し、折り返しはビュー側に任せる。節の順序入れ替えと同じ commit で日英を揃える。

## 背景

v2 の構築中に節を足し続けた結果、追記順の構成になっている (エコシステムレビュー C-3 由来)。内容の変更はせず、節の順序・見出し粒度・相互参照の付け替えだけを行う。日英を同じ commit で揃える。あわせて hard-wrap (行長を揃える改行) を解消し、折り返しはビュー側に任せる形に直す。節の順序入れ替えと同じ commit で日英を揃える。

着手条件: 契約 issue `token-family-bound-to-endpoint` と daemon issue `dump-sidechain-rows-placement` / `mesh-tls-trust-root` の裁定が出て実装が落ち着いてから。

## 受け入れ条件

- [ ] reflow 後に push gate (翻訳鮮度) が通る
- [ ] DR / issue から参照している節番号が全部追従している (`rg '§[0-9]'` で走査して確認)
- [ ] hard-wrap (行長を揃える改行) を解消する。対象は `docs/DESIGN-ja.md` / `docs/DESIGN.md`、契約リポの DESIGN / README-ja も同様に扱う (エコシステムレビュー C-3 の本体)
