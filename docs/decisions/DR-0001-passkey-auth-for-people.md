# DR-0001: 人の認証は passkey、token は record に紐づく opaque 値、鍵は持たない

Status: Accepted (2026-09-09。骨子は kawaz 裁定、細部は統括判断。監査所見を反映)
Date: 2026-09-09
Sponsor: kawaz (2026-09-09)「認証は passkey を使うのを基本にしたい」「登録はリモートではなくローカルから」「引っ越しを考えると id は固定、iss は変更可能」
関連: 設計 §3 (認証と入口)、§7 (mesh)、§8.2 (設定)、§8.6 (責務外)、`docs/issue/2026-09-09-mesh-tls-trust-root.md`

> §2.7 の「自分の endpoint は probe で確定する」は [DR-0004](DR-0004-config-edited-and-applied.md) §2.4 に置き換わった (設定のエンドポイント一覧のうち自分の id を持つ行が自分の endpoint)。本 DR の他の判断は現役。

## 1. 背景

WS の入口は entry token (state ディレクトリの 0600 file) で守っていたが、これは「uid 境界を WS にも延ばす」以上の意味を持たず、tailnet 内・単一利用者の運用ではその境界を破れる相手が存在しない。一方で endpoint を利用者の proxy 配下の任意 URL にし、複数 instance を 1 つの origin の裏に置く構成 (相乗り / LB) と、instance の引っ越し (URL が変わる) が決まったため、入口は「誰が来たか」を答える認証を持ち、identity は URL から切り離す必要がある。

## 2. 決定

### 2.1 instance id は固定、endpoint は可変

- **instance id** は `ccmsg daemon add` の時に生成する乱数 (state ディレクトリに保存、引っ越しは state ごと持って行く。`daemon run [dir]` で `instances[]` に無い config home を起こした時も初回起動で state に生成する)。契約では `InstanceId` (opaque id) と `Endpoint` (URL) を別の型にし、`mid` の pattern も id の文字集合に合わせる。契約の `instance` フィールド、`mid` (`<instance>/<連番>`)、kv / inbox / last_live の鍵、認証 record と token の発行者 (`iss`)、challenge に埋める発行者は全部この id
- **endpoint** は instance の公開 base URL (`https://h.example/` や `https://h.example/personal/` のように `http(s)://` でパスは prefix まで、`/ws` を含まない) で、config の `peers` に書く。WS (`<endpoint>ws`)、mesh (`<endpoint>mesh/*`)、認証 (`<endpoint>auth/*`)、webhook (`<endpoint>webhook/*`) はその下に導かれる transport / route であって endpoint の一部ではない (将来 `/ws` 以外の transport に移っても endpoint は変わらない) (自分の分も含めた同じリストを全 instance に配る。自分がどれかは起動時の probe で確定する = §7.1、config に `self` は持たない)。mesh の TLS 認証と `iss` / `aud` (mesh-peer-auth) の照合値はこの URL のまま (信頼の根は URL にしか無い)。handshake で相手は自分の instance id を名乗り (`MeshHello` に id を足す。proof の後に hello の内容が遡及して信頼される mesh-peer-auth §5.1 R7 の規則に乗る)、受けた側は「認証済み endpoint ↔ id」の対応を保持する。以後の `iss` (id) から dial 先を引くのはこの対応表。**1 つの id は 1 本の認証済み link にしか束縛できない**: 束縛表は自分の (endpoint, id) で初期化する (= 自分の id を名乗る peer も拒む)。既に別 endpoint に束縛済みの id を名乗る hello は、新しく来た側を close する (endpoint リストが唯一の信頼源なので、既存の束縛を優先する)。引っ越し直後に旧 URL の instance がまだ生きている場合がこれに当たり、各 peer が `peers` を書き換えて再起動すると旧 endpoint はリストに無くなって落ち、新 endpoint からの handshake でその id が束縛し直される。全 instance のリストを更新して回るのは引っ越しの必要コスト
- 引っ越し = state を移す → 新 URL で起動 → 各 peer の `peers` を書き換える。record / token / mid は無効にならない
- 契約の `instance` の意味が「endpoint URL 完全一致」から「opaque な id」に変わるので **世代を 2 → 3 に上げる**。`hello` の応答と `peers` frame の instance 一覧に `endpoint` を別フィールドで持つ。一覧の `id` は handshake が成立するまで未知なので optional (endpoint だけ分かっている peer も一覧に出す)。mesh を持たない instance は名乗る URL が無いので `hello.endpoint` も optional

