# DR-0003: op / topic / 型名の統一規則

Status: Accepted (2026-09-11。統括裁定、kawaz 裁定 r303「hello 前に許すのは `hello.*` だけ」を含む)
Date: 2026-09-11
Sponsor: 統括裁定 (2026-09-11)。対応表の起草に対する 13 項の裁定
関連: 設計 §2 (契約との関係と層)、§3.1 (挨拶と役割)、§7 (mesh)、[DR-0002](DR-0002-contract-holds-the-vocabulary.md)

## 1. 背景

op 名・topic 名・item の型名が、`_` 区切りと `.` 区切りと `:` 付きの 3 系統に分かれて育っていた。契約は 3 リポ (protocol / daemon / webui) が共有する語彙なので、綴りの揺れは「どちらの綴りでこの transcript は書かれたか」を読み手に問わせる。名前の形を 1 度決め、機械検査に載せる。

## 2. 決定

### 2.1 区切り文字の意味を 3 つに固定する

- **`.`** = 階層。prefix で配下をまとめて選べる (`tool` は `tool.*` 全部)
- **`:`** = パラメータ。**名前の末尾に 1 回だけ** (`transcript.items:<sid>`)
- **`_`** = 1 語の結合にだけ使う (`user_id` のような語内の連結)。階層の代わりに使わない

### 2.2 hello は role ごとに 3 つ

`hello.session` / `hello.user` / `hello.instance`。**op 名が role なので `role` フィールドは持たない**。`HelloResult` は 3 つで共通。

**WS 接続で hello の前に許す op は `hello.*` だけ**。身元不明の呼び手に ping を答える意味が無いので `instance.ping` も `needs_hello: true`。唯一の呼び手である監督者の `daemon status` は既に `hello.user` してから ping している。HTTP carrier の `auth.challenge` / `auth.register` / `auth.assert` / `auth.token.refresh` は接続を持たないので `needs_hello` の対象外として別に書く。

### 2.3 開いた 3 族の最終セグメントは規則の適用外

`tool.<Name>` / `system.attachment.<kind>` / `hook.<Event>` の最終セグメントは **harness の綴りをそのまま使う**。文字集合は `[A-Za-z0-9_-]+` で `.` を含めない。harness 名に `.` が含まれる場合は daemon が命名時に `_` へ写す。これにより「最終セグメントに `.` は現れない、階層の読み手は `.` で分割してよい」が成り立つ。

### 2.4 `mesh.*` は作らない

mesh は専用の op を持たない。instance 同士のやり取りは `hello.instance` と、転送の封筒 (`RequestEnvelope`) の 3 欄で表される。

### 2.5 根の topic は複数形、op の親 `instance` は単数

根に置く topic (`peers` / `agents` / `instances` / `inbox`) は集合なので複数形で揃う。op の親 `instance` は「この instance」なので単数。この非対称は意図したもの。

### 2.6 改名

`auth_refresh_token` → `auth.token.refresh` (HTTP で token family を回す。対象が token)、`auth_refresh` → `auth.extend` (WS で `auth_expires_at` を延ばす。「認証を延長する」で動詞 1 つ足り、`refresh` と別の動詞なので親子の誤読が起きない)、`say_mark_read` → `say.unread.clear`、`session_fork_origin` → `session.fork.origin.read`、`session_last_live_remove` → `session.forget`、`file_stat_batch` → `file.stat`、`system:api-error` → `system.api.error`。

`session.forget` の名は、`last_live` という一覧がもう無い (lost な行は `peers` の `state` で表される) ことによる。定数 `LAST_LIVE_RETENTION_MS` は保持窓の名前なのでそのまま。

### 2.7 機械検査は形の正規表現 + 許可リストの 2 段

`_` を含むセグメントの許可リストは **初期値を空にする**。空でも「後から `_` 2 語連結を足したら落ちる」仕掛けとして効く。開いた 3 族の最終セグメントは検査対象外。

### 2.8 既存 config の `dump.presets` は読み込み時に弾く

型選択子が新しい規則のパターンに合わない場合、preset 名と該当文字列を挙げて config error にする。**黙って空 dump にしない。互換層は置かない。**

## 3. 不採用

| 案 | 理由 |
|---|---|
| 旧名の alias を残す | 同じものが語彙に 2 度立ち、選択子がどちらの綴りかを問うことになる |
| `mesh.*` の op 族を作る | 転送は封筒の 3 欄で足りる。surface ごとに op を複製すると二重定義になる |
| `hello` を 1 つにして `role` フィールドで分ける | op 名が role を言えば、属性表の `roles` と handler の分岐が 1 つで済む |
| `last_live` を op 名に残す | その名の一覧がもう無い |
| 既存 config に互換層を置く | 互換層は「いつ剥がすか」を管理物として増やす。本番の書き換えは deploy 時に 1 度行えば済む |

## 4. 影響

- 契約 (op / topic / 型名、`TranscriptItemType` の doc に `tool.unknown` の予約名を 1 文)、daemon、webui の localStorage の正規表現、CLI の completion 定義
- 設計 §7 の冒頭 1 行 (mesh は専用 op を持たない)
