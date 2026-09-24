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

## 6. interface (型定義と README から。実測は worker opus-medium、2026-09-24)

| 観点 | 自前 | @simplewebauthn/server | fido2-lib | @passwordless-id/webauthn | @hexagon/webauthn |
|---|---|---|---|---|---|
| (a) 入力の形 | 契約の snake_case の wire 型 (`raw_id` / `client_data_json` / `attestation_object`、base64url)。ブラウザの `toJSON()` とは綴りが違い、写像は client 側。wire 契約と一致しているのが利点 | `RegistrationResponseJSON` / `AuthenticationResponseJSON` = Level 3 の `toJSON()` そのまま。ブラウザ標準を直接渡せる | `id` / `rawId` は ArrayBuffer 必須、clientDataJSON は string、authenticatorData は ArrayBuffer と混在。呼び出し側で変換が要り型も不揃い | `toJSON()` 形 + 独自の `user`。登録で `response.publicKey` / `publicKeyAlgorithm` / `authenticatorData` が必須で、`getPublicKey()` を出さない client (README によれば iOS / macOS のネイティブ) では使えない | fido2-lib と同じ |
| (b) 期待値の渡し方 | 1 つの `expected` (登録 `{challenge, origin, rpId}`、認証 `{challenge, origin, rpIds[]}` + `known {publicKey, signCount}`)。origin は 1 つ、UV は常に必須で選べない (決める余地が無い) | 1 つの options。`expectedOrigin` / `expectedRPID` は `string \| string[]`、challenge は関数でも可、`requireUserVerification` 既定 true。複数 origin / rpId を扱える | インスタンス生成時の config (rpId 等) と呼び出しごとの `expected` に分散。origin / rpId は 1 つ。UV は `factor: "first"` | 1 つの `expected`。origin / challenge は値か関数、rpId は `domain` (省略時は origin の host)。登録の `userVerified` は既定で検査しない (緩い) | fido2-lib と同じ |
| (c) 出力の形 | 登録: `{credentialId, publicKey (COSE, base64url), signCount, backupEligible, backupState}`、認証: `{signCount}`。保存する物だけを返す。transports は返さない | `{verified, registrationInfo: {credential: {id, publicKey: COSE Uint8Array, counter, transports}, credentialDeviceType, credentialBackedUp, aaguid, fmt, userVerified, origin, rpID, …}}`。BE / BS は deviceType / backedUp に写像。保存時に publicKey の符号化が要る | `Fido2AttestationResult` の `authnrData: Map<string, any>` から取り出す。BE / BS を解釈せず "RFU3" / "RFU4" (`lib/parser.js`)。文字列キーの Map で型が効かない | `{credential: {id, publicKey: SPKI base64url, algorithm, transports}, authenticator: {aaguid, counter, …}, synced (= BE), userVerified, user}`。BS 無し。**publicKey は client の申告値で検証されていない** (下の probe) | fido2-lib と同じ |
| (d) 失敗の伝え方 | 全部 `WebAuthnError` 1 クラスの throw、message に段階。署名不一致も throw。呼び出し側 (`auth.ts` の `asRefusal`) は instanceof だけで振り分けられる | 大半は素の `Error` の throw (message に詳細)、署名不一致だけ `verified: false` で返る。`SimpleWebAuthnError.code` は 2 値 (PQC / 証明書パス)。例外と戻り値の 2 経路で、素の Error なので bug と入力不正を型で区別できない | 素の Error / TypeError / RangeError (lib 全体で Error 239 箇所、TypeError 66 箇所)。reason の enum 無し | 素の `Error`、壊れた JSON は SyntaxError がそのまま漏れる | fido2-lib と同じ。EdDSA では ReferenceError (内部の bug) が漏れる |
| (e) options 生成との対 | サーバ側には無い (options はページ側が組む) | `generateRegistrationOptions` / `generateAuthenticationOptions` が verify と対 | `attestationOptions` / `assertionOptions` と対 | サーバ側は `randomChallenge()` だけ | fido2-lib と同じ |
| (f) challenge の管理 | 呼び出し側 (`auth.ts` が clientData から読み、検証してから消費) | 呼び出し側 (値か関数で照合) | 呼び出し側 | 呼び出し側 | 同 |
| (g) 型の厳しさ | 公開型あり、any 無し (契約の TypeBox の Static 型) | `.d.ts` 同梱、`Uint8Array_` まで厳密、any ほぼ無し | 手書きの `types/main.d.ts`、結果は `Map<string, any>`、extensionOptions は any | `.d.ts` 同梱、関数型の引数が素の `Function` | 生成された `.d.ts`、厳しさは未確認 |
| (h) 置き換え時に呼び出し側が変わる量 | — | 中: snake_case → toJSON 形の写像、publicKey の Uint8Array → base64url、deviceType / backedUp → BE / BS、`verified: false` → throw、`asRefusal` が素の Error を拒否として扱う、**登録時の crossOrigin 拒否を別途足す**。counter の規則は同じ | 大: ArrayBuffer への変換、保存形式が COSE → PEM で既存 record の移行、rpIds を 1 つに、BE / BS を自前で読む、EdDSA を捨てる | 大かつ危険: wire に publicKey / publicKeyAlgorithm / authenticatorData を足す (契約の変更)、保存鍵が SPKI で既存 record の移行、EdDSA を捨てる、鍵の拘束を自前で足す | fido2-lib と同じ + 2022 年から更新無し |