### 2.2 人を作るのはローカルからしかできない

`ccmsg user create [--origin <origin>] [--all]` で登録用の一意 URL を 1 つ発行する。**認証の単位は人**で、その人が持っている instance に入れる (契約 DR-0030)。`--origin` は人を送る page の origin で、既定はこの instance の endpoint の origin。

既に居る人にこの instance を持たせる経路が 2 本ある。`ccmsg user add <user-id>` は所有 record を 1 行書くだけで browser を要らない (mesh の複製でその人を既に知っている場合)。`ccmsg user add <user-id> --enroll` は所有者を足す URL と 6 桁を出し、本人が既存 passkey で assert する。どちらも新しい passkey は作らない。

**どちらの経路も、その人の credential が複製で届いている instance でしか成立しない。** assert の検証には公開鍵が要り、それが届く経路は `auth.records` の複製しか無いからで、直書きの方は user record が無ければ `not_found` で断る。mesh の外の instance は別の mesh なので、そこで人が入るには `user create` で作り直す。加えて **`--enroll` の URL が名乗る origin は、その人が既に passkey を持っている origin でなければならない**: ceremony は人が送られた page で走るので `clientDataJSON.origin` はその origin になり、検証は credential の origin に照らすため、2 つが違えば assert が通らない。

- URL は `<origin>/#enroll=<jwt>` で、人を送る先が origin の直下。claims は `EnrollClaims` = `{ iss (instance id), purpose (`create_user` | `add_owner`), instance, origin, endpoint, expires_at (既定 10 分), jti, user (create_user だけ), issued_label?, display_name?, instances? }`。`endpoint` は page が POST する宛先であって**照合しない** (LB の住所でよく、どの instance に着弾しても成立する)
- 署名は **登録ごとの乱数 secret による HMAC** (検証者 = 発行者なので公開鍵は要らない)。secret は発行 instance のメモリにだけ置き `exp` で破棄する。永続鍵は持たない
- page は `/auth/challenge` で challenge を取り、`navigator.credentials.create()` (`residentKey: "preferred"`、`userVerification: "required"`、`user.id` = jwt の `user` (= その人の id そのもの。乱数 16 byte で、発行 instance が人を作る時に 1 度決める)、**`user.name` と `user.displayName` = 登録画面で人が確定した名前** (初期値は jwt の `display_name`。下記)、`rp.id` = jwt の `origin` の host、`rp.name` = サービス名) を行い、credential と jwt と 6 桁を jwt の `endpoint` の `/auth/register` に POST する
- **受けた instance が自分で検査し、自分で record を書き、自分で応答する** (発行 instance でなくてよい)。WebAuthn 登録の検証 (L2 §7.1): `clientDataJSON.type` = `webauthn.create`、`challenge` = 発行した値、`origin` が claims の `origin` と完全一致、`crossOrigin` が `true` でないこと (Chrome 系は常に `false` を送る) と `topOrigin` が無いこと、`authData.rpIdHash` = sha256(claims の `origin` の host)、UP と UV の flag、`fmt` = `none` で `attStmt` が空、credential id が既存 record と重複しないこと。通ったら user record・credential record・所有 record を書く。発行者に問うのは**発行者のメモリにしか無い物だけ** (jwt の真正・`jti`・期限・6 桁と試行回数) で、`auth.resolve` で転送する (§2.6)
- **どの instance を持たせるかは URL を出した端末で決まり、claims の `instances` が運ぶ** (`--all` なら、その時点で知っている peers 全部)。所有 record を書くのは **ceremony が成立した時**で、書くのは着弾した instance (`granted_by` は URL を出した instance)。着弾側が自分の知識で書くと LB の裏では別の集合になり、発行時に書くと、使われなかった URL の granting がどの user record も答えない人を名指したまま残る
- `iss` が再起動していれば secret が消えて失敗する。登録に fallback は無く、CLI で URL を発行し直す (エラー文言は「登録 URL を再発行してください」)
- リモートから人を作る経路は無い。復旧も CLI だけ。`user list` / `user remove <user-id>` / `user passkey list <user-id>` / `user passkey remove <credential-id>`
- **`user.name` には人が読む名前を渡す** (kawaz 実機観測 2026-09-18、1Password): passkey manager がアイテムに保存するのは `username` = `user.name` だけで、**`user.displayName` は保存されない**。アイテム名は registrable domain (`kawaz.jp`) で、`rp.name` は使われない。したがって人が manager の一覧で自分のアカウントを見分けられるかは `user.name` 1 つに懸かっており、ここに `user.id` (乱数 16 byte) が出てはいけない。`displayName` には同じ値を渡す (保存されないが、ceremony 中の UI が読む browser がある)。運ぶのは jwt の **`display_name`** で、これは初期値にすぎない: 登録画面はこの値を入れた入力欄を見せ、**人が確定した値を `auth.register` の `display_name` で返す**。人を作る URL の初期値は `user create --name <ラベル>` の値、既に居る人に passkey を足す URL ではその人が既に読んでいる `display_name` (足す先は本人が名付け済みの account なので、**登録は改名しない**)。どれも無ければ短い既定の語。成立したらその値が user record の `display_name` になり、以後は `ccmsg user rename` が変える。`issued_label` と分けてあるのは、あちらが「誰に渡した URL か」という管理者のメモで credential に残る物だからで、1 つの値に兼ねさせると管理者の私的なメモが本人の名前として表示される。**`user rename` の後も manager 側の表示は作られた時のままになる**のは境界で、直す手段は browser 側にしか無い (Chrome の Signal API `signalCurrentUserDetails`。対応する browser でだけ呼ぶ任意の追加)
- **保守情報**: 名前は 3 つあり意味が違う。`--label <メモ>` は管理者が「誰宛に発行した URL か」を記す管理メモで、credential に `issued_label` として残り、**本人には見えない**。`--name <名前>` はアカウント名の初期値で、jwt の `display_name` に載って認証器と登録画面に出る。2 つを分けてあるのは、1 つの値に兼ねさせると管理者の私的なメモが本人の名前として表示されるため (契約 DR-0030 §4)。登録ページの端末名入力は利用者が「どの端末の passkey か」を記す端末ラベル (複数端末を持つ利用者が自分の一覧から保守するためのもの)。`display_name` はアカウントの名前で、登録画面で人が確定し、認証器に渡り、user record に残る — 3 つのうち passkey manager が本人に見せるのはこれ。どれも認証には効かない。credential record は `issued_label` / `device_label` / `user_agent` / `registered_at` / `registered_ip` / `last_used_at` を持ち、`user passkey list` はこれを並べる
- **CLI 提示コード**: URL を出すコマンドが 6 桁のコードを表示し (URL には含めない。登録の一次 secret と一緒に発行 instance が保持)、ページはそれを入力させ `/auth/register` に添える。URL を持っているだけでは登録できない (URL 漏洩への防御)。jwt から導出したコードを両方に表示して目視照合する形は「端末が CLI の隣にある」確認にしかならないので採らない

