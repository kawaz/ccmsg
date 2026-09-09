# DR-0001: 人の認証は passkey、token は record に紐づく opaque 値、鍵は持たない

Status: Accepted (2026-09-09。骨子は kawaz 裁定 r292 m10〜m15、細部は統括判断)
Date: 2026-09-09
Sponsor: kawaz r292m10 (2026-09-09)「認証は passkey を使うのを基本にしたい」「登録はリモートではなくローカルから」
関連: 設計 §3.1 (入口の許可)、§7 (mesh)、§9 (責務外)、`docs/issue/2026-09-09-mesh-tls-trust-root.md`

## 1. 背景

WS の入口は entry token (state ディレクトリの 0600 file) で守っていたが、これは「uid 境界を WS にも延ばす」以上の意味を持たず、tailnet 内・単一利用者の運用ではその境界を破れる相手が存在しない。一方で endpoint を利用者の proxy 配下の任意 URL にし、複数 instance を 1 つの origin の裏に置く構成 (相乗り / LB) が決まったため、入口は「誰が来たか」を答える認証を持つ必要がある。

## 2. 決定

### 2.1 登録はローカルからしかできない

`ccmsg daemon passkey add <unit> [endpoint]` を実行すると、登録用の一意 URL が 1 つ発行される。`endpoint` は省略すると instance 自身の endpoint、指定すれば利用者が自分の proxy で用意した任意の URL (別名の追加登録用)。

- URL は `<endpoint の origin に配られている webui>/#register=<jwt>` の形。jwt の claims は `{ iss (発行 instance), sub (利用者の識別子、既定は unit 名 + 連番), unit, endpoint, exp (10 分), jti }`
- jwt の署名鍵は **登録ごとの一次鍵** で、発行 instance のメモリにだけ置き、`exp` で破棄する。永続鍵は持たない (管理物を増やさない)
- webui はその URL で `navigator.credentials.create()` を行い、生成した credential と jwt を jwt の `endpoint` に POST する
- 受けた instance は `iss` が自分なら一次鍵で jwt を検証し `jti` を消費、attestation は `none` で受ける (登録の正当性は jwt が担保する)。`{ sub, unit, credential id, COSE 公開鍵, 登録時刻 }` を **利用者 record** として保存する。`iss` が自分でなければ `iss` へリレーする (§2.5)
- リモートからの登録経路は無い。passkey を全部失った時の復旧も CLI だけ。`passkey list` / `passkey remove <sub>` で record を見る・消す

### 2.2 RP ID は webui の origin

WebAuthn は「今開いているページの登録可能ドメイン」でしか作成・利用できない。したがって passkey を使う webui は jwt の `endpoint` と同じ登録可能ドメインから配られている必要があり、instance は `endpoint` のホストを `rpIdHash` の期待値、`endpoint` の origin (と config の `entry.origins`) を `clientDataJSON.origin` の期待値にする。同じ origin の endpoint が複数あっても (`https://h.example` と `https://h.example/personal`) passkey は 1 つで足りる。

### 2.3 token は record に紐づく opaque 値

アクセストークン / リフレッシュトークンは署名しない。乱数を利用者 record の中に `{ value, kind, exp, issued_at }` として保存し、検証は lookup で行う。失効は record から消すこと (`passkey remove` で sub ごと)。

- アクセストークンは数時間、リフレッシュトークンは数日。リフレッシュは使うたびに rotate し、失効済みの値の再利用を見たらその sub の token を全部失効させる
- アクセストークンは WS の handshake に subprotocol `ccmsg.token.<値>` で載せる (entry token と同じ運び方)。ブラウザはメモリにだけ持つ
- リフレッシュトークンは **httpOnly cookie**。名前は `iss` + `sub` のハッシュ、値は opaque、`HttpOnly; Secure; SameSite=Strict; Path=<self のパス>/auth/`。`Path` を認証専用に絞るので、WS の upgrade や webhook には付かない
- 認証と refresh は `<self のパス>/auth/` 配下の HTTP。endpoint が webui と別サブドメインの場合だけ、fetch は `credentials: "include"`、応答は `Access-Control-Allow-Origin: <その origin>` + `Allow-Credentials`

### 2.4 接続の期限

認証済みの WS はアクセストークンの `exp` までが期限。クライアントは `exp` 前に `/auth/refresh` で新しいアクセストークンを得て、同じ接続上で `auth_refresh` op により期限を延ばす (切断しない)。怠った接続は instance が `exp` で切る。切られたら refresh → 再接続、refresh が無効なら passkey 認証 (`sub` を添えて assertion) → 新しい token 対 → 再接続。

