# DR-0001: 人の認証は passkey、token は record に紐づく opaque 値、鍵は持たない

Status: Accepted (2026-09-09。骨子は kawaz 裁定 r292 m10〜m19、細部は統括判断。fable5-high の監査所見 C1〜C3 / M1〜M8 を反映)
Date: 2026-09-09
Sponsor: kawaz r292m10 (2026-09-09)「認証は passkey を使うのを基本にしたい」「登録はリモートではなくローカルから」、r292m18「引っ越しを考えると id は固定、iss は変更可能」
関連: 設計 §3.1 (入口の許可)、§7 (mesh)、§8.2 (config)、§9 (責務外)、`docs/issue/2026-09-09-mesh-tls-trust-root.md`

## 1. 背景

WS の入口は entry token (state ディレクトリの 0600 file) で守っていたが、これは「uid 境界を WS にも延ばす」以上の意味を持たず、tailnet 内・単一利用者の運用ではその境界を破れる相手が存在しない。一方で endpoint を利用者の proxy 配下の任意 URL にし、複数 instance を 1 つの origin の裏に置く構成 (相乗り / LB) と、instance の引っ越し (URL が変わる) が決まったため、入口は「誰が来たか」を答える認証を持ち、identity は URL から切り離す必要がある。

## 2. 決定

### 2.1 instance id は固定、endpoint は可変

- **instance id** は `ccmsg daemon add` の時に生成する乱数 (state ディレクトリに保存、引っ越しは state ごと持って行く)。契約の `instance` フィールド、`mid` (`<instance>/<連番>`)、kv / inbox / last_live の鍵、認証 record と token の発行者 (`iss`)、challenge に埋める発行者は全部この id
- **endpoint** は他 instance が dial する URL で、config の `self` (自分) と `peers` (相手) に書く。mesh の TLS 認証と `iss` / `aud` (mesh-peer-auth) の照合値はこの URL のまま (信頼の根は URL にしか無い)。handshake で相手は自分の instance id を名乗り、受けた側は「認証済み endpoint ↔ id」の対応を保持する。以後の `iss` (id) から dial 先を引くのはこの対応表
- 引っ越し = state を移す → 新 URL で起動 → 各 peer の `peers` を書き換える。record / token / mid は無効にならない
- 契約の `instance` の意味が「endpoint URL 完全一致」から「opaque な id」に変わるので **世代を 2 → 3 に上げる**。`hello` の応答と `peers` frame の instance 一覧に `endpoint` を別フィールドで持つ

### 2.2 登録はローカルからしかできない

`ccmsg daemon passkey add <unit> [endpoint] [--rp-id <domain>]` で登録用の一意 URL を 1 つ発行する。`unit` は instance (= config home) の名前。`endpoint` は省略で `self`、指定すれば利用者が proxy で用意した任意の URL (別名の追加登録用)。

- URL は `<endpoint の origin に配られている webui>/#register=<jwt>`。claims は `{ iss (instance id), sub, unit, endpoint, rp_id, exp (10 分), jti }`。`sub` は利用者の識別子で既定は `<unit>-<連番>`
- 署名は **登録ごとの乱数 secret による HMAC** (検証者 = 発行者なので公開鍵は要らない)。secret は発行 instance のメモリにだけ置き `exp` で破棄する。永続鍵は持たない
- webui は `/auth/challenge` で challenge を取り、`navigator.credentials.create()` (`residentKey: "preferred"`、`userVerification: "required"`、`user.id` = sub ごとの乱数 16 byte、`rp.id` = jwt の `rp_id`) を行い、credential と jwt を jwt の `endpoint` の `/auth/register` に POST する
- 受けた instance は `iss` が自分なら HMAC で jwt を検証し `jti` を消費する。WebAuthn 登録の検証 (L2 §7.1): `clientDataJSON.type` = `webauthn.create`、`challenge` = 発行した値、`origin` ∈ `entry.origins`、`crossOrigin` / `topOrigin` が無いこと、`authData.rpIdHash` = sha256(`rp_id`)、UP と UV の flag、`fmt` = `none` で `attStmt` が空、credential id が既存 record と重複しないこと。通ったら `{ sub, unit, credential id, COSE 公開鍵, user.id, 登録時刻 }` を **credential record** として保存する。`iss` が自分でなければ `iss` へ転送する (§2.6)
- `iss` が再起動していれば secret が消えて失敗する。登録に fallback は無く、CLI で URL を発行し直す (エラー文言は「登録 URL を再発行してください」)
- リモートからの登録経路は無い。復旧も CLI だけ。`passkey list` / `passkey remove <sub>`

