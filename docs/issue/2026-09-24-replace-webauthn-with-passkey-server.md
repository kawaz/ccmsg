---
title: WebAuthn 検証を @kawaz/passkey-server に置き換える
status: open
category: task
created: 2026-09-24T14:55:28+09:00
last_read:
open_entered: 2026-09-24T14:55:28+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: kawaz/passkey
---

# WebAuthn 検証を @kawaz/passkey-server に置き換える

## 概要

ccmsg の自前 WebAuthn 検証実装 (`src/auth/webauthn.ts` + `src/auth/cbor.ts`) を、kawaz/passkey リポで切り出した `@kawaz/passkey-server` に置き換える。

## 背景

検証実装は kawaz/passkey の `packages/server` (`@kawaz/passkey-server`、DR-0002) に移植済み。入力は WebAuthn Level 3 の `toJSON()` 形 (camelCase)、ccmsg の契約 (snake_case) は ccmsg の境界で写す方針。DR-0002 は Proposed で入力型 1 点が裁定待ち (passkey の `docs/QUESTIONS.md` PK-Q3)、認証時の埋め込み拒否 (crossOrigin/topOrigin) は同 PK-Q1。npm 公開前なら workspace / file 参照で取り込む。

## 必要な変更 (passkey 側の移植 worker の観察。裏取りは ccmsg 側で行うこと)

1. 境界での写し:
   - 登録: `{ id, rawId: raw_id, type: "public-key", clientExtensionResults: {}, response: { clientDataJSON: client_data_json, attestationObject: attestation_object, ... } }`
   - 認証: `response: { clientDataJSON, authenticatorData, signature, userHandle? }`
   - (入力型が部分型に裁定されればダミー不要になる可能性がある)
2. `src/auth/auth.ts` の `challengeIn` を `challengeOf` に置き換え。例外が `PasskeyVerificationError` になるので refusable 相当の包み直しが要る
3. 別に呼んでいる `checkPublicKey` (auth.ts L657 付近) を削除する (`verifyRegistration` に取り込まれた)。`verifyRegistration` が async になるので `refusable` → `refusableAsync` に変える
4. `verifyAssertion(cred, known, { rpIds: [x] })` → `verifyAuthentication(cred, { challenge, origin, rpId: x }, { publicKey, signCount: record.sign_count ?? 0 })`。signCount は必須
5. 戻り値の読み替え: `credentialId` → `id`。publicKey の表現 (COSE の base64url) は同じで保存データの移行不要
6. 削除候補: `src/auth/webauthn.ts`、`src/auth/cbor.ts`、`test/webauthn.test.ts`、`test/cbor.test.ts`、`test/webauthn-library-grade.test.ts`、`test/authenticator.ts` (他テストが SoftAuthenticator を使うなら要検討)、`@simplewebauthn/server` の devDependency、`src/auth/index.ts` の re-export。`equalStrings` / `base64UrlDecode` / `sha256` は ccmsg 内の他所でも使うので残す
7. `advances` / `#used` の sign count 再照合は呼び出し側の責務なので残す

裏取りしてから採否を決めてください。実装にどう適用するかは ccmsg 側の担当セッションに委ねます。

## 相互参照

- passkey の `docs/issue/2026-09-24-extract-server-from-ccmsg.md`
- passkey の `docs/decisions/DR-0002-server-api.md`

## 受け入れ条件

- [ ] `@kawaz/passkey-server` を ccmsg に取り込み、`src/auth/auth.ts` の検証呼び出しを置き換える
- [ ] 自前実装 (`webauthn.ts` / `cbor.ts` とそのテスト) を削除する
- [ ] 既存の認証/登録テストが `@kawaz/passkey-server` 経由で green