#### 任意のゲート (最低限プロトコルの上に独立に積む。ccmsg では後続)

- **ホスト PC の FIDO 承認**: 発行 instance は `/auth/register` を受けても完了せず保留し、URL を出した CLI に登録内容 (名前 / 端末 / コード / 時刻) を提示して OS の生体認証 (macOS は LocalAuthentication) を要求、CLI からの承認で完了する。離席中の第三者による登録を防ぐ。承認の起点を CLI に置くのは、登録がローカルに閉じている §2.2 の性質をそのまま延ばすため

### 2.3 credential が何に縛られるか

> Superseded: 契約 `ccmsg-protocol` の DR-0030 に置き換わった。credential が持つ束縛は **`origin` 1 つ** (どの page から来てよいか) で、RP ID はその origin の host。どの instance に入ってよいかは credential の問いではなく、**所有 record** が答える。同じ origin の別 path は browser が見分けないので、1 つの host に複数 instance を出す形は持たない (host を分ける)。

### 2.4 token は record に紐づく opaque 値、family は単一 writer

アクセストークン / リフレッシュトークンは署名しない。乱数 (base64url、padding なし) を **token family** に入れて保存し、検証は lookup で行う。

- family = `{ user, iss (mint した instance id), origin, access: { value, exp }, refresh: { value, exp }, 直前世代の refresh, retired }`。**所有されているどの instance でも書ける** (契約 DR-0030)。`iss` は mint した記録であって書き手を制限しない。rotate は着弾した instance がその場で書き、転送しない
- 並行 rotate が競合したら、負けた側の端末が持つ値は family のどの世代にも無い値になる。**知らない値の提示は `auth_invalid` で断るだけで、family は失効させない**。負けた側は passkey で入り直す
- family の失効 (再利用検知) は family tombstone (7 日) として複製し、分断中の peer が持つ stale copy も復帰後に失効させる。**失効させるのは `retired` の digest に一致した時だけ**で、それが replay の検知そのもの
- credential record は登録後 `iss` を要らなくする (複製済みなので問い合わせ不要)。`iss` を持つのは challenge と family (短命) だけで、instance id は固定なので引っ越しでも変わらない
- **アクセストークンは family に 1 本で、その人が開いている複数のページ (タブ) が共有する。** rotate は refresh cookie を毎回回すが、アクセストークンは残り寿命が TTL の半分を切るまで据え置き、それ以降だけ mint し直す。毎回差し替えると、あるタブの読み込みが他のタブの持つトークンを無効にしてしまう (残り半分は、新しい値に気づくための猶予として最大に取れる閾値)
- アクセストークンは数時間、リフレッシュトークンは数日。rotate は使うたび。family は退役した refresh 値のハッシュを本来の exp まで保持し、**どの世代の値でも再利用を見たら family を失効させる**。直前 1 世代だけは再送の猶予として (猶予時間内に限り) 前回の答えを返す
- アクセストークンは WS の handshake に subprotocol `ccmsg.token.<値>` で載せる (サーバは選んだ subprotocol を echo する。proxy が `Sec-WebSocket-Protocol` を透過することが要件)。ブラウザはメモリにだけ持つ
- リフレッシュトークンは **httpOnly cookie**。名前は `__Secure-ccmsg-<sha256(user id) の先頭 16 hex>` で **instance を含めない** (契約 DR-0030。family は複製され所有されているどの instance でも rotate できるので、名前が instance で変わると LB の裏で自分の cookie を認識できない)、値は opaque、`Path=<request のパスから /auth/ までの prefix>`。`Path` は帯域と露出面を絞るためで認可境界ではない (同一 origin の JS は任意パスに fetch できる)。`SameSite` の決め方は契約 `ccmsg-protocol` の DR-0028 が決める (credential の origin と endpoint が same-site なら `SameSite=Strict`、cross-site なら `SameSite=None; Partitioned`。属性の組み立ては daemon の持ち物)。**判定の相手は要求が到達した host** (`Host` / `:authority` から組んだ origin) で、config の endpoint ではない: cookie は browser が到達した host で綴じられ、LB の裏ではその host は LB のもので、config の endpoint は peer が 1 対 1 で dial する住所 (別 site でありうる) だから。呼び手がこのヘッダを書けるが、書いて得る物は無い (自分の cookie が送られにくくなるだけ)
- 認証と refresh は endpoint の `/auth/` 配下の HTTP。許可する origin の集合は契約 `ccmsg-protocol` の DR-0030 §9 / DR-0028 が決める (**`challenge` と `register` は全 origin に開き**、それ以外 (`enroll` / `assert` / `refresh` / `signout`) の集合は「この instance が持っている credential record の origin」。所有では絞らない — 集合が答えるのは「その page を知っているか」で、「その人が入ってよいか」は所有が答える。照らす相手を持つ 5 op は `Origin` と `Sec-Fetch-Site` の 2 ヘッダに照らされ、どちらも不在は不一致)。未認証で叩けるので rate limit を持つ (mesh-peer-auth §6 の鍵取得と同型)
- 期限切れの family は読んだ時点で落ちる (時計で掃かない)
- LB で challenge の発行と応答の instance が違う時は、**応答を受けた instance が assertion を検証**し、challenge の消費だけを発行者へ問い合わせる。mint する family の `iss` は応答を受けた instance

