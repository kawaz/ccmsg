---
title: DR-0001 の rp_id/cookie/WS Origin 節を契約 DR-0027/DR-0028 で Superseded 化
status: open
category: task
created: 2026-09-16T12:22:57+09:00
last_read:
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

# DR-0001 の rp_id/cookie/WS Origin 節を契約 DR-0027/DR-0028 で Superseded 化

## 概要

契約 DR-0027 (origin と endpoint を分ける、credential / token family の origin 束縛、CORS の許可集合) と DR-0028 (refresh cookie の SameSite を same-site / cross-site で決める、auth の HTTP 3 op で Origin と Sec-Fetch-Site を検査) により、daemon 側 DR-0001 の以下の節が置き換わる。

- §42 (rp_id は endpoint の host)
- §54
- §55 (別サブドメイン非対応)
- §90 (WS は Origin を見ない)

## 背景

契約 v2.2.0 を daemon に反映する作業の一環。DR-0001 の該当節を「Superseded by 契約 DR-0027 / DR-0028」として更新し、これを以下の実装反映と同じ commit 群で扱う。

- credential record の origin
- TokenFamily.origin
- WS upgrade での Origin 一致
- HTTP 認証 op の CORS と Sec-Fetch-Site 検査
- cookie 属性の組み立て
- 旧 record の origin 補完 (= CT-Q13β の裁定に従う)

## 受け入れ条件

- [ ] DR-0001 §42/§54/§55/§90 に Superseded by 契約 DR-0027 / DR-0028 の注記が入っている
- [ ] credential record / TokenFamily に origin フィールドが反映されている
- [ ] WS upgrade が Origin 一致を検査する
- [ ] HTTP 認証 3 op が CORS 許可集合と Sec-Fetch-Site を検査する
- [ ] cookie 属性 (SameSite 含む) が origin 関係に応じて組み立てられる
- [ ] 旧 record の origin 補完が CT-Q13β の裁定通りに実装されている
- [ ] 上記が DR-0001 更新と同じ commit 群に含まれている

## TODO

<!-- wip 時のみ -->
