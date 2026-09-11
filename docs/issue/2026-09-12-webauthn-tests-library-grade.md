---
title: WebAuthn 自前実装のテストをライブラリ水準まで徹底する
status: open
category: task
created: 2026-09-12T07:09:11+09:00
last_read:
open_entered: 2026-09-12T07:09:11+09:00
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

# WebAuthn 自前実装のテストをライブラリ水準まで徹底する

## 概要

WebAuthn の検証を自前 (`src/auth/webauthn.ts` 401 行 + `cbor.ts` 150 行、DR-0001 §2.11) で持つ以上、テストを既存ライブラリ (`@simplewebauthn/server` 等) に劣らない水準まで徹底する (kawaz 2026-09-12)。やり切った時点で既存ライブラリを改めて調査・比較し、ライブラリが良ければ書き直す、自前が良ければ既存を超える品質に仕上げ直す。

## 背景

自前実装は保守・監査コストが既存ライブラリより高くつきやすい。テストで品質を担保しきったうえで、改めてビルド vs バイの判断をやり直す。

## 受け入れ条件

- [ ] 登録: attestationObject (`none` 形式) の CBOR / authData の解析、COSE 鍵 (ES256 / RS256 / Ed25519) → WebCrypto 形式の変換、`rpIdHash` / flags (UP / UV / AT) / counter / AAGUID / credentialId 長の境界値、壊れた CBOR (途中で切れる、入れ子過多、不正な major type) の拒否
- [ ] 認証: `clientDataJSON` の `type` / `challenge` / `origin` の照合 (大文字小文字、末尾 `/`、port)、`rpIdHash` 不一致、UV 必須時の flag 欠落、counter の巻き戻し、署名の各アルゴリズムの正例と改竄例 (1 byte 反転)、`authenticatorData` と `clientDataHash` の連結順
- [ ] 転送: 発行 instance と検証 instance が違う時の challenge の一致と期限
- [ ] 既知のテストベクタ (WebAuthn spec の例、FIDO conformance の公開ベクタ、`@simplewebauthn` のテスト fixture のうちライセンス上流用できるもの) を通す
- [ ] 自前と `@simplewebauthn/server` に同じ入力を与えて結果 (accept / reject) が一致することを差分テストで確認 (dev dependency として入れてテストだけで使う)
- [ ] 決めること: 差分テストを恒久的に持つか、比較の時だけか (決めた結果をここに追記する)
- [ ] 上記が揃った時点で既存ライブラリを改めて調査・比較し、書き直す/自前を仕上げ直すの判断を記録する

## 先例

kawaz 2026-09-12: cache-warden の Touch ID 実装 (`cache-warden/docs/decisions/draft-DR-0031-custom-touchid-dialog.md`) は、自前かライブラリかの技術調査と PoC をやれるだけやった上でライブラリを使う判断をしたケース。今回の WebAuthn はその逆 (自前を選び、テストをやり切ってから比較する) だが、「比較を実際にやって記録する」作法は同じ。比較の結果は DR-0001 の追記 (または supersede) として残す。