probe で分かったこと (Bun で実行): 登録の `crossOrigin: true` は自前だけが拒否し、simplewebauthn と fido2-lib は通す (simplewebauthn は認証でだけ、しかも `topOrigin` がある時だけ見る。Safari 対策の TODO 付き)。passwordless-id は `response.publicKey` を無関係な鍵に差し替え attestationObject をゴミにしても登録が通り、その鍵を保存する (attestationObject を読まず、credential ID も照合しない)。

出典: [simplewebauthn docs](https://simplewebauthn.dev/docs/packages/server) と同梱の `.d.ts` (`registration/verifyRegistrationResponse.d.ts`、`authentication/verifyAuthenticationResponse.d.ts`、`errors/index.d.ts`)、[fido2-lib types/main.d.ts](https://github.com/webauthn-open-source/fido2-lib/blob/master/types/main.d.ts) (BE / BS は `lib/parser.js` 305-310 行、factor は `lib/main.js` 821 行、counter は `lib/validator.js` 659-664 行)、[passwordless-id](https://github.com/passwordless-id/webauthn) の `dist/esm/server.js` / `parsers.js` と README 159 / 169 行 (`getPublicKey` 前提、issue #95)、[hexagon](https://github.com/Hexagon/webauthn) README ("Heavily based on fido2-lib"、"Currently in pre-release")。

## 7. bundle と実動 (実測、bun 1.3.13 / node v26.9.0、`bun build --target=<bun|node> --minify`)

| 実装 | entry | minify bun (gzip -9) | minify node (gzip -9) | node_modules (本体 / 依存込み) | Bun での実動 (ES256 / RS256 / EdDSA) |
|---|---|---|---|---|---|
| 自前 (webauthn.ts + cbor.ts) | verifyRegistration / verifyAssertion / checkPublicKey | 7,210 B (2,662) | 7,207 B (2,659) | 依存 0 | 全部 OK |
| @simplewebauthn/server 14.0.2 | verify × 2 | 319,603 B (88,510) | 484,117 B (125,547) | 2,132 KiB / 7,004 KiB・24 pkg | 全部 OK |
| 同 + generate*Options | 4 関数 | 321,775 B | 486,289 B | 同上 | — |
| fido2-lib 3.5.9 | Fido2Lib | 770,442 B (200,735) | 893,884 B (227,205) | 4,996 KiB / 16,240 KiB・23 pkg (`cbor-extract` のネイティブ optional 込み) | ES256 / RS256 OK、**EdDSA 失敗** (`lib/keyUtils.js` に "EdDSA is untested and unfinished") |
| @passwordless-id/webauthn 2.4.0 | server.verify × 2 | 31,789 B (13,558) | 36,346 B (15,369) | 280 KiB・依存 0 | ES256 / RS256 OK、**EdDSA は登録が通って認証で失敗** ("Only 'RS256' and 'ES256' are supported") |
| @hexagon/webauthn 0.9.14 | Webauthn | 550,190 B (145,368) | 546,888 B (145,088) | 1,948 KiB・依存 0 (fido2-lib 系を 1 つの dist に同梱) | ES256 / RS256 OK、**EdDSA 失敗** (ReferenceError) |

実動の確認は、壊れた入力 (API があって入力を断るか) と、`test/authenticator.ts` の SoftAuthenticator で作った正しい登録 + 認証 (3 アルゴリズム) を Bun で直接、Node では bundle してから実行。結果は両者で同じ。simplewebauthn の node 向けが 1.5 倍大きいのは依存 (`@peculiar/*`) が CJS 側に解決されて tree-shake が効かないためと推定 (未確認)。Node では PQC 判定の `ExperimentalWarning: ML-DSA-44` が stderr に出る。

## 8. 所見の追記 (§6 / §7 を受けて)

- 現実的な置き換え先はやはり simplewebauthn だけ (他 3 つは EdDSA が動かないか、鍵の拘束を検証しない)。サイズは自前の 7 KB に対し 320 KB (Bun、gzip 89 KB)、node_modules は依存込み 7 MB。daemon は bundle しないので実害はディスクと起動時の読み込みだけ
- interface は simplewebauthn の方が「ブラウザ標準の形をそのまま受ける」「複数 origin」「options 生成との対」で広い。自前は「決める余地が無い」「失敗が 1 クラス」で狭く、ccmsg の使い方 (契約の wire 型、UV 必須固定、埋め込み拒否) にはこちらの方が嵌まっている
- 置き換えると呼び出し側の変更は中程度で、しかも自前が持つ厳しさ 2 点 (登録の crossOrigin 拒否、none 固定) を自分で足し直す。得るのは「成熟したテストと advisory の追跡を上流に任せられること」で、失うのは「7 KB で読み切れる」こと
