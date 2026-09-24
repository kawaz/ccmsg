# WebAuthn の自前実装と TypeScript ライブラリの比較

自前実装 (`src/auth/webauthn.ts` 407 行 + `src/auth/cbor.ts` 150 行、DR-0001 §2.11) を続けるか、ライブラリに替えるかの判断材料。調査は 2026-09-24、数値は npm registry / npm downloads API / GitHub API / GitHub Advisory Database の一次資料 (worker sol-high が取得、統括が転記)。裁定は issue `webauthn-tests-library-grade` に記録する。

## 1. 候補と規模

| | 自前 | @simplewebauthn/server | fido2-lib | @passwordless-id/webauthn | @hexagon/webauthn |
|---|---|---|---|---|---|
| 版 / 最終 release | — | 14.0.2 (2026-09-13) | 3.5.9 (npm 2026-03-11、GitHub Releases は無し) | 2.4.0 (2026-05-15) | 0.9.14 (2022-05-05) |
| 直近 12 か月の release 数 | — | 10 | 6 | 4 | 0 |
| 週間 DL | — | 3,354,029 | 36,216 | 50,215 | 6 |
| GitHub ★ / contributors | — | 2,353 / 22 | 445 / 37 | 612 / 17 | 8 / 1 |
| open issue | — | 8 | 20 (+PR 6) | 0 (+PR 1) | 0 |
| ライセンス | MIT | MIT | MIT | MIT | MIT |
| 直接依存 | 0 | 10 | 8 (`@peculiar/webcrypto`、`cbor-x` 等) | 0 | 0 (bundle に内包) |
| 展開サイズ (npm unpackedSize) | — | 761 KiB | 4,782 KiB (dist/main.js 1.4 MB) | 226 KiB (browser min 35 KB) | 1,886 KiB |
| 検証経路の行数 (概算) | 557 | registration 381 + authentication 358 + helpers 数百 (TS) | main 950 + validator 753 + parser 399 + attestation 各種 (JS) | server.ts 238 + parsers.ts 約 130 | webauthn.js 933 + validator 841 + parser 等 (fido2-lib 派生) |
| テスト (test / it の機械集計) | 28 case (`webauthn` / `cbor` / `webauthn-library-grade`) + `auth.test.ts` の登録 / 認証 | 35 file / 223 case | 24 file / 737 case | 4 file / 49 case | 21 file / 702 case |
| FIDO conformance | 未 | CHANGELOG に pass の言及、`example/fido-conformance.ts` | 未確認 | 未確認 | 未確認 |
| GitHub Advisory | — | 3 件 (GHSA-6hxq-p678-4hr2、GHSA-2g3p-m8c9-hhwh、GHSA-j3h4-m3m2-7p7j。後 2 件は 14.0.1 のみ、14.0.2 で修正) | 1 件 (GHSA-g3qj-j598-cxmq、≤3.5.7) | 0 | 0 |