### 2.5 接続の期限

認証済みの WS はアクセストークンの `exp` までが期限 (`hello` の応答の `auth_expires_at`。UDS の user 接続には付かない)。クライアントは `exp` 前に `/auth/refresh` で新しいアクセストークンを得て、同じ接続上の `auth.extend` op で期限を延ばす (切断しない)。怠った接続は instance が `exp` で切る。切られたら refresh → 再接続、refresh が無効なら passkey 認証 (`/auth/challenge` → `navigator.credentials.get()` → `/auth/assert`、record は `rawId` で引き、誰かを名乗る必要は無い) → 新しい family → 再接続。所有を外すと、その instance でその人が開いている WS が切れる。**passkey を消しても token family は失効させない** (契約は daemon に委ねている)。ログアウトは `/auth/signout` で、cookie が名指す family を失効させ (family tombstone)、応答で cookie を期限切れにする。cookie は HttpOnly なので page からは消せず、page が消せたとしても family は立ったままである。所有は見ず、期限切れの値も受け、どの family も名指さない値だけを `auth_invalid` で断る (契約 `auth.signout`)。消えるのは次に入る手段であって今のセッションではなく、今のセッションを終わらせたい人は所有を外すか、refresh の期限 (7 日) を待つ。1 本消したら残りの passkey で入り続けられるのが普通の姿で、最後の 1 本だけ違う扱いにすると「何本目を消したか」で挙動が変わる。