### 2.3 RP ID は domain、既定は endpoint のホスト

WebAuthn の RP ID は origin ではなく domain で、passkey は「今開いているページの effective domain か、その registrable suffix」でしか作成・利用できない。既定の `rp_id` は endpoint のホストで、これは **webui が endpoint と同じホストから配られている**構成 (通常形) を意味する。webui を別サブドメインに置くなら `--rp-id` に共通の registrable domain を渡し、instance は「`rp_id` が endpoint のホストと一致するか、その registrable suffix である」ことだけを検証する。`clientDataJSON.origin` の期待値は endpoint の origin ではなく **webui の origin 集合 = `entry.origins`**。同じ RP ID の endpoint が複数あっても (`https://h.example/` と `https://h.example/personal`) credential は 1 つで足りる (record は cluster で 1 つ、複製される)。

### 2.4 token は record に紐づく opaque 値、family は単一 writer

アクセストークン / リフレッシュトークンは署名しない。乱数 (base64url、padding なし) を **token family** に入れて保存し、検証は lookup で行う。

- family = `{ id, sub, iss (mint した instance id), access: { value, exp }, refresh: { value, exp }, 直前世代の refresh }`。**family を書けるのはその `iss` だけ** (単一 writer)。refresh の rotate は必ず `iss` へ転送し、`iss` が落ちていれば passkey 認証で別 instance が新しい family を mint する。これで LWW 複製との衝突 (別 instance で並行 rotate → 合流で片方が消えて誤失効) が起きない
- credential record は登録後 `iss` を要らなくする (複製済みなので問い合わせ不要)。`iss` を持つのは challenge と family (短命) だけで、instance id は固定なので引っ越しでも変わらない
- アクセストークンは数時間、リフレッシュトークンは数日。rotate は使うたび。失効済みの値の再利用を見たら family を失効させるが、直前 1 世代だけは再送の猶予として受ける
- アクセストークンは WS の handshake に subprotocol `ccmsg.token.<値>` で載せる (サーバは選んだ subprotocol を echo する。proxy が `Sec-WebSocket-Protocol` を透過することが要件)。ブラウザはメモリにだけ持つ
- リフレッシュトークンは **httpOnly cookie**。名前は `__Secure-ccmsg-<sha256(instance id + "\n" + sub) の先頭 16 hex>`、値は opaque、`HttpOnly; Secure; SameSite=Strict; Path=<request のパスから /auth/ までの prefix>`。`Path` は帯域と露出面を絞るためで認可境界ではない (同一 origin の JS は任意パスに fetch できる)
- 認証と refresh は endpoint の `/auth/` 配下の HTTP。webui が別サブドメイン (§2.3 の `--rp-id` 構成) の時だけ、fetch は `credentials: "include"`、応答は `Access-Control-Allow-Origin: <その origin>` + `Allow-Credentials`。状態を変える `/auth/*` は cross-origin でなくても `Origin` を `entry.origins` と照合し、未認証で叩けるので rate limit を持つ (mesh-peer-auth §6 の鍵取得と同型)
- endpoint が `/` と `/personal` に分かれていれば cookie の Path も分かれるので、endpoint ごとに 1 回 passkey 認証が要る (record は共有されているので 2 回目以降は要らない)
- 期限切れの family は `iss` が消す (単一 writer なので GC も担う)