出典: [simplewebauthn](https://registry.npmjs.org/@simplewebauthn%2fserver/latest)、[fido2-lib](https://registry.npmjs.org/fido2-lib/latest)、[passwordless-id](https://registry.npmjs.org/@passwordless-id%2fwebauthn/latest)、[hexagon](https://registry.npmjs.org/@hexagon%2fwebauthn/latest)、DL は `https://api.npmjs.org/downloads/point/last-week/<pkg>`。Advisory が 0 件なのは安全の証明ではない。CVE の網羅性は未確認。

## 2. 機能範囲

| | 自前 | @simplewebauthn/server | fido2-lib | @passwordless-id/webauthn | @hexagon/webauthn |
|---|---|---|---|---|---|
| attestation 形式 | `none` のみ | none / packed / fido-u2f / tpm / android-safetynet / android-key / apple | none / packed / fido-u2f / tpm / android-safetynet / apple | **fmt / attStmt を一切見ない** | fido2-lib 同等 (apple / android-key 無し) |
| 署名アルゴリズム | ES256 / EdDSA / RS256 | EdDSA / ES256 / RS256 (既定)、PQC 環境で ML-DSA-44 | ES256 / RS256 / ES384 / RS384 等。EdDSA / PS256 は未完 (コメントアウト) | ES256 / RS256 | fido2-lib 同等 |
| 拡張 | 使わない | credProps を自動要求、PRF / largeBlob 実装あり | 拡張の登録機構 + appId | — | fido2-lib 同等 |
| credential ID と鍵の結び付き | authData の credentialId と `raw_id` を照合、鍵は authData から | 同様 | 同様 | **client が渡す `response.publicKey` を記録** (authData との結び付きを検証しない) | fido2-lib 同等 |
| BE / BS flag | 登録時に保存 (BS ⇒ BE の整合は未検査) | 矛盾を拒否 | parser に見当たらず | parse するが synced = BE のみ | 未確認 |
| counter の巻き戻し | `old > 0 && new <= old` で拒否 | `(new > 0 \|\| old > 0) && new <= old` で拒否 (自前と同値) | 検出あり | `expected.counter > 0` の時だけ | fido2-lib 同等 |
| origin / rpId | 完全一致 (port と末尾 `/` を区別)、rpId は SHA-256 | `string \| string[]` の完全一致、末尾 `/` 不許可 | 単一 origin、`new URL(s).origin !== s` を拒否 = 実質文字列一致 | 単一 origin か validator 関数、末尾 `/` は expected と一致すれば通る | fido2-lib 同等 |
| UV / UP | UV + UP 必須 | UV + UP 既定で必須 (option で緩められる) | `expected.factor = "first"` で UV + UP | UV は期待値 true 指定時のみ、登録時 UP 無し | fido2-lib 同等 |
| crossOrigin / topOrigin | `crossOrigin: true` または `topOrigin` の存在を拒否 (埋め込みからの登録・認証を拒む) | 登録では検査なし、認証は `crossOrigin: true` かつ `topOrigin` 無しを許す | 未確認 | 未確認 | 未確認 |

出典: [自前](https://github.com/kawaz/ccmsg/blob/main/src/auth/webauthn.ts)、[simplewebauthn verifyRegistrationResponse](https://github.com/MasterKale/SimpleWebAuthn/blob/master/packages/server/src/registration/verifyRegistrationResponse.ts)、[fido2-lib lib/](https://github.com/webauthn-open-source/fido2-lib/tree/master/lib) ([toolbox.js checkOrigin](https://github.com/webauthn-open-source/fido2-lib/blob/master/lib/toolbox.js#L89-L119))、[passwordless-id server.ts](https://github.com/passwordless-id/webauthn/blob/main/src/server.ts#L40-L72) / [parsers.ts](https://github.com/passwordless-id/webauthn/blob/main/src/parsers.ts)、[hexagon lib/](https://github.com/Hexagon/webauthn/tree/main/lib)。

## 3. 実行環境

| | 自前 | @simplewebauthn/server | fido2-lib | @passwordless-id/webauthn | @hexagon/webauthn |
|---|---|---|---|---|---|
| 暗号 | WebCrypto のみ | WebCrypto (公式は Node 22+ / Deno 2.4+、engines >=20)。Bun / edge は未確認 | `@peculiar/webcrypto` + `cbor-x`。Node / Deno の記載、Bun / edge 未確認 | global WebCrypto のみ (Node 19+ / Workers 公式)。Bun / Deno は個別検証なし | 依存を内包、Node / Deno / ブラウザを主張。Bun 未確認 |
| bundle 実測 | — | tree-shake 後は未確認 | dist/main.js 1,405,294 bytes | browser min 35,390 bytes | dist/webauthn.js 1,887,658 bytes |

## 4. ccmsg との適合

DR-0001 §2.11 の要求は: `none` attestation の passkey を登録し、UV + UP 必須で認証する、challenge は発行 instance と検証 instance が違ってよい (検証後に発行元へ消費を頼む)、埋め込み (cross-origin の iframe) からの登録・認証は拒む。

- **@simplewebauthn/server**: 満たせるが 3 つの事前・事後ガードが要る: (1) `fmt` を `none` に限定する option が無いので、検証後に返る attestationObject の fmt と attStmt が空であることを自分で確かめる、(2) 登録の crossOrigin / topOrigin を検査しないので、`clientDataJSON` を自分で読んで先に拒む (認証も `crossOrigin: true` + `topOrigin` 無しを許すので同様)、(3) `rawId` / `id` / `type` / `response` の形に変換する。instance を跨ぐ challenge は「期待 challenge を渡すだけ」で維持できる (どのライブラリも転送は担わない)。counter の判定は自前と同値
- **fido2-lib**: EdDSA が未完なので今の 3 アルゴリズムを維持できない。`@peculiar/webcrypto` を抱えて 1.4 MB。JSON の形の変換が要る
- **@passwordless-id/webauthn**: attStmt も credential ID と鍵の結び付きも登録時の UP も検証せず、client が名乗る公開鍵を記録する。`none` 固定の要求を満たせず、自前より弱い
- **@hexagon/webauthn**: 2022 年で止まっている fido2-lib 派生。候補外

## 5. 所見 (統括。裁定は kawaz)

- 替えるなら第一候補は `@simplewebauthn/server` 14.0.2 で、他の 3 つは候補にならない (passwordless-id は検証が足りず、fido2-lib は EdDSA 未完と依存、hexagon は放置)。置き換えのコストは §4 のガード 3 つ + Bun での実動確認 + 既存の登録済み credential の形の互換
- 自前を続ける条件: 差分テスト (今回 1 件の不一致を拾った) を持ち続けること、upstream の advisory (simplewebauthn の GHSA 3 件のような判断の変化) を追うこと、負例と既知ベクタを増やすこと。557 行 + 現在の test 数は成熟ライブラリと同等とは言えない
- どちらでも要る物: 差分テストは「自前の審判」としても「ライブラリを取り込んだ後の回帰」としても効くので、dev dependency として残す価値がある
- 自前が simplewebauthn より厳しい点が 2 つある (登録の crossOrigin / topOrigin 拒否、`none` 固定)。替えるとこの 2 点は自分のコードで補う形に戻るので、「ライブラリに任せて薄くなる」量は見た目ほど大きくない