認証 (L2 §7.2) の検証: `type` = `webauthn.get`、`challenge`、`origin` が record の `origin` と完全一致、`crossOrigin` が `true` でないこと、`topOrigin` 無し、`rpIdHash` が sha256(record の `origin` の host)、UP と UV、`userHandle` が record の `user` と一致、そして**その人がこの instance の所有者であること**、署名 (`authData || sha256(clientDataJSON)`) を ES256 (+ RS256 / Ed25519)。signCount は record の値が非 0 なら提示値 > record を要求し (提示 0 も退行として拒否)、record が 0 なら提示値をそのまま保存する (同期 passkey は常に 0)。counter は credential record の一部で、認証を受けた instance が書く (record は LWW で複製され、退行検知は最終的に整合すればよい)。

### 2.6 record の複製と `iss` への問い合わせ

user record・credential record・所有 record・token family は peer 間で複製する。載せ先は **`kv` ではなく専用 topic `auth.records`** (`roles: ["instance"]`、element 粒度、LWW + tombstone。`kv` は user role が読み書きでき token が漏れる)。session / user role は購読も読み書きもできない。

知らない値を受けた instance は発行者 (`iss` = instance id) へ問い合わせる。契約の instance 間 op は `auth.resolve` (jwt / challenge の検証と消費。plane `common`、`roles: ["instance"]`、`needs_hello: true`、`locality: owner_instance`) の 1 つで、`to_instance = iss` で §7.3 の転送経路に載せる。`auth.records` は relay の `caller` を付けず instance role のまま購読する (relay が `caller: user` を付ける他の topic と違う)。問い合わせが要る場面は 2 つ:

- 登録 jwt と 6 桁の検証 (HMAC secret も試行回数も `iss` にしかない)
- WebAuthn の challenge (発行 instance の id を challenge に含め、返ってきた側がそこへ転送して照合する。LB で発行と応答の instance が違ってよい。challenge は 16 byte 以上の乱数 + 発行者、寿命 5 分、使い切り)

`iss` が落ちていれば URL を出し直す。token family は複製済みで所有されているどの instance でも書けるので、問い合わせは要らない。侵害された peer にこれらが token を返す点は「token は mesh 内の共有秘密」の前提どおりで、新しい穴ではない。

