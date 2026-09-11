---
title: auth (passkey / token family) の claim に cluster を含める
status: open
category: design
created: 2026-09-11T14:05:46+09:00
last_read:
open_entered: 2026-09-11T14:05:46+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by: multiple-clusters-per-host (TS config の cluster 構造の確定形)
origin: 自リポ TODO
---

# auth (passkey / token family) の claim に cluster を含める

## 概要

passkey / token family の保管は **instance ごとのまま変えない**。iss + sub で
発行元が一意に決まり、読み書きの責務がその instance に閉じているため、共有
ファイルにすると単一書き手の性質が壊れる (instance 複製から cluster 単位の
共有ストアへ寄せる旧方針は不採用)。

代わりに **iss / sub / aud に cluster を含める**。記録に cluster が付くこと
で、複数 cluster に属する instance は同じ state dir に両方の cluster 分の
記録を持てて cluster で引ける。`auth.records` の複製は記録の cluster を見て
その cluster の mesh にだけ流す (topic のパラメータ化か frame 内の cluster
判定かは実装判断)。token 検証は aud の cluster で「別 cluster の token は
通らない」が claim レベルで効くようになる。

## 背景

kawaz r303 m23 (2026-09-11) での再裁定。旧方針 (r303 m20/m21) の instance
複製 → cluster 単位共有ストア案は、共有ファイルが単一書き手の性質を壊すため
撤回し、claim に cluster を含める方式に変更した。

## 決めること

1. 既存の記録 (cluster 無し) の移行 — 初回起動時に唯一の cluster を付けて
   書き直す 1 回限りの処理
2. claim の形 (iss = `<cluster_id>/<instance_id>` か、aud = cluster か等) は
   契約 issue `token-family-bound-to-endpoint` と一緒に決める
3. `passkey add|list|remove --cluster` の帰属は cluster で、発行は cluster
   内の任意の instance

## 受け入れ条件

- [ ] iss / sub / aud への cluster の含め方 (claim の形) が決定される
- [ ] 既存記録 (cluster 無し) の移行処理 (初回起動時 1 回限り) が実装される
- [ ] `auth.records` の複製が記録の cluster を見てその cluster の mesh にだけ
      流れるようになる
- [ ] token 検証で aud の cluster が一致しない token が拒否される
- [ ] `passkey add|list|remove --cluster` が実装される

## 着手条件

cluster 構造 (`multiple-clusters-per-host`) が入ってから。

## TODO

<!-- wip 時のみ -->