### 2.5 接続の期限

認証済みの WS はアクセストークンの `exp` までが期限 (`hello` の応答の `auth_expires_at`。UDS の user 接続には付かない)。クライアントは `exp` 前に `/auth/refresh` で新しいアクセストークンを得て、同じ接続上の `auth_refresh` op で期限を延ばす (切断しない)。怠った接続は instance が `exp` で切る。切られたら refresh → 再接続、refresh が無効なら passkey 認証 (`/auth/challenge` → `navigator.credentials.get()` → `/auth/assert`、record は `rawId` で引き `sub` は任意) → 新しい family → 再接続。`passkey remove` は該当 sub の family を全部失効させ、その sub で認証済みの WS を切る。

認証 (L2 §7.2) の検証: `type` = `webauthn.get`、`challenge`、`origin` ∈ `entry.origins`、`crossOrigin` / `topOrigin` 無し、`rpIdHash`、UP と UV、署名 (`authData || sha256(clientDataJSON)`) を ES256 (+ RS256 / Ed25519)。signCount は両方非 0 の時だけ単調増加を要求し (同期 passkey は常に 0)、退行は拒否。counter は family と同じく `iss` だけが書く。

### 2.6 record の複製と `iss` への問い合わせ

credential record と token family は peer 間で複製する。載せ先は **`kv` ではなく専用 topic `auth_records`** (`roles: ["instance"]`、element 粒度、LWW + tombstone。`kv` は user role が読み書きでき token が漏れる)。session / user role は購読も読み書きもできない。

知らない値を受けた instance は発行者 (`iss` = instance id) へ問い合わせる。契約に `auth_lookup` op (plane `common`、`roles: ["instance"]`、`needs_hello: true`、`locality: instance-local`) を足し、`to_instance = iss` で §7.3 の転送経路に載せる。問い合わせが要る場面は 3 つ:

- 登録 jwt の検証 (HMAC secret は `iss` にしかない)
- WebAuthn の challenge (発行 instance の id を challenge に含め、返ってきた側がそこへ転送して照合する。LB で発行と応答の instance が違ってよい。challenge は 16 byte 以上の乱数 + 発行者、寿命 5 分、使い切り)
- token family の lookup / rotate (単一 writer なので rotate は常に転送)

`iss` が落ちていれば refresh か passkey 認証に落ちる。侵害された peer にこれらが token を返す点は「token は cluster 内の共有秘密」の前提どおりで、新しい穴ではない。

tombstone: `passkey remove` は sub 単位の tombstone を credential と全 family に打ち、tombstone はその key への以後の書き込みを拒む (LWW の例外。分断中の instance が復活させられない)。保持は §7.5 の `LAST_LIVE_RETENTION_MS` と同じ 7 日。

### 2.7 ルートの mount と `self`

- mesh のルート (`/mesh/probe`、`/mesh/jwk/<kid>`) は `self` のパス配下 (§6.3 の鍵空間の分離)
- **人と gateway の入口** (`/ws`、`/auth/*`、`/webhook/<source>`) は **パスの末尾で照合**し、prefix を問わない。proxy は prefix を剥がさずそのまま渡し、cookie の Path は request のパスから取る。これで alias endpoint (`https://alias.example/…`) や LB (同じパスで複数 instance を束ねる) が `self` と無関係に成立する
- LB で束ねる instance 群は、人の入口のパスが同じで endpoint のホストが違う。`peers` に LB の名前は入れない
- `self` を config に持つことは §7.1 の probe 方式を置き換える (mesh-self-identification の「self を設定に書かない」を supersede)。probe は起動時の `peers` 検証 (`self` ∈ `peers` の照合と到達性) として残す。`self` の InstanceId は `ws(s)://`、HTTP ルートは同じ host / path の `http(s)://` として読む
- `self` と一致しない URL で来た mesh の `hello` は `aud` 不一致で拒否する。人の入口は `self` を名乗らないので、どの FQDN 経由でも token だけで判定する。challenge に埋める発行者は instance id で、endpoint の URL は未認証の相手に見せない

