---
title: 登録の検証が credential ID 0 byte の attestation を受理する (@simplewebauthn/server は拒否)
status: resolved
category: bug
created: 2026-09-24T12:45:04+09:00
last_read:
open_entered: 2026-09-24T12:45:04+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-09-24T12:49:27+09:00
discard_reason:
pending_reason:
close_reason: ["done: commit e8acb155"]
blocked_by:
origin: 自リポ TODO
---

# 登録の検証が credential ID 0 byte の attestation を受理する (@simplewebauthn/server は拒否)

## 概要

`src/auth/webauthn.ts` の `verifyRegistration` は、authData の credentialId 長が 0 で raw_id も空の登録を受理する。同じ入力を `@simplewebauthn/server` に与えると "Missing credential ID" で拒否する (差分テストで検出、2026-09-24)。

## 背景

空の credential ID は WebAuthn では意味を持たず (認証時に allowCredentials で指せない)、受理すると誰も使えない鍵が記録に残る。

再現: `test/webauthn-library-grade.test.ts` の `test.skip("BUG: 空の credential ID を拒否する …")` (skip を外すと落ちる)。

関連: issue webauthn-tests-library-grade、DR-0001 §2.11。

## 受け入れ条件

- [ ] credentialId 長 0 の attestation を `verifyRegistration` が拒否し、理由が分かる error になる
- [ ] `test/webauthn-library-grade.test.ts` の該当 test の skip を外して pass
- [ ] 1 byte の credential ID は引き続き受理 (既存 test)

## TODO

<!-- wip 時のみ -->
