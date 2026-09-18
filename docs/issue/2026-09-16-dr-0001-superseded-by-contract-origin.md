---
title: DR-0001 の rp_id/cookie/WS Origin 節を契約 DR-0029/DR-0028 で Superseded 化
status: open
category: task
created: 2026-09-16T12:22:57+09:00
last_read: 2026-09-18T10:18:54+09:00
open_entered: 2026-09-16T12:22:57+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: 契約 v2.2.0 反映作業
---

# DR-0001 の rp_id/cookie/WS Origin 節を契約 DR-0029/DR-0028 で Superseded 化

## 概要

契約 DR-0029 (endpoint と webui の 2 つに縛る、比べる値は URL から導く、CORS の許可集合) と DR-0028 (refresh cookie の SameSite を same-site / cross-site で決める、auth の HTTP 3 op で Origin と Sec-Fetch-Site を検査) により、daemon 側 DR-0001 の以下の節が置き換わる。

- §42 (rp_id は endpoint の host)
- §54
- §55 (別サブドメイン非対応)
- §90 (WS は Origin を見ない)

## 背景

契約 v2.2.0 を daemon に反映する作業の一環。DR-0001 の該当節を「Superseded by 契約 DR-0029 / DR-0028」として更新し、これを以下の実装反映と同じ commit 群で扱う。

- credential record の webui
- TokenFamily.webui
- WS upgrade での Origin 一致
- HTTP 認証 op の CORS と Sec-Fetch-Site 検査
- cookie 属性の組み立て
- 旧 record の扱い (= CT-Q13β の裁定に従う)

## 受け入れ条件

DR-0029 は archive され、契約側の置き換え先は DR-0030 (identity はユーザ、instance はその人の所有物) になった。以下は DR-0030 との整合を基準にした条件。

- [x] DR-0001 §2.2 が「人を作るのはローカルからしかできない」に更新されている (CLI は `ccmsg user create` / `user add` / `user passkey add`、URL は `<origin>/#enroll=<jwt>`、claims は EnrollClaims、endpoint claim は宛先で照合しない、所有 record を書くのは ceremony が成立した時で書くのは着弾した instance、どの instance を渡すかは URL を出した端末が決め claims の `instances` が運ぶ、`granted_by` は URL を出した instance)
- [x] §2.3 が「credential の束縛は origin 1 つ、instance は所有 record が答える」に更新され、置き換え先が DR-0030 と明記されている
- [x] §2.4 の単一 writer が削除され、「所有されているどの instance でも rotate できる、転送しない、負け側は auth_invalid で family は失効させない、失効は retired 一致のみ」に更新されている
- [x] refresh cookie 名が `__Secure-ccmsg-<sha256(user id) 先頭16hex>` (instance を含めない) に更新されている
- [x] CORS が 2 通り (`challenge` と `register` は全 origin、`enroll` / `assert` / `refresh` はこの instance が持つ credential record の origin、所有では絞らない) に更新されている
- [x] §2.5/§2.6 の sub 単位 tombstone が「key が対象を言う 4 種 (user / credential / ownership / family)」に更新され、所有の granting id と足し直しの規則が追記されている
- [x] §2.9/§2.10 の op 名が現行 (auth.enroll / auth.account.read / auth.ownership.remove / auth.credential.remove / auth.resolve、auth.rotate 廃止) に更新されている
- [x] 現役文書 (DR-0001) から archive された DR-0029 への名指し参照が残っていない
- [x] WS upgrade が所有を照らす実装になっている (DR-0001 §90 相当)
- [x] cookie 属性 (`SameSite` を same-site/cross-site で決める、DR-0028 相当) の組み立てが daemon 実装に反映されている
- [x] 旧 record の扱いが裁定通り (契約の形でない record は file からも peer からも accept しない) 実装・記載されている
- [x] 上記の項目が DR-0001 との整合を保ったまま同じ作業の中で解消されている
- [x] `auth_in_use` の判定が実装されている
- [x] rotate の writer と競合の扱いが実装されている
- [x] 所有の再付与と tombstone が実装されている
- [x] `user` CLI 一式が実装されている

## TODO

<!-- wip 時のみ -->