tombstone: 対象を名指すフィールドを持たず、**打たれた key が何を消したかを言う** (契約 DR-0030)。key は `user/<user>` / `credential/<credential_id>` / `ownership/<instance>/<user>/<grant>` / `family/<id>` の 4 種で、tombstone はその key への以後の書き込みを拒む (LWW の例外。分断中の instance が復活させられない)。**credential と所有の tombstone は保持期限を持たない** (7 日超の分断から復帰した peer の snapshot で復活するのを防ぐ)。family は refresh の exp で自然失効するので tombstone は 7 日で足りる。

所有を「外して足し直す」が出来るのは、granting が毎回新しい乱数 id を持ち、それが key の末尾に入るため。外す = その (instance, user) の生きている granting 全部に tombstone、足し直す = 新しい key への 1 行。

### 2.7 ルートの mount と自分の endpoint

- mesh のルート (`<endpoint>mesh/probe`、`<endpoint>mesh/jwk/<kid>`) は自分の endpoint のパス配下 (§6.3 の鍵空間の分離)
- **人と gateway の入口** (`/ws`、`/auth/*`、`/webhook/<source>`) は **パスの末尾で照合**し、prefix を問わない。proxy は prefix を剥がさずそのまま渡し、cookie の Path は request のパスから取る。これで alias endpoint (`https://alias.example/…`) や LB (同じパスで複数 instance を束ねる) が自分の endpoint と無関係に成立する
- LB で束ねる instance 群は、人の入口のパスが同じで endpoint のホストが違う。`peers` に LB の名前は入れない
- 自分の endpoint は §7.1 の probe で確定する (mesh-self-identification のとおり。proxy / alias 越しでも probe は Host を見ずに「自分に届いたか」だけで決まるので成立する)。config に `self` は持たない (「どれが自分か知らずに同じリストを配れる」性質を壊さないため)。到達しなかった peer は一致数から外し、一致 0 / 2 以上で起動失敗。WS の dial 先も `<endpoint>ws` のまま (`https:` の URL に対する HTTP upgrade。`wss:` への書き換えはしない)
- 確定した自分の endpoint と一致しない URL で来た mesh の `hello` は `aud` 不一致で拒否する。人の入口は endpoint を名乗らないので、どの FQDN 経由でも token だけで判定する。challenge に埋める発行者は instance id で、endpoint の URL は未認証の相手に見せない

### 2.8 entry token の廃止

state ディレクトリの `entry.token` と subprotocol / `?token=` による照合は削除する。`entry.origins` も削除する (設定に page の一覧は持たない)。WS の `Origin` の扱いは契約 `ccmsg-protocol` の DR-0030 §9 が決める (upgrade は token の family が持つ `origin` と照合し、`Origin` 不在も不一致として upgrade を拒否する。加えてその人がこの instance の所有者であることを照らす)。`entry` に残るのは bind (host / port) と `source_ips` だけ。UDS (到達 = 権限) / mesh (TLS + `iss`/`aud` + proof) / webhook (Bearer) は変わらない。

### 2.9 契約の変更 (世代 3)

- `instance` は opaque id。`hello` 応答と `peers` の instance 一覧に `endpoint`。`mid` の `<instance>` も id
- HTTP 経路 `/auth/challenge` / `/auth/register` / `/auth/enroll` / `/auth/assert` / `/auth/refresh` / `/auth/signout` は「`needs_hello: false` の op を HTTP で運ぶもの」として op 属性表に載せる (M1 原則: 認可の分岐を表の外に置かない)。identity 未確定の接続から呼べる点は `hello` と同じ扱いで、`request_id` は HTTP の carrier 側が合成する
- WS op `auth.extend` (接続の期限を延ばす) / `auth.account.read` / `auth.ownership.remove` / `auth.credential.remove`、instance 間 op `auth.resolve`、topic `auth.records`
- `InstanceId` と `Endpoint` の型分離、`MeshHello` に id
- `hello` 応答に `auth_expires_at` (optional)

### 2.10 転送する認証 op が運ぶもの

`auth.resolve` の `claims` は jwt と **6 桁コード**を運び、発行 instance が jwt / コード / 試行回数を検証する (受けた instance は何も消費しない)。`user` は発行 instance が人を作る時に 1 度決めて jwt に載せる。