### 2.5 record の複製と `iss` への問い合わせ

利用者 record (passkey の公開鍵と token) は peer 間で複製してよい (登録 passkey は公開情報、token は cluster 内の共有秘密)。載せ先は契約の `kv:<ns>` topic (element 粒度、LWW + tombstone) の予約 namespace。複製が届く前、または知らない値を受けた instance は `iss` の instance に問い合わせる。`iss` へ聞く場面は 3 つで、全部同じ転送経路 (§7.3) を使う:

- 登録 jwt の検証 (一次鍵は `iss` にしかない)
- WebAuthn の challenge (発行した instance の id を challenge に含め、返ってきた側がそこへリレーして照合する。LB で発行と応答の instance が違ってよい)
- 未複製の token / record の lookup

`iss` が落ちていれば refresh か passkey 認証に落ちる。

### 2.6 endpoint と `self`

config に `self` (公開 endpoint URL) を持つ。instance id は `self` そのもので、mesh の `iss` / `aud` もこれ。WS (`/ws`)、webhook (`/webhook/<source>`)、mesh (`/mesh/*`)、認証 (`/auth/*`) の全ルートは `self` のパス配下に mount し、proxy は prefix を剥がさずそのまま渡す。`self` と一致しない URL で来た mesh の `hello` は `aud` 不一致で拒否する。人の入口は `self` を名乗らないので、LB や別名 FQDN 経由でも token だけで判定する。

### 2.7 entry token の廃止

state ディレクトリの `entry.token` と subprotocol / `?token=` による照合は削除する。`entry.origins` は RP と CORS の期待値として残る。UDS (到達 = 権限) / mesh (TLS + `iss`/`aud` + proof) / webhook (Bearer) は変わらない。

### 2.8 契約の変更 (minor)

- `hello` 前に呼べる HTTP 経路 `/auth/register` (jwt + credential)、`/auth/challenge`、`/auth/assert` (sub + assertion → token 対 + cookie)、`/auth/refresh` (cookie → 新しい token 対)。WS の op としては `auth_refresh` (接続の期限を延ばす) の 1 つ
- `hello` の応答に `auth_expires_at` (この接続の期限)
- `kv` の予約 namespace `auth` と record の schema
- 世代は上げない (追加のみ)

### 2.9 実装は自前

WebAuthn の検証は library を入れずに書く。登録は `attestationObject` (CBOR) から credential id と COSE 公開鍵を取り出す、認証は `clientDataJSON` (type / challenge / origin)、`authenticatorData` (`rpIdHash` / flags UP,UV / counter)、署名 (`authData || sha256(clientDataJSON)`) を ES256 (+ RS256 / Ed25519) で検証する。要るのは小さな CBOR decoder と WebCrypto だけ。

## 3. 不採用

| 案 | 理由 |
|---|---|
| entry token を残す | 破れる相手が現状の構成に居ない。外に出す時は passkey がその役を担う |
| 人の認証を前段 (caddy forward_auth / tailscale identity) に寄せる | 前段の構成が利用者ごとに違い、daemon が「誰か」を知る形が揃わない。passkey は daemon 自身が判定でき、前段は透過でよい |
| instance の永続鍵で token を署名する | 管理物 (鍵の保管・rotate・配布) が増える。record の lookup + `iss` への問い合わせで同じことが鍵なしで出来る |
| token を localStorage に置く | XSS 1 つで長期 token が抜ける。httpOnly cookie は same-site で送れる (RP の制約から webui と endpoint は同じ登録可能ドメイン) |
| アクセストークンの `exp` で必ず切断する | 画面が周期的に瞬く。同じ接続で延ばす op を置き、切るのは怠った時だけ |
| WebAuthn library を入れる | 細かい制御 (attestation `none` 固定、challenge のリレー) が要件に合わない可能性。検証手順は短い |
| リモートからの登録・復旧経路 | 登録がローカルに閉じることが安全性の根 |

## 4. 影響

- 契約 minor (auth 経路 / `auth_refresh` / `hello.auth_expires_at` / `kv` の予約 ns) → daemon (CLI `passkey add|list|remove`、`/auth/*`、WebAuthn 検証、cookie、`self` の config 化と全ルートの `self` パス配下化、entry token 削除) → webui (登録画面、passkey 認証、refresh、token をメモリに)
- 設計 §3.1 の「WS の entry token」を書き換え、§9 に「人の認証は passkey (本 DR)」を足す
- `docs/issue/2026-09-09-mesh-tls-trust-root.md` は「TLS 終端は proxy、daemon の listener は plain のまま」で扱いが変わる (別途更新)