### 2.8 entry token の廃止

state ディレクトリの `entry.token` と subprotocol / `?token=` による照合は削除する。`entry.origins` は `clientDataJSON.origin` と CORS の期待値として残る。UDS (到達 = 権限) / mesh (TLS + `iss`/`aud` + proof) / webhook (Bearer) は変わらない。

### 2.9 契約の変更 (世代 3)

- `instance` は opaque id。`hello` 応答と `peers` の instance 一覧に `endpoint`。`mid` の `<instance>` も id
- HTTP 経路 `/auth/challenge` / `/auth/register` / `/auth/assert` / `/auth/refresh` は「`needs_hello: false` の op を HTTP で運ぶもの」として op 属性表に載せる (M1 原則: 認可の分岐を表の外に置かない)
- WS op `auth_refresh` (接続の期限を延ばす)、instance 間 op `auth_lookup`、topic `auth_records`
- `hello` 応答に `auth_expires_at` (optional)

### 2.10 実装は自前

WebAuthn の検証は library を入れずに書く。要るのは小さな CBOR decoder (attestationObject / COSE 鍵) と WebCrypto (ES256 / RS256 / Ed25519 の verify、sha256、HMAC) だけ。

## 3. 不採用

| 案 | 理由 |
|---|---|
| entry token を残す | 破れる相手が現状の構成に居ない。外に出す時は passkey がその役を担う |
| 人の認証を前段 (caddy forward_auth / tailscale identity) に寄せる | 前段の構成が利用者ごとに違い、daemon が「誰か」を知る形が揃わない。passkey は daemon 自身が判定でき、前段は透過でよい |
| instance の永続鍵で token を署名する | 管理物 (鍵の保管・rotate・配布) が増える。record の lookup + `iss` への問い合わせで同じことが鍵なしで出来る |
| record を `kv` に載せる | `kv` は user role が読み書きでき、token (共有秘密) が漏れ、record の改竄で権限昇格できる |
| token family を複数 instance が書く | LWW 複製との合流で rotate が消え、再利用検知が誤発火する |
| token を localStorage に置く | XSS 1 つで長期 token が抜ける。httpOnly cookie は same-site で送れる |
| アクセストークンの `exp` で必ず切断する | 画面が周期的に瞬く。同じ接続で延ばす op を置き、切るのは怠った時だけ |
| 全ルートを `self` のパス配下に固定する | alias endpoint と LB で 404 / cookie Path 不一致になる。`self` に縛る必要があるのは mesh の鍵空間だけ |
| instance id を endpoint URL (or そのハッシュ) にする | 引っ越しで record / mid / kv の鍵が全部無効になる |
| WebAuthn library を入れる | 細かい制御 (attestation `none` 固定、challenge の転送) が要件に合わない可能性。検証手順は短い |
| リモートからの登録・復旧経路 | 登録がローカルに閉じることが安全性の根 |

## 4. 影響

- 契約 major (世代 3): `instance` の意味、`endpoint`、auth 経路 / op / topic → daemon (instance id の生成と保存、`self` の config 化、ルートの末尾照合、CLI `passkey add|list|remove`、`/auth/*`、WebAuthn 検証、cookie、family、`auth_records` の複製、entry token 削除) → webui (登録画面、passkey 認証、refresh、token をメモリに)
- 設計 §3.1 (WS の entry token → passkey)、§7.1 (probe → `self` config + peers 検証)、§8.2 (`self` と `instances[].id`)、§9 (人の認証は本 DR) を書き換える
- `docs/issue/2026-09-09-mesh-tls-trust-root.md` は「TLS 終端は proxy、daemon の listener は plain のまま」で扱いが変わる (別途更新)