### 2.11 実装は自前

WebAuthn の検証は library を入れずに書く (kawaz 判断)。

**理由**: 要件に細かい制御が要る。attestation は `none` 固定にしたく、challenge は発行 instance と検証 instance が違う構成 (LB) で転送する。一方で検証手順そのものは短く、要るのは小さな CBOR decoder (attestationObject / COSE 鍵) と WebCrypto (ES256 / RS256 / Ed25519 の verify、sha256、HMAC) だけである。

**条件**: 自前で持つ以上、**テストは既存ライブラリに劣らない水準まで徹底する**。何をどこまで固定するかは issue `webauthn-tests-library-grade` が持つ。

**その後**: テストをやり切った時点で既存ライブラリ (`@simplewebauthn/server` 等) を改めて調査・比較する。ライブラリの方が良ければ書き直してよいし、自前の方が良ければ既存を超える品質に仕上げ直す。どちらでもよい。

## 3. 不採用

| 案 | 理由 |
|---|---|
| entry token を残す | 破れる相手が現状の構成に居ない。外に出す時は passkey がその役を担う |
| 人の認証を前段 (caddy forward_auth / tailscale identity) に寄せる | 前段の構成が利用者ごとに違い、daemon が「誰か」を知る形が揃わない。passkey は daemon 自身が判定でき、前段は透過でよい |
| instance の永続鍵で token を署名する | 管理物 (鍵の保管・rotate・配布) が増える。record の lookup + `iss` への問い合わせで同じことが鍵なしで出来る |
| record を `kv` に載せる | `kv` は user role が読み書きでき、token (共有秘密) が漏れ、record の改竄で権限昇格できる |
| credential を endpoint に縛る | LB の FQDN がどの endpoint とも一致せず、HA の裏に入れない。複製した record を隣の instance が使えないので、複製の目的が果たされない (契約 DR-0030) |
| token を localStorage に置く | XSS 1 つで長期 token が抜ける。httpOnly cookie は same-site で送れる |
| アクセストークンの `exp` で必ず切断する | 画面が周期的に瞬く。同じ接続で延ばす op を置き、切るのは怠った時だけ |
| `self` を config に持つ | probe で確定できるものを設定にすると、同じリストを全 instance に配れる性質が壊れる。proxy 越しでも probe は Host を見ないので成立する |
| 全ルートを `self` のパス配下に固定する | alias endpoint と LB で 404 / cookie Path 不一致になる。`self` に縛る必要があるのは mesh の鍵空間だけ |
| instance id を endpoint URL (or そのハッシュ) にする | 引っ越しで record / mid / kv の鍵が全部無効になる |
| WebAuthn library を入れる | attestation `none` 固定と challenge の転送という細かい制御が要件で、検証手順自体は短い (§2.11)。テストを既存ライブラリ並みに固めた後で、改めて比較する |
| リモートからの登録・復旧経路 | 登録がローカルに閉じることが安全性の根 |

## 4. 影響

- 契約 major (世代 3): `instance` の意味、`endpoint`、auth 経路 / op / topic → daemon (instance id の生成と保存、自分の endpoint の probe による確定、ルートの末尾照合、CLI `user create|add|list|remove|rename` と `user passkey add|list|remove`、`/auth/*`、WebAuthn 検証、cookie、family、`auth.records` の複製、entry token 削除) → webui (登録画面、passkey 認証、refresh、token をメモリに)
- 設計 §3.1 (WS の entry token → passkey)、§3.6 (永続化に instance id / user record / credential record / 所有 record / token family を足す。id は資源ハンドルでなく identity、auth records は kv と同じく派生値でない。§11.3 の「増やさない」検査もこれに合わせる)、§7.1 (probe による自己識別はそのまま。id を名乗る手順を足す)、§8.2 (`peers` に自分の URL を含める = 全 instance 同じリスト)、§9 (人の認証は本 DR) を書き換える
- `docs/issue/2026-09-09-mesh-tls-trust-root.md` は「TLS 終端は proxy、daemon の listener は plain のまま」で扱いが変わる (別途更新)
