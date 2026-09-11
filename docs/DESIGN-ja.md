# ccmsg 設計

> 🇬🇧 [DESIGN.md](./DESIGN.md)

- 関係: [DR-0032](https://github.com/kawaz/claude-ccmsg/blob/main/docs/decisions/DR-0032-repo-split-protocol-first.md) (リポ分離・規約ファースト)、
  [`@ccmsg/protocol`](https://github.com/kawaz/ccmsg-protocol) (契約の正本)、
  [mesh-peer-auth](https://github.com/kawaz/claude-ccmsg/blob/main/docs/design/mesh-peer-auth.md) / [mesh-self-identification](https://github.com/kawaz/claude-ccmsg/blob/main/docs/design/mesh-self-identification.md) (instance 間認証・自己識別)、
  [issue multi-host-cluster](https://github.com/kawaz/claude-ccmsg/blob/main/docs/issue/2026-09-07-multi-host-cluster.md)、
  [issue session-list-sections](https://github.com/kawaz/claude-ccmsg/blob/main/docs/issue/2026-09-06-session-list-sections.md)
- 一次資料: [daemon 棚卸し](https://github.com/kawaz/claude-ccmsg/blob/main/docs/findings/2026-09-07-daemon-inventory.md)、
  [messaging socket 調査](https://github.com/kawaz/claude-ccmsg/blob/main/docs/findings/2026-09-08-claude-code-messaging-socket.md)

---

## 1. 目的

**1 つの instance (= 1 config home) を、契約 v2 の endpoint として提供する。**

instance が答えられるのは、自分の config home に属するセッションと、そのホスト上の資源
(プロセス・パス・ターミナルハンドル) についてだけである。それ以外は mesh の相手に問う。

### 1.1 管理したくないもの (目的と同格)

「管理したくない」= その要素を足すと、配布・更新・保管・復旧・整合の手順が発生するもの。
以下は本設計の判断すべての前提であり、迷ったときはここへ戻る。

| # | 増やさないもの | 定義 (何を指すか) | 反する変更の例 |
|---|---|---|---|
| M1 | **op ごとの手書き認可** | role / hello 必須 / capability / 転送先の判定を、op のハンドラ内に書くこと | 「この op だけ user 限定にしたい」でハンドラ冒頭に role 比較を足す |
| M2 | **同じ情報の 2 経路目** | 同じ値を one-shot op と push の両方、あるいは 2 種類の frame で出すこと | 「CLI が 1 往復で欲しい」で topic の他に取得 op を足す |
| M3 | **根拠のない周期タイマー** | 間隔値を実測・上流の挙動・仕様のいずれからも説明できない `setInterval` / `sleep` ループ | 「たまに取りこぼすので 1 秒ごとに再取得する」 |
| M4 | **派生値の永続化** | 他の状態から再構成できる値をディスクに書くこと | 前回計算した status のキャッシュをファイルに置く |
| M5 | **同じ手法の別実装** | 「前回値を直列化して比較し、同じなら push しない」等の同型処理を複数箇所に書くこと | topic ごとに個別の抑制キャッシュを持つ |
| M6 | **`~/.claude*` の探索** | 自分の config home 以外の config home をディスク走査で見つけること | 「他の面のセッションも見えたほうが便利」で全 config home を poll する |

M1 / M2 / M5 は旧 daemon で計測された偏り (role 比較 95 箇所、同じ情報の 3 経路、
push 抑制キャッシュ 3 実装、transcript 行の fold 3 系統) を再発させないための名指しである。
M3 は 8 種のタイマーのうち根拠が書かれていたのが 2 つだけだったことに対応する。

### 1.2 目的から導かれる形

- 認可・capability・転送は契約リポの `OP_ATTRIBUTES` / `TOPIC_ATTRIBUTES` を引く 1 箇所の関数で
  行う。op の実装は「引数はもう検証済み・呼んでよい相手だと確定済み」の状態から始まる (M1)
- 観測できるものは topic だけで提供する (M2)
- 状態変化は、それを持っている層が push する。周期的に全部を見に行く経路を作らない (M3)

### 1.3 M3 の対象と、周期ではない時間の値

M3 が名指すのは**周期タイマー**である: 間隔値が「どれだけの頻度で見に行くか」を決め、
その値を実測・上流の挙動・仕様のどれからも説明できないもの。daemon には周期ではない
時間の値 (窓・期限・打ち切り) もあり、これらは M3 の対象ではない。ただし根拠は周期タイマーと
同じく定数の doc comment に書く (§11.3 の M3 と同じ規律)。

| 値 | 種類 | 何を決めるか | 根拠 |
|---|---|---|---|
| gateway の生存窓 5 分 (`GATEWAY_LIVE_WINDOW_MS`) | 窓 | gateway の観測**だけ**を根拠に「生存」と言える新しさ (§5.2)。読む瞬間に `now` と比べるだけで、タイマーは無い | 窓の役割は実装に書かれているが、5 分という値そのものを説明する一次資料は無い (**仮値**) |
| sandbox grant の期限 30 分 (`GRANT_MS`) | 期限 | mint した URL が使える長さ。同じ scope を mint し直すと同じ grant の期限が延びるので、使われている preview は生き続け、忘れられたものは自然に止まる。期限切れは読む瞬間に判定し、タイマーは無い | 根拠は形 (使えば延びる・放置すれば止まる) にある。30 分は「忘れられた URL が有効なままでいる上限」であって、実測から導いた値ではない |
| launcher の drain 500ms (`DRAIN_MS`) | 打ち切り | コマンド終了後に pipe を読み続ける長さ。terminal にセッションを立てる launch は孫プロセスが pipe の書き込み側を持ち続けるので EOF が来ないことがあり、上限が無ければ応答はそのセッションの終了まで待つ。普通の exit では全 descriptor が同時に閉じるので、この上限には達しない | 到達するのは detach した launch だけで、それ以外では費用が無い |
| launcher の force kill 500ms (`FORCE_KILL_MS`) | 打ち切り | 制限時間 (config の `timeout_secs`) を超えて SIGTERM された command が退去するまでの猶予。過ぎれば SIGKILL | 1 回の launch につき 1 度だけの猶予 |

いずれも「見に行く頻度」を決めない。窓と期限は読む瞬間に古さを判定するだけで、打ち切りは
1 回の launch につき 1 度だけ発火する。値を誤って起きるのは「いつ古くなるか / どこまで待つか」
の違いであって、daemon が何かを繰り返し見に行くことではない — M3 が防ぎたいのは後者である。

## 2. 前提

| # | 条件 | 満たさない場合 |
|---|---|---|
| A1 | wire の契約 (型・op 属性表・topic 属性表・検証器) は protocol リポが正本 | daemon が自分で検証を書き、webui と解釈がずれる (旧 daemon の状態) |
| A2 | instance = 1 config home。daemon プロセスは instance と 1 対 1 | どの config home のセッションを答えているかが不定になる |
| A3 | ランタイムは Bun。UDS・子プロセス・ファイル監視は Bun の API を使う | 起動・配布 (単一バイナリ) の前提が変わる |
| A4 | daemon とセッションと webui の利用者は単一 uid。権限分離はしない | UDS の 0600 と config home の 0600 key が境界にならず、認可を作り直す必要がある |
| A5 | mesh の相手は §7 の認証を通した instance だけで、認証境界 (uid / config home) をまたがない | mesh 越しに来た op を自 instance の権限で実行してよい根拠が消える |
| A6 | TLS 終端と公開 FQDN は前段 (reverse proxy) が担い、daemon は plain HTTP / WS を loopback で受ける | 証明書・その更新・到達される公開名が daemon の管理対象になる (§1.1 が管理しないと言っているものが 3 つ増える)。loopback 束縛がネットワークから隔てる根拠でなくなる |
| A7 | instance 間は対等。どの instance に繋いでも同じ集合が見える。セッション間の会話は対等ではなく、受け取ったメッセージをどう扱うかは wire ではなく plugin の skill が定める | 呼ぶ側が「どの instance が正しい相手か」を知っていなければならなくなる。また harness ごとに違う作法を契約に載せることになる |

A4 は「他人から守る」ことをしないという宣言ではなく、**境界を OS の uid とファイル権限に
委ねている**という宣言である。daemon 内部に権限モデルを持たない根拠がここにある (§9)。

## 3. 層と責務

4 層 + 永続化。上の層は下の層を知らない。

```
transport   接続を作り、行を frame にし、相手が誰かを確定する
dispatch    frame を op に対応づけ、属性表で認可し、担当 instance へ渡す
domain      instance が答えられる事実を持つ (sessions / inbox / topics / transcript / upstream)
mesh        他 instance との接続を張り、op を封筒で転送し、frame を relay する
persistence 落ちて上がっても失われては困るものだけを書く
```

### 3.1 transport

| 責務 | 中身 |
|---|---|
| 接続の受理 | UDS (同一ホストのセッション・CLI)、WS (webui・mesh) |
| framing | 改行区切り JSON。1 行の上限と backpressure の扱いを 1 箇所に持つ |
| 入口の許可 | source IP の allowlist、mesh 相手の TLS |
| identity の確定 | `hello` の結果として接続に role と (session なら) sid を束縛する |

**人の認証は passkey が担う** (DR-0001、実装の接続点は §3.7)。人の WS 接続は subprotocol
`ccmsg.token.<access token>` を提示し、token が record に引けなければ handshake を断る。
`source_ips` は「どこから来られるか」の allowlist として残るが、**「誰が来たか」に答えるのは
token だけ**である。`Origin` は見ない: token が既に答えている問いに対する 2 つ目の答えになり、
instance に届く URL が増えるたびに operator が同期させ続ける対象が増えるだけになる。token を
持たない handshake は匿名の人として通すのではなく断る。access token の `exp` が接続の期限で、`hello` の応答の
`auth_expires_at` がそれを名乗り、同じ接続上の `auth.extend` で延ばす。UDS は到達すること
自体がディレクトリの権限を通ることなので何も提示せず、期限も付かない。mesh は相手の TLS と
`iss` / `aud` + proof (§7.2)、webhook は `Authorization: Bearer` で、どちらも経路自身が
秘密を持つ。

**前段 proxy は operator が名指した相手だけを信じる。** `entry.trusted_proxies` に CIDR で
アドレス塊を書き、listener が観測した接続元がそこに含まれる時だけ `X-Forwarded-For` を読む。
他に判断材料は無い: forwarded ヘッダを書くのは自分の前に居る誰かであり、ポートに届く者なら
誰でも書けるので、**前段が誰かを config が言うまで、そのヘッダは見知らぬ相手の自己申告**である。
信じる場合は右から読み、名指した proxy でない最初の値を採る (その右側は自分たちの hop が
書いた値、左側は最外の proxy と話していた誰かが書ける値)。`source_ips` と別項目なのは問いが
違うからで、あちらは「そもそも誰が接続してよいか」、こちらは「他人についての証言を誰から
受け取るか」であり、proxy は「入って良い唯一の相手」でないまま入口に立つのが普通である。
ここで復元するのは `registered_ip` / `last_used_ip` / `last_refresh.ip` に入る人の IP、つまり
本人が自分のセッションを見分けるための **手がかり** で、認可には一切使わない (DR-0001 §2.2)。
取り違えた時の実害は認可の面では小さく、手がかりとしては大きい: 偽装された IP が record に
残ると、一覧を読む本人を自分から遠ざける手がかりになる。名指しの無い前段で生の接続元を
そのまま使うのはこのためである。

**人と gateway の入口 (`<endpoint>ws`、`<endpoint>auth/*`、`<endpoint>webhook/<source>`) は
パスの末尾で照合し、prefix を問わない** (DR-0001 §2.7)。proxy は prefix を剥がさずそのまま渡してよく、
別名の endpoint や、1 つの origin の裏に複数 instance を束ねる LB が自分の endpoint と
無関係に成立する。**自分の endpoint のパス配下に固定するのは mesh の鍵
(`/mesh/jwk/<kid>`) だけ**である: 同じ origin に居る 2 つの instance が互いの鍵に
答えないための境界がこの対応関係そのものだからで (mesh-peer-auth §6.3)、人の入口には
そのような鍵空間が無い。

**greeting は接続につき 1 回で、その応答が identity を束縛する。** greeting の op は role ごとに
1 つずつあり (`hello.session` / `hello.user` / `hello.instance`)、role は greeting が届いた op 名から
読む。各 greeting が何を持つべきかはそれぞれの schema が述べる。role は接続の生存期間で固定され
(契約 `Role`)、identity が確定した接続からの 2 回目の greeting は、同じ role を名乗っても別の role を
名乗っても `bad_request` になる — 再識別ではなく「既に誰かである接続が別の誰かになろうとする要求」
だからである。束縛は transport が応答を書く瞬間に行う (transport が名前を知っている op はこの 3 つ
だけで、他の op は透過する)。`hello.session` / `hello.user` は同期で答え、**`hello.instance` だけが
promise を返す**: mesh-peer-auth の検証を待ってからでないと答えられず、応答以外に identity を
確定させるものは無いので、検証が終わるまで接続は匿名のままになる (§7.2)。mesh を持たない
instance は `hello.instance` を `capability_unavailable` で断る。

greeting の応答は `upstream.terminal_gateway` が設定されている instance に限り `terminal_gateway` を名乗る。セッションの terminal 自体は `agents` topic の `terminal_id` が指すので、人がその terminal を開く先は `<terminal_gateway>/sessions/<terminal_id>` になる。

旧 daemon で UDS listener だけが起動関数の内部に埋まっていた非対称を作らない。UDS と WS は
**同じ `Conn` を返す 2 実装**であり、上の層はどちらか区別しない。backpressure の扱い
(UDS の `write` は short count を返しうる / WS は再送される) の差はこの層で吸収する。

**mesh 接続もこの層の 1 実装**として扱う (§7)。role が `instance` である点だけが違う。

### 3.2 dispatch

frame 1 個に対して、順に:

0. frame が JSON object で `op` と `request_id` を持つか。持たなければ `bad_request`
1. `op` 名が契約にあるか。無ければ `unknown_op`
2. schema 検証 (protocol の compile 済み検証器)。落ちれば `invalid_args`
3. `needs_hello` と接続の identity。未確定なら `hello_required`
4. `roles` と接続の role。外なら `forbidden`
5. `capability` と instance の capability 集合。無ければ `capability_unavailable`
6. `locality` が `instance-local` で、対象が他 instance の担当なら mesh へ転送 (§7.3)。
   届かなければ `instance_unreachable`
7. op の実装を呼ぶ

**1〜6 は op ごとに書かない。** 属性表から機械的に導かれるので、op を足すことは
「属性表に 1 行足して schema と実装を書く」ことに閉じる (M1)。`scope: "role"` が付いた op
(`transcript.read` / `dir.list` / `file.read`) だけは、可否ではなく可視範囲が変わるので、
実装に role を渡す。**渡すのは属性表が `scope` を宣言している op に限る**、というのが
role を実装に露出させる唯一の経路である。

### 3.3 domain

| モジュール | 持つもの | 正本 |
|---|---|---|
| sessions | hello したセッション、その meta と接続、`last_live` | daemon (揮発) + last-live のファイル |
| inbox | sid ごとの未配送メッセージ (§4) | daemon (永続、§4.3) |
| topics | topic ごとの現在値と購読者 (§6) | 各値の持ち主 (下 2 つ or upstream) |
| transcript | sid ごとの tail 1 本と、そこから作る fold | ファイル (Claude Code が書く) |
| upstream | `sessions/<pid>.json` / llm-gateway から写した値 | 外部 (§3.5) |
| mesh | 各 peer が最後に述べた cluster 全体の topic の全量と、その到達可否の印 (§7.4 / §7.5) | 発生元の instance |

**transcript の fold は 1 本にする。** 旧 daemon は同じ 1 行を status / errors / user-input の
3 系統が独立に fold していた。v2 は tail 1 本 → fold 1 本 → そこから各 topic の値を導く形にする
(M5)。「全 peer には軽い fold、購読中の sid には重い fold」の 2 段構えは持たない (DV-Q7)。
負荷が問題になるなら fold の中身を軽くするのであって、fold を増やして解かない。

### 3.4 mesh

§7。domain の隣に置くのは、mesh が「他 instance の domain を自分の domain に見せる」層だからである。

### 3.5 upstream の写し

契約 §4 の「型に正本を宣言する」に対応する daemon 側の規約: **外部の JSON は
domain に入る境界で ccmsg の型に変換する** (単位を Unix ms に、名前を snake_case に)。
変換していない値が topic の payload に出ることはない。

### 3.6 persistence

書くのは 6 種類だけにする。

| 対象 | 理由 |
|---|---|
| instance id (`<state dir>/instance.id`) | この instance の identity。失うと `mid` / store の鍵 / `last_live` / 発行済みレコードの発行者が、すべて指し先を失う |
| `last_live` (前回稼働中のセッション) | 再起動で失うと、一覧から Paused / Disappeared の行が消える |
| ログ | 落ちた原因を後から読むため。exit 直前の行を落とさない writer を 1 つ持つ |
| inbox (未配送メッセージ) | 他のどこからも再構成できない状態 (§4.3) |
| kv (`kv.write` で保存された値) | 人が保存した値そのもの。派生値ではなく、client 側の複製は写しでしかない |
| auth records (`<state dir>/auth/records.json`、mode 0600) | 登録された credential・token family・tombstone (§3.7)。credential は authenticator とここにしか無く、family を失うことは人をログアウトさせること |

auth records も同じ理屈で M4 の対象外である: credential は authenticator の中とここにしか
無く、他のどこからも再構成できない。cluster の他 instance が写しを持つのは複製であって
導出ではない (全 instance が同時に失えば戻らない)。

inbox と kv は M4 の例外ではなく、M4 の対象外である。M4 が禁じるのは**派生値**の永続化であり、
未配送メッセージは派生値ではない。送信側の `message.send` は既に応答を返して終わっており、
transcript にも upstream にも「まだ届いていない本文」はどこにも無い。daemon が失えば
本文ごと消える。kv も同じ理屈で、テーマ等の保存値は daemon が失えばユーザの設定ごと消える
(契約 kv.ts が instance 間ミラーと `updated_at` による決着を前提にしているのも、値が
プロセスより長く生きることを前提にしているため)。

room jsonl は無い (契約 §2.1 で会話ログの正本は transcript)。sandbox grant・購読状態・
fold の途中結果・config dir の一覧はいずれも再構成できるので書かない (M4)。
pid / socket / lock は資源ハンドルであって状態ではない。**instance id はその対極で、
資源ハンドルではなく identity だから書く**: 発行したものすべて (`mid`、store の鍵、
`last_live`、レコードの発行者) がこの値で引かれるので、プロセスや置き場所から導くと、
導出元が変わった瞬間にそれらが一斉に指し先を失う。引っ越しは state ごと移すことであり、
id が state と一緒に動くことがそれらを無効にしない唯一の形である (DR-0001 §2.1)。
**mesh の署名鍵は書かない**: 接続 1 本ごとに生成して ack で捨てるエフェメラル鍵であり
(mesh-peer-auth §7)、メモリ上にしか存在しない。state dir に置くと保存場所と復旧手順という
管理対象が生まれ、§1.1 に反する。

state dir にはもう 1 つ、`dumps/` がある。`session.dump.write` が transcript を読んで
`<state dir>/dumps/<sid>[-agent-<agent id>]-<written_at>.dump.json` に書き、応答としてその path を返す。これは上の
5 種のどれでもなく、本節の意味での永続化でもない: instance はこの file を読み返さず、消えても
何も壊れない。

**dump が書くのは行ではなくアイテムである。** transcript はハーネス自身の file 形式で、こちらの合意なく変わる。
契約が持つのは**型の語彙とアイテムの形だけ**で、file を読むコード (= 分類) は daemon にある
(`src/transcript/items/`)。型名は `.` 区切りの階層 (`message.user.in` / `thinking` / `tool.Bash` /
`notice.slash` / `system.compact` / `system.attachment.<kind>` / `hook.<Event>`) で、prefix でその配下を
まとめて選べる。アイテムは**行より細かい**: assistant 1 行は thinking と本文と各 tool 呼び出しに分かれ、
呼び出しと結果は行の実体どおり 2 アイテムのまま `result_item` / `parent_item` で結ぶ
(結果が何 turn も後に来るものがあるので、畳むかどうかは表示側の判断にする)。両側はハーネスが対にした
キーも持つ (呼び出し側 `tool_use_id` / 結果側 `parent_tool_use_id`)。片側しか手元に無い読み手は
これで往復を結び直す。

**アイテムの identity は `id` = `<uuid>:<index>`** (元 record の id と、その record の中で何番目に立っていたか) で、
リンクはこの `id` で張る。record の id だけでは 1 行が become した複数アイテムを同時に指してしまい、リンクにならない。
`uuid` は元 record への参照として残るので、record 単位で 1 turn を束ねる用途 (範囲を record で切る等) はそのまま効く。
ハーネスが `uuid` を書かなかった record では、その位置 (`@<offset>`) が record の identity を代行する
(**静かに消える行を作らない**方が優先で、id が無いことは record を落とす理由にならない。`@` 付きなのは、
record 単位で束ねる読み手がこれをハーネスの uuid と取り違えないため)。
併せて各アイテムは `source` (`offset` / `bytes` = transcript 内での元 record の位置) を持つ。
**分類は誤りうるので、生 record を見る道を必ず残す**という要求がこれで、`transcript.read` に
`before = offset + bytes` / `max_bytes = bytes` を渡せば元 record が 1 行返る。`bytes` は行末の改行までを含むので、
返るのは record の切れ端ではなく record そのものになる。1 record が複数アイテムになる場合、
その全部が同じ `source` を共有する (= 取り寄せは record 単位)。

**呼び出しを見ていない結果は、指し先を捏造せず結び直しのキーで出す。** 呼び出しを見ていない読み方
(= topic の seed のように file の途中から読み始めた場合) には名指す `parent_item` が無く、record は
どのツールが呼ばれたかも言わない。**`tool.unknown` はこの場合の予約名である**: 型名の `unknown` は
「結果の本体はあるが、ツール名を daemon が知らない」を表す語彙で、名前を結果の形から推測したものではない。
`parent_tool_use_id` は必ず載るので、読み手は手元の use アイテムの `tool_use_id` と突き合わせて
名前を復元できる。形は generic な結果 (`{result}` + `parent_tool_use_id`) である。

**ハーネスが同じ 1 つのものに 2 つの名前を使う場合は、1 つの型に寄せる。** agent を起こすツールは
`Agent` と `Task` の 2 綴りで書かれてきたが、読み方も意味も同じなので型は `tool.Agent` に正規化する
(同じものが語彙に 2 名で並ぶと、選択する側が「この transcript がどちらの綴りだったか」を知らないと
選べなくなる)。record が使った綴りは呼び出し側に `harness_name` として残るので、自分が動かしたものと
突き合わせる読み手はそれを見る。

**返事の来ようが無い呼び出しは、まだ来ていない呼び出しと区別する。** `SendMessage` で配下の agent に書くのは
往復の片道であって、返事は agent 側の都合で別の message として届き、この呼び出しを名指すものは何も無い。
分類はこれに「対を持たない」印を付け、表示は `(未着)` ではなく `(片道)` と描く。**知らない形も必ず出る**:
未知のツールは `{input}` / `{result}` の汎用形、未知の添付はその `kind` のまま、どれでもない行は
`system.unknown` になる。UI と状態の記録 (`mode` / `queue-operation` / `progress` / `*-title` /
`file-history-*` 等) だけが対象外で、実測では 1 セッション 3,429 行のうち 1,317 行がこれである。

**主語はセッション、または配下の agent 1 体である** (`agent_id` を指定すると
`<sid>/subagents/agent-<id>.jsonl` が対象になる)。型の定義は変えず、`in` / `out` を主語から見る。
同じ preset がどの階層でもそのまま通るのはこのためで、末尾の `ids` 台帳に出た `agent_id` を
次の dump の主語にすることで掘り下げられる。

**`message:<X>` の `X` が名指すのは主語から見た相手の種類であって、主語自身の立ち位置ではない** —
`parent` は主語を起こした相手、`sub` は使い捨てで起こした子、`team` は名前を持って居続ける相手、
`session` は ccmsg 経由の別セッション。唯一の例外が `user` で、これは関係ではなく **人** を指す。
agent にとっての親はセッションか別の agent なので、そこを `user` と呼ぶと読み手が機械を人と取り違える。
ハーネスの実名 (`main` / `team-lead` / teammate 名) は型でなく item の `harness_name` に残る
(`to` / `from` は `message.session` が sid を書く場所であって、名前の置き場ではない)。

**相手が誰かは record が言う。** 分類は次で決める:

| 判定 | 型 |
|---|---|
| record が sidechain (= agent 自身の file) の、返信元を持たない user 行 | `message.parent.in` (封筒があれば `harness_name` も載る) |
| 以降の封筒なし user 行で、主語がセッション本体か teammate | `message.user.in` (人が直接打った 1 通) |
| 同上で主語が使い捨ての agent | `message.parent.in` (起動した側が続けて指示している) |
| 同じ file の assistant text | `message.parent.out` (呼び出しを伴わない散文) |
| `<teammate-message teammate_id=…>` 封筒で送り手が `main` / `team-lead` | `message.parent.in` |
| 同上で送り手がそれ以外の名前 | `message.team.in` (呼び出しの答えではない独立した 1 通) |
| `Agent` 呼び出しで `name` / `team_name` 引数を持つ (= teammate の起動) | `message.team.out`、その完了通知が `message.team.in` (結果形) |
| 同上で持たない | `message.sub.out` / `message.sub.in` |
| `SendMessage` の宛先が sid | `message.session.out` |
| 同上が `main` / `team-lead` | `message.parent.out` (呼び出し形) |
| 同上がそれ以外の名前 | `message.team.out` |

**名前で宛てた相手が teammate か使い捨て worker かは、名前だけでは決まらない — 名前を持つこと自体が
teammate の定義である。** 名前を持つ agent は以降も書き足せて、返事は呼び出しの答えではなく独立した
message として届く。使い捨ての agent は 1 度答えて終わるので、その往復だけが対になる。判別のつかない
名前を `team` に倒すのはこのためで、`sub` に倒すと「来ない答えを待っている呼び出し」として描かれる。

**自分の言葉で書いてくる相手が誰かは、立場から決まる。** teammate は以降も立ち続ける相手で人が直接
打てるし、セッション本体の file も同じなので、**その途中に現れる封筒なし user 行は `message.user.in`**
とする。使い捨ての agent に書けるのは起動した側だけなので、**同じ行はその file では `message.parent.in`**
になる (人の発話ではなく、brief の続き)。開始行はどの立場でも `message.parent.in` のまま —
指示されることは書き掛けられることとは違う。

**どの立場の transcript から読んだかは、file を開いた側が決めてアイテムに載せる (`subject`)。**
record 自体に teammate と使い捨て worker を分ける印は無いので
(実測 9,573 件: 開始行の封筒の有無は taskKind と 98.9% しか一致せず、`isSidechain` は 9,572 件で立つ)、
分類器は record を嗅がずに**告げられた立場で読む**。
告げる側の一次情報はハーネスが file の隣に書く `agent-<id>.meta.json` の `taskKind` で、
`in_process_teammate` なら `team`、それ以外の note なら `sub`、セッション本体の file なら `main`。
teammate を名前で引く経路が既に同じ note を読んでおり (§5.4)、新しい入力源は増えない。
開始行の封筒を根拠にしないのは、封筒が**アイテムの中身 = 誰でも書ける文字列**だからで、
実測では meta のある 8,223 本のうち 24 本 (0.29%) が食い違う (大半は依頼文が封筒を引用した worker)。

**note が無い・壊れている file は `sub` に倒す。** 判別不能をどちらに倒すかは、誤ったときに読み手が
何をするかで決める: `team` と誤ると「まだ立っている相手」として書き戻す先を提示してしまい、`sub` と
誤ると名前で描けないだけで済む。meta を持たない transcript は実測 11,012 本中 2,789 本 (いずれも
古いセッション) あり、ここは一律 `sub` になる。なお `main` として開いた file に sidechain な record が
現れた場合も `sub` に落とす — 立場は**狭まる方向にしか動かさない**。

**teammate 名は `ids` 台帳に載せない。** 台帳は「読み手が次に掘る対象」の一覧で、載る id は dump の
主語にできるものに限る。teammate 名は `DumpIdKind` のどれでもなく、名前では dump を引けない。
teammate の `agent_id` は起動の答えで判るので、そちらが `agent` として載り、`harness_name` が `label` になる。

**何を残すかは `types` で左から順に決める。** 要素は型 (prefix 可)・`-` 始まりの除外・
`@<preset 名>` (config の preset をその位置に展開、再帰可) で、無指定は `system.attachment` を除く全部。
preset は契約に焼かず config の `dump.presets` に置く (名前が指すのは「関心の切り方」であって wire の性質ではない)。
循環参照と未定義の preset 名は **config 読み込み時に拒否**する (dump のたびに落ちるのでは遅い)。
`daemon add` は編集の出発点として 5 つの例を `config_v2.ts` に書く。一覧は `dump.presets.read` で引く。
**file の形も契約が持つ** (`SessionDumpFile`)。path だけを返して本文は file にあるので、path を渡された後継セッションが読む形は契約の側で決まっていないと読めない。file は
`{sid, agent_id?, written_at, types, items, ids}` で、`types` は **展開・除外適用後の選択そのもの**である
(file は要求より長生きするので、何の dump で何を落としたかを file 自身が言えなければならない)。`ids` 台帳は型ではないので選択で落ちない。
既存の `no_thinking` / `no_agent` は `["-thinking"]` / `["-message.sub", "-tool.Agent"]` と同義で、最後に適用される。
落ちるのは使い捨ての往復の機械仕掛けだけで、teammate との往復は残る (teammate とのやり取りは会話であり、
会話を残せと言った dump から会話が消えることになるため)。

**型を読める文字に落とすのは表示層の責務である** (`src/transcript/items/render.ts` と `document.ts`、CLI の `ccmsg dump`)。
型ごとに 1 つの関数が「見出しの語」と「その下の行」を返し、文書は `[<uuid8>:<index>] <型> <見出し> <時刻> turn` の 1 行と
インデントした本文の並びに、対象・instance・選択・範囲の前置きと末尾の `ids` 台帳を付けたものになる。
**専用の描き方が無い型も必ず出る**: 未知のツールも未知の添付も、型名と持っていた field が汎用形で並ぶ
(描き方を足すのは読みやすさのためであって、出すかどうかの条件ではない)。呼び出しと結果を 1 かたまりに
寄せるかは**この層が決める** (隣り合っていれば寄せて `→`、離れていれば結果を自分の位置に置いて `←`、
worker の答えだけは何 turn 離れていても指示書の下に付ける)。見出しに出す id が `id` の短縮形なのは、
リンクの矢印が指す先と見出しが同じものを言うためである (record の id だけを出すと、矢印の指すアイテムが見出しから引けない)。

**型付きアイテムは dump file 専用ではなく、op と topic でも運ぶ。**

| 用途 | op / topic | 中身 |
|---|---|---|
| 範囲を指定して読む | `transcript.items.read` | dump と同じ範囲指定 (`since_at` / `since_uuid` / `until_*`) + `since_id` / `until_id` (アイテム単位の下限・上限) + `types` 選択 + `limit`。返りは `items` と、切れた時の続き位置 `next` / `prev` |
| 追記を受け取る | `transcript.items:<sid>` topic | snapshot は末尾側のアイテム一定数、以降の frame は新しく分類されたアイテムの配列 (§6.2 の `append`) |
| 生 record の取り寄せ | `transcript.read` / `transcript:<sid>` | 変更なし。アイテムの `source` で 1 record を引く経路になる |

`transcript.items.read` の解決は `transcript.read` と同じ (announce か walk、`agent_id` で worker の file)、
可視範囲も同じ `scope: "role"` である。範囲は **file 全体を分類してから**切るので、範囲外を指すリンクが残るのは
正常な状態であって壊れたポインタではない (読み手はその id で取りに行ける)。1 ページの上限は件数と bytes の両方で、
先に達した方で切る: 件数だけではアイテム 1 個の大きさが桁で違うため 1 接続あたりの payload を抑えられず、
bytes だけでは同じ要求が中身次第で違う件数を返すことになる。

**どちら端を 1 ページとして残すかは、与えられた境界で決まる。** 下限 (`since_at` / `since_uuid` / `since_id`)
があれば範囲の先頭から返し、切れた位置を `next` が名乗る (次は `since_id` に渡す)。上限 (`until_at` /
`until_uuid` / `until_id`) だけなら範囲の**末尾**から返し、返した先頭のアイテム id を `prev` が名乗る
(次は `until_id` に渡す。`until_id` は排他で、既に手元にあるアイテムを二度返さない)。境界を何も置かない
読みは最初の 1 回であり、`before` を置かない生読みと同じく**末尾**を返す (先頭から読みたい側は `since_at: 0` と言う)。
末尾から描く client (webui の Timeline) はアイテム側に「そこから遡る」
座標を持たないので、遡りは範囲指定の側が担う — byte 側で `transcript.read` が `before` で遡るのと同じ役割を、
アイテム側では上限指定の読みが果たす。返りの並びはどちら向きでも古い順である (transcript の並びがそれであるため)。

**client は生 jsonl を読まない。** 契約が語彙だけを持ち daemon が分類を持つのは、jsonl がハーネスの内部形式で
こちらの合意なく変わるためで、その追従を契約に同居させると形式変更のたびに契約 release が要る。
codex の rollout 形式 (§3.8) も daemon 側の分類で吸収されるので、ハーネスが増えても client は無変更で済む。

op が transcript の読み出しに足しているのは「path を後継セッションに渡せる
耐久性のある成果物」であって (本文を client 経由で外に出してまた入れ直す代わりに)、path は
呼び出し側が渡さないので封じ込めの判定対象も無い。state dir の下に置くのは、instance ごとの
path をすべて config home から導く §8.1 に従うためである。

M4 とも矛盾しない。M4 が禁じるのは派生値をディスクに置いて正本と整合させ続けることで、害は
整合の手順が生まれることにある。dump は transcript から導いた派生物だが、生成時刻と境界で
確定した 1 回の切り出しであり、正本に追従させるものではないから整合の手順は生まれない。
位置づけは「人が op で作らせた成果物」で、launcher が立てた子プロセスや sandbox が発行した URL
と同じく、instance が要求に応じて世界に残す作用であって instance の状態ではない。破棄する
仕組みは持たない。

### 3.7 人の認証 (passkey)

正本は DR-0001。ここに置くのは他の層との接続点だけである。

**登録はローカルからしか始まらない。** `ccmsg daemon passkey add <unit> [endpoint]` が
登録用 URL (`<endpoint>#register=<jwt>`) と **6 桁のコード**を 1 組出す。endpoint は instance の
公開 base URL そのもの (`https://h/personal/`) で、webui はそこに配られるので、URL の組み立てに
細工は要らない。URL にコードは入らず、コードは端末にしか出ない — 2 つが別経路で browser に届くので、URL が
漏れただけでは登録にならない。jwt を署名する secret は発行 instance のメモリにだけ在り、
再起動で消える (永続鍵を持たない)。この 3 つの命令 (`add` / `list` / `remove`) は
**契約の op ではなく instance の UDS にだけ届く管理フレーム**である: 契約はネットワーク
越しに instance へ届くものの定義であり、登録はまさにそこへ出してはならないものだから。
到達すること自体が権限である UDS は、監督者の制御要求と同じ足場になる。

**HTTP の 4 経路** (`/auth/challenge` `/auth/register` `/auth/assert` `/auth/refresh`) は
「`needs_hello: false` の op を HTTP で運ぶもの」で、`request_id` は carrier が合成する。
末尾照合なのは `ws` と同じ理由である (§3.1)。未認証で叩けるので 4 経路で 1 つの rate limit を
共有する。CORS は **request の `Origin` が、この instance が知る endpoint の origin
(自分の endpoint、credential record の `endpoint`、未使用の登録 URL の `endpoint`) の
どれかと完全一致**する時だけ `Access-Control-Allow-Origin` + `Allow-Credentials` を echo し、
外れていれば 403 を返す。**rp_id (ドメイン) では判定しない**: rp_id の配下を許すと兄弟
サブドメインが `/auth/refresh` を `credentials: "include"` で叩けてしまい、cookie は
ドメイン単位で付くので本人の access token を読まれる。したがって **webui を endpoint と別の
サブドメインに置く構成は非対応**である (webui は endpoint の直下に配る)。

**認証は record の endpoint (base URL 全体) に束ねる。** 登録時に登録 URL の claims の
endpoint を `CredentialRecord.endpoint` に書き、register / assert の受理条件は
**`clientDataJSON.origin` == endpoint の origin** かつ **request が届いたパスの prefix ==
endpoint のパス**である。`https://h/` と `https://h/personal/` は別 endpoint で別登録になる
(rp_id はホストなので両者で同じになりうるが、rp_id は「authenticator がどのドメインに答えるか」で、
「どの instance に通すか」より粗い)。**rp_id は登録時の endpoint のホストに固定**で、指定する口は
持たない — registrable suffix を名乗れると、その配下の全ホストでその credential が使えてしまう。

**token は署名しない opaque 値**で、検証は record の lookup である。**access token は family に
1 本で、その人が開いている複数のページ (タブ) が共有する**: rotate は cookie の refresh を毎回
回すが、access は残り寿命が TTL の半分を切るまで据え置き、それ以降だけ mint し直す。毎回
差し替えると、あるタブの読み込みが他のタブの持つ token を無効にしてしまう (半分は、ページが
新しい値に気づくための猶予を寿命の半分残せる、最大の閾値)。access は応答の body、
refresh は httpOnly cookie (`__Secure-ccmsg-<sha256(instance id + 改行 + sub) の先頭 16 hex>`、
`HttpOnly; Secure; SameSite=Strict; Path=<request のパスの /auth/ までの prefix>`)。
family を書けるのは mint した instance (`iss`) だけで、別の instance に届いた rotate は
`auth.rotate` で `iss` へ転送する (§7.3 の経路)。**peer から届いた「自分が mint した family」の
写しは受理しない** — 単一 writer なのだから、戻ってくる写しは必ず古い状態であり、
失効させた family を復活させてしまう。直前 1 世代は再送の猶予として「前回の答え」を返し、
それ以外の**退役済みの値の提示は世代を問わず family ごと失効させる** (提示された instance が
その family の `iss` でなければ `auth.rotate` で `iss` に投げ、`iss` 側で失効させる。単一 writer は
崩さない。`iss` が不達なら断るだけ)。失効は record の削除ではなく **family tombstone (7 日)** で、
分断中の peer が持っていた生きた写しが復帰時に新しい書き込みとして戻ってこないようにする。
退役の記録は退役した refresh の
sha256 を family の `retired` に、その値本来の exp まで持つ。書けるのは `iss` だけだが
複製はされるので、instance を再起動しても、別の instance に提示されても検知できる。
exp を過ぎたものは次の rotate で落とす (その時点以降は、値自身の期限が断るものしか断らない)。
失効と tombstone はどちらも、その sub の認証済み WS を閉じる — peer から届いた tombstone
でも同じく閉じる。

`hello` の `auth_expires_at` は接続の期限で、`auth.extend` は **同じ利用者の** access token
でしか延ばせない。carrier が http の op (`auth.challenge` / `auth.register` / `auth.assert` /
`auth.token.refresh`) は **frame としては受けない**: cookie の読み書きは開いた接続の上では
できず、答えの片方が欠けたまま返すことになるので、dispatch が属性表を見て断る。carrier 側は
handler に渡す前に `OP_SCHEMAS` を通し、`Origin` の無い POST も断る。

**challenge は 32 byte の乱数 + 発行者 (instance id)、寿命 5 分、使い切り。** LB で発行と
応答の instance が違ってよく、応答を受けた側が assertion を検証し、challenge の消費と
登録 jwt の検証だけを `auth.resolve` で発行者に頼む。**6 桁のコードは判定せずそのまま
発行者へ運ぶ**: 受けた側が判定すると、試行回数が instance ごとに別々に数えられ、cluster 全体に
推測をばら撒けてしまう。jwt・コード・試行回数は発行者だけが持つ。

**利用者の WebAuthn user handle (`user_id`) は発行者が sub ごとに 1 度決める。** 16 byte の
乱数を jwt に載せ、ページはそれで credential を作り、record の `user_handle` に保存して、
handle を名乗る assertion をそれに照合する。authenticator は handle を instance の手の届かない
場所に保存するので、同じ人に 2 つの値を配ると端末上で 2 つのアカウントに見えてしまう。
同じ sub への追加登録は既にある handle を使い回す。

**credential record / token family / tombstone は `auth.records` topic で複製する。**
§7.4 の relay には乗らない — element 粒度なので「instance ごとの全体値」が無く、受け取る側が
key で畳む。roles は `instance` だけで、relay が `caller` を付ける他の topic と違い
**instance のまま購読する**: 人が読める場所に置けば token がそのまま漏れる。
`passkey remove` は sub 単位の tombstone を打ち、tombstone はその key 配下への以後の
書き込みを拒む (LWW の例外)。credential の tombstone に保持期限は無く、family のそれは 7 日。

### 3.8 ハーネス

instance は config home 1 つに答える (A2)。その config home を持っている**プログラムが何か**は
instance の属性であり、**契約には出さない**。`ccmsg daemon add <dir>` が
目印ファイルから判定してその instance のファイルに書き (既定と違う時だけ)、instance は起動時にそれを読む (§8.2)。
目印が 2 つある / 無い config home では `--harness` で指定する。既定は `claude` で、
既存の entry は何も書き換えずにそのまま動く。

**発見ではなく設定にする理由**: 空の config home はどのプログラムのものかを何も語らない。
推測する instance は、最初のセッションが始まるまでの間ずっと別の木を歩くことになる。

差分は次の 6 点だけで、これ以外に harness を読む場所は無い。

| 何が | claude | codex |
|---|---|---|
| config home を指す環境変数 | `CLAUDE_CONFIG_DIR` | `CODEX_HOME` |
| セッションを名乗る環境変数 | `CLAUDE_CODE_SESSION_ID` | `CODEX_THREAD_ID` / `CODEX_SESSION_ID` |
| config home だと言う file | `settings.json` | `config.toml` |
| セッションが在ることの証拠 | `sessions/<pid>.json` (pid・cwd・status を持つ) | `thread-writer-locks/<thread-id>.lock` (thread id しか持たない) |
| 入力待ちの検出 | 同 file の `status: waiting` | **無い** (下記) |
| transcript の置き場と名前 | `projects/<cwd を潰した名前>/<sid>.jsonl` | `sessions/<年>/<月>/<日>/rollout-<開始時刻>-<thread-id>.jsonl` |
| 直送 (経路 (a)) | messaging socket へ書く (§4.1) | `codex queue --thread <sid> --message <本文>` |
| plugin の置き場 | agent の CLI に登録させる | config home の `hooks.json` と `skills/` へ直接置く |

sid は両者とも harness 自身が名乗る値をそのまま使う。codex では thread の UUID がそれで、
`SessionStart` hook・rollout の file 名・`codex queue --thread` のどれでも同じ値だった
(codex-cli 0.153.4 実測)。revert した thread の rollout は `<thread-id>_<rollout-id>` になるが、
**session を名乗るのは前半**なので、ccmsg が引くのは同じ 1 つのセッションである。

**`agents` topic は Claude Code 固有である。** 契約の `AgentInfo` は pid・cwd・kind を必須に
持つ Claude Code の一覧そのもの (契約 `AgentInfo` の upstream 表記) で、lock file はそのどれも
持たない。よって codex の instance は `agents` に**何も出さない**。セッションがどこで動いて
いるか・何という名前かは hello が言ったことで、それは harness に依らず registry が持つ。

**どちらのセッションの中に居るかは、環境変数の並び順で決めない。** セッションから起動された
セッションは親の環境をそのまま継承するので、**両方の config home が同時に名乗られる**
(Claude Code のセッションから起動した Codex の hook 環境に `CLAUDE_CONFIG_DIR` と
`CLAUDE_CODE_SESSION_ID` が立っていることを実測)。決めるのは**セッションを名乗る変数**で、
config home はそれを名乗った harness の側から引く — 「自分は誰か」と「どの instance に
話すか」を 1 つの答えから引くので、両者がずれることが無い。

複数が名乗った時は **Codex を先に見る**。Claude Code は自分の session id を配下のプロセス
すべて (別 harness を含む) へ export するのに対し、Codex が thread を名乗るのは自分の turn の
コマンドに対してだけで、狭い主張の方が真である。逆の入れ子 (Codex の turn から起動した
Claude Code のセッション) は Codex として読まれる。`--sid` が覆すのは**名乗る sid だけ**で、
どの instance に話すかは変わらない (別の config home の instance に話したいなら、その
harness の変数を立てた環境で呼ぶ)。

**Codex はツール実行の環境に thread を名乗る。** `CODEX_THREAD_ID` と `CODEX_SESSION_ID` の
両方が入り、値はどちらも thread UUID = sid である (0.153.4 実測)。よって `ccmsg post` /
`reply` / `peers` は Codex のセッションからそのまま送れる。`SessionStart` hook の環境には
入らない (そちらは stdin の `session_id` が名乗る)。継承した `CLAUDE_CODE_SESSION_ID` より
Codex の主張が先に見られるので、**Codex から送ったつもりが親 Claude Code セッションとして
送られることは無い**。thread UUID は UUIDv7 だが、契約の `Sid` は version を問わないので
そのまま通る。

**config home を明示した経路はこの推定を通さない**。`daemon <sub> <dir>` や
`plugin install <agent>` のように呼び出し側が config home を決めている場合、path はその値から
直に引く (`resolvePathsFor`)。環境から引き直すと、どのセッションの中で走らせたかで宛先が
変わってしまう。

**ccmsg が置く hook script は、他 harness の変数を落としてから `ccmsg` を呼ぶ**
(`env -u CLAUDE_CONFIG_DIR -u CLAUDE_CODE_SESSION_ID CODEX_HOME=…`)。hook は自分が発火した
セッションの代弁者であって、それを起動した誰かの代弁者ではない。同じ理由で、経路 (a) が
`codex queue` を起動する時も daemon から継承した他 harness の変数を落とす。

**stale lock**: 正常に終わった thread の lock は消える。プロセスが即殺された場合は残る
(実測)。upstream の thread store は lock を flock で持ち、次に誰かが thread を書き始める時に
「flock が取れる = 誰も掴んでいない」lock を掃除するので、残った lock はその時点まで残る。
flock を試せば stale 判定は可能だが、Node 標準に flock が無いので採らない。よってその thread は
掃除されるまで生存として読まれる。

**配送は対話の選択に当たらない**。対話で起動した Codex は更新案内とディレクトリの信頼確認を
起動時に求めることがあるが、`codex queue` はそのどちらにも当たらず、新規 config home・未信頼の
ディレクトリ・標準入力を閉じた状態でも待たずに答えた (0.154.0 実測)。それでも子プロセスには
標準入力を渡さず時間制限を掛ける — 答えない子は `message.send` をその寿命だけ止めてしまい、
経路 (b) は「来なかった経路が message に何も損させない」ためにある (§4.1)。

**Codex の入力待ちは検出しない。** 承認や質問で止まっている thread は、`CODEX_HOME` の下に
そう書かない: 承認・入力要求の event は rollout の永続化方針が "transient" として明示的に
落とし、thread history が turn ごとに持つ status は `completed` / `interrupted` / `failed` /
`inProgress` の 4 つで待ちと実行中を区別しない。知っているのは app-server で、
`thread/status/changed` の `WaitingOnApproval` / `WaitingOnUserInput` がそれを名乗るが、
これはファイルではなく購読の要る JSON-RPC 通知であり、§5.1 の入力 (自 config home のファイルと
自分への接続) に無い種類の上流である。**足すかどうかは「何を増やしたくないか」の判断**なので、
ここでは足さない。

したがって Codex の thread は、承認待ちで止まっていても**生存 (管理外) のまま**であり、
待ちに気づく口は ccmsg の外 (hyoui) にある。Claude Code だけが `waiting` を出す — 一覧の
「待ち」欄が harness によって埋まったり埋まらなかったりするのは、この差がそのまま出たものである。

**hooks の trust**: Codex は一度人が確認した hook しか実行しない。`plugin install codex` は
file を置き、trust が要ることを `needs` として答えるだけで、trust 自体は書かない
(trust は「このプログラムを走らせてよいか」という問いで、代わりに答えるのは install の
仕事ではない)。`hooks.json` は config home の持ち物なので**併合**し、uninstall では
ccmsg が置いた entry だけを外す。

## 4. 配送

契約の `message.send` は「宛先 sid に届ける」だけを約束し、届かなかった場合は理由を返す。
daemon 側の実装はその 2 つ (配送手段と、届かない理由の判定) に分かれる。

### 4.1 配送手段の 2 経路

| 経路 | 内容 | 前提 |
|---|---|---|
| (a) harness 自身の入口へ直接 | Claude Code は `sessions/<pid>.json` の `messagingSocketPath` に connect し、config home の 0600 key の `peerToken` で認証してから user frame を書く。Codex は `codex queue --thread <sid>` に本文を渡す (§3.8) | 非公式プロトコル。Claude Code では `peerProtocol` の世代一致、Codex では `codex` が PATH に在ること |
| (b) topic `inbox` の delta として push | セッション側の購読 (subscribe を張っている常駐) 経由で届ける | セッションが購読していること |

**(a) を優先し、失敗したら (b) にフォールバックする** (DV-Q1)。理由は 2 つ。

- (a) は**受信側が ccmsg の常駐を持っていなくても届く**。「まだ subscribe を張っていない
  セッションには届かない」という穴 (旧 daemon が 3 分の巻き戻し窓で塞いでいたもの) が、
  時間窓ではなく経路の性質として消える。**入力が `sessions/` だけ**であることも同じ性質の
  裏返しで、hello を聞いていないセッション — 再起動した instance から見た全セッション —
  にも宛先の解決と送信がそのまま成立する
- (b) は ccmsg 自身のプロトコルなので、(a) が使えない相手 (世代違い・socket 不在・
  key を読めない) でも成立する。片方だけでは成立しない組み合わせが両方に存在する

(a) の適用条件は**すべて満たしたときだけ**とする。1 つでも欠ければ判定なしに (b) へ落ちる。

0. **feature flag が有効** — 実機確認済みなので既定で有効。config で無効化できる
   (無効な間、配送は (b) だけで成立する。フォールバック先が常用経路になるだけで、
   配送の意味論は変わらない)
1. `sessions/<pid>.json` が `messagingSocketPath` と既知の `peerProtocol` を持つ
2. 対応する key file を自分が読める (= 同一 uid・同一 config home = A2 / A4 と一致)
3. 期限内に受信側が「受け取らなかった」と言ってこない

条件 3 の判定元は**送信した接続ではなく、送達ステータス用の別 socket**。送信した接続は
片方向で、受信側は 1 バイトも返さない。受信側が何か言う時は user frame の `from` が名乗った
アドレスへ `peer_message_status` を書く。よって ccmsg は自前の UDS (0600) を持ち、`from` に
`uds:<path>` として渡す。

**受信側は肯定応答を出さない**。受理した message には何も返さず、`refused` / `denied` /
`dropped` / `expired` / `held` を返すのは受け取らなかった時だけ (2.1.263 の inbound gate)。
したがって「期限内に沈黙 = 届いた」「期限内に上記が来た = §4.4 の drop」と読む。期限の値は
一次資料に無い (**仮値**)。根拠として言えるのは「受信側は gate の判定と同じ場所で receipt を
出すので、同一ホストの UDS 1 往復で届く」ところまで。

status socket の**置き場は state dir ではなく、宛先 socket と同じディレクトリ**。受信側は
返信先アドレスを検証し、自分の socket namespace の外を `reply address unshaped or outside
our socket namespace` として捨てる (2.1.263) ので、隣に置く以外に受け取る方法が無い。

`from` は ccmsg が決める値であって、利用者入力を通さない。

### 4.2 未配送の理由と、その判定元

契約 §2.1 の未配送理由は、すべて §5 の状態モデルと経路の結果から導く。理由ごとに別の情報源を
足さない。

| `reason` | 判定 | 情報源 |
|---|---|---|
| `preparing` | 宛先は生きているが、まだ受け取れない (経路 (a) 不可 かつ 購読なし) | sessions + registry |
| `paused` | 宛先が Paused | last_live の `stopped_at` |
| `disappeared` | 宛先が Disappeared | last_live (stopped 印なし) |
| `instance_unreachable` | 宛先の担当 instance が mesh で到達不能 | mesh の接続状態 |
| `inbox_full` | 上限超過で古い方を落とした | inbox |
| `throttled` | 経路 (a) で受信側の流量制御に弾かれた (§4.4) | (a) の drop 応答 |

`session_not_found` (op 自体の失敗) は「cluster のどの instance も知らない sid」の場合のみ。
到達不能な instance が担当している可能性がある間は `instance_unreachable` であって
`session_not_found` ではない。**この 2 つの区別は mesh の接続状態にしか依存しない。**

`paused` / `disappeared` のとき `candidates` に添える sid は「同じ repo root で今動いている
セッション」。repo root は hello が名乗った値、名乗らなければ cwd から導出した値を使う。

### 4.3 inbox

| 性質 | 値 | 根拠 |
|---|---|---|
| 粒度 | sid ごと | 契約 §2.1 |
| 積む条件 | 即時配送できなかった時だけ | 配送できたものを溜めない |
| 出す条件 | 宛先が受け取れる状態になった時 (経路 (a) が通る / `inbox` を購読した) | 同上 |
| 消す条件 | 配送した時 / 宛先が一覧から消えた時 / 保持期限 | 契約 §2.1 |
| 上限 | 1 sid あたりの件数上限。超過分は古い方から落とし `inbox_full` を返す | 契約 §2.1 |
| 保持期限・件数上限の値 | **契約の値を参照する** (daemon は決め直さない) | 契約 §2.1 |

**永続化する** (DV-Q3、§3.6)。形式は append-only の jsonl で、配送できた時点で消し込む。
append-only なので、書き込みは末尾追記 1 種類に閉じ、途中で落ちても末尾の 1 行が壊れるだけになる。

sid 単位のファイルにするか 1 本にするかは実装の裁量に残す (どちらでも消し込みと保持期限の
意味は変わらない)。

**経路 (b) の配送は at-most-once である。** frame を接続に書いた時点を「配送した」とみなす。
購読の snapshot は「その sid 宛に未配送のもの全部」で、**購読すること自体が受信**なので、
snapshot を返す時点で inbox から消し込む (frame は購読の応答に続けて接続に積まれる)。
`message.send` が購読中の接続へ直接 push する場合も同じで、inbox には積まない。受信側が
接続ごと frame を取り落とせば、その本文はどこにも残らない。sid を持たない接続 (人が見ている
接続) の snapshot は空である — この topic が運ぶのはセッションに言われたことで、人はセッション
ではない。

こう決めるのは、inbox が「まだ届いていないもの」だけを持つ場所だからである (上の表)。手渡した
ものを受領確認まで残すと、inbox は「届いたかもしれないもの」を持つことになり、次の購読や
経路 (a) の再提示が同じ本文を 2 度届ける。**1 通は 1 経路でしか出ない**: 経路 (a) の再提示が
進行中の message を snapshot から除くのも同じ規則で、進行中に購読が来ても 2 通にはしない。

### 4.4 (a) で drop された時

受信側は流量制御 (token bucket / 重複判定 / queue 上限) を持ち、受理せずに drop することがある。
**drop されたものを配送済みにしない** (DV-Q2)。inbox に残したまま再提示の機会を待ち、
送信側には `delivered: false, reason: "throttled"` を返す。

理由: drop は「宛先が今は受け取れない」であって「届いた」でも「宛先が居ない」でもない。
配送済みにすると本文が失われ、`session_not_found` にすると宛先が居ないことになる。inbox に
残して再送すれば、§4.2 の他の未配送状態と同じ扱い (受け取れるようになったら出る) に揃う。

`throttled` は契約が定める理由であって、daemon が独自に足すものではない。daemon は契約の理由を返すだけで、
理由の集合を daemon 側で拡張しない。再提示の契機は §4.3 の「出す条件」そのもの (同じ sid への次の
`message.send` が (a) で通った / `inbox` を購読した / セッションが live に戻った) であって、時間ではない。
周期タイマーで再送しない (M3 — 相手の token bucket の回復速度は一次資料に無く、間隔を勘で決められない)。
古い順に 1 通ずつ出し、最初に通らなかったところで止める。通らなかった残りは inbox に順序のまま残る。

## 5. セッションの状態モデル

一覧の分類 (Pinned / Waiting / 生存 / 管理外 / Paused / Disappeared) は **daemon が導く**。
webui が生の値を組み合わせて分類すると、instance ごとに解釈がずれる。

### 5.1 入力

| 入力 | 何が分かるか | 取り方 |
|---|---|---|
| 接続 | ccmsg と話しているか、いつ話したか | transport (イベント) |
| harness 自身の一覧 (§3.8) | **セッションの存在**と、Claude Code ではさらに `waiting` (dialog)・messaging socket | 自 config home のみ (M6)。**判定が要る時にその場で読む** |
| llm-gateway の request / response | **実際に推論が走っているか** (= 忙しさ) | webhook (push)。**この instance が知っている sid にだけ効く** |
| `last_live` + `stopped_at` | 前回稼働中・意図して止めた | 自分が書いたファイル |
| transcript の fold | API error で止まっているか、最後の人間入力 | tail |

**`peers` は接続の有無で分かれない**。hello するのは `SessionStart` hook ひとつなので、
instance が再起動すると**既に動いているセッションは二度と hello して来ない** — 接続を持つ
ものだけを出すと、走っているセッションで埋まったホストが「稼働 0」に見える。`sessions/` が
名乗るセッションは hello の有無に関わらず行であり、どちらなのかは行の `state` (§5.2) が言う。

**生存中と失われたセッションも 1 種類の行で運ぶ** (2 つの list ではない)。セッションの登録・
消失は同一性を保ったままの `state` の更新であって、行が list を移ることではない。失われた行
だけが持つ field (`last_seen_at` / `stopped_at` と、再開が何として再開すべきかの
`model` / `effort`) は、接続由来の field が欠けた同じ行の上に載る。

接続が無い行には、接続についての field (`connected_at` / `last_activity_at` /
`client_version` / `protocol_version`) が無い。名乗った client が居ないので、世代は
推測するのではなく言わない。hello が名乗った `repo` / `ws` 等は `sessions/` がその sid を
名乗っている間は保持するので、hook の接続が閉じても行から消えない。

**1 つのセッションが両方の list に載ることはない**。`last_live` の entry が外れる条件は
「再び生存になったこと」であって hello ではない。resume は新しいプロセスと新しい状態ファイルを
作るだけで、hello を伴うとは限らない。

**分類の入力は購読に依存しない**。`sessions/` を「読むこと」と「監視すること」は別物で、
§6.3 が購読に従属させるのは後者だけ。どのセッションが存在するかは instance 自身の事実
なので、判定が要る瞬間 (message.send の宛先判定 / last_live の記録 / classify) には
その場でディレクトリを読む。監視と poll は「変化を購読者へ push する」ための資源であって、
答えの取得経路ではない。混同すると、誰も購読していない間は生きているセッションが
`session_not_found` になり、生きたままのセッションが last_live へ「消えた」と書かれる。

**codex の入力待ちは分類の入力に無い** (§3.8)。承認で止まっている thread は生存のまま読まれる。

**codex のセッションは端末を名乗らない。** 分類の「管理外」は「生きているが、こちらから
打ち込む手がかりが無い」の意味で (§5.2)、Codex の thread に端末として打ち込む道は無い。
よって接続を持たない codex の生存セッションは `live_unmanaged` として読まれる。
配送はこれとは別で、経路 (a) が thread の queue に載せる (§4.1)。

**`claude agents` の subprocess は持たない** (DV-Q6)。自 config home の `sessions/` を
監視すれば同じ集合が得られるので、5 秒ごとの子プロセス起動が丸ごと消える (M3)。
ファイル監視は取りこぼしうるので、低頻度の確認 poll を**併走**させる — これは旧 daemon が
transcript tail で実測を根拠に採った形と同じで、間隔の根拠は「監視が落とした変化を、
利用者が気づく前に拾う」であって、取得の主経路ではない。

`sessions/<pid>.json` は書き換えの途中で一時的に空または不完全な文書になりうる。その瞬間もファイルが存在するなら、daemon はそのファイルから最後に正常に読めた行を保持し、不完全な読み取りをセッション消滅として publish しない。完全な文書でプロセス不在と読めた時と、ファイル自体が消えた時は直ちに行を除く。監視は変化を知らせる資源であり、一時的な中間表現を現在値に昇格させる根拠ではない。

**gateway のイベントは自分が知っている sid にだけ効かせる**。gateway は全 config home の
上に立っていて、イベントは sid しか名乗らない。よって「gateway が見た」だけでは
**この instance のセッションについての証拠にならない** — 別 config home の sid を live と
分類し、`peers` に行を出し、`message.send` がこの instance に inbox を持たない宛先を
受け付けてしまう。生存 (`gateway_active_at`) の入力として効かせるのは、**hello 済み
(接続中または `last_live` に残っている) か、自 config home の `sessions/` が名乗っている
sid だけ**。イベント自体は捨てず `llm.requests` topic には流す — あれは「この instance の
セッション」ではなく「gateway が見ているもの」の写しだからである。

**生 status の使い道を絞る** (DV-Q5)。`sessions/<pid>.json` の status は
「そのセッションが存在すること」と `waiting` (dialog が開いている) の判定にだけ使い、
**Busy / Idle の判定には使わない**。忙しさの正本は gateway の request / response イベントで、
実際に推論が走ったかを知っているのはそちらだけである。

### 5.2 導出

```
Waiting      = 生 status が waiting (dialog)、または fold が API error で停止と判定
Pinned       = 利用者が固定した (daemon は印を持つだけで、分類の根拠にしない)
生存         = 接続がある / sessions/ にプロセスが居る / gateway に直近の活動がある
生存 (管理外) = 生存だが ccmsg とも terminal とも繋がっていない
Paused       = last_live にあり stopped_at がある
Disappeared  = last_live にあり stopped_at が無い
```

**「管理外」は配送経路を見ない**。ここで言う「繋がっている」は「こちらから打ち込める口が
あるか」であって、message が届くかではない。経路 (a) は `sessions/` の messaging socket や
Codex の thread queue に載せるので、管理外の行にも message は届く (§4.1) — 届くことと
操作できることは別の問いで、後者だけが分類である。

「Busy と Idle を分けない」(issue session-list-sections) ので、**生存の中の忙しさは
分類ではなく行の属性**として出す。忙しさは gateway のイベントから導き (§5.1)、
並び順は最終活動時刻。分類の側は忙しさを見ないので、gateway が設定されていない instance でも
セクション構成は成立する (行の属性が 1 つ欠けるだけ)。

「gateway に直近の活動がある」の「直近」は、gateway が最後に推論を見てから 5 分以内 (§1.3 の
生存窓)。窓を出た観測は生存の根拠にならず、次に payload を組む時には行の属性
`gateway_active_at` からも消える。窓の判定は読む瞬間に行い、窓が閉じたことを知らせる
タイマーは無い (§1.3)。

属性は分類ではないので、**gateway が同じ session を再び見ても出るのはその 1 行だけ**である。
frame は変化した行を運ぶので (§6.2)、時計が進んだことはその行 1 つの更新として購読者に届き、
他の行は送り直さない。sessions ドメイン全体の再計算を起こすのは**窓が開いた瞬間だけ**で
(= 行がセクションを移り得る唯一の契機)、窓の中で再び見られた時は該当 sid の行を組み直して
出すに留める — 推論は毎秒何度も観測されるので、1 属性のために「どのセッションが居るか」を
読み直す仕事まで毎回払わない。推論をそのまま見たい client には gateway 自身の view である
`llm.requests` がある。

### 5.3 「最終活動時刻」の 2 種

旧 daemon は「ccmsg リクエストのたび更新される時刻」(エージェントの忙しさ) と
「人間が入力した時刻」(並び順) の 2 つを別の場所に持っていた。v2 は**用途が違う 2 つの値
であることを型で明示**し、どちらを並びに使うかを 1 箇所で決める。同じ名前で 2 つ持たない。

### 5.4 sid から transcript を引く 2 経路

sid が指すファイルは **announce と walk の 2 経路**で引く。hello が名乗った `transcript_path`
が第一で、正確かつ探索コストが無い。名乗りが無い sid (この instance に hello していない、
既に終わったセッション) は `projects/**/<sid>.jsonl` を歩いて、**ファイル名が持つ identity**
から同じファイルに辿り着く。読む op (`transcript.read`) も追う側 (tail、`transcript:<sid>`)
も同じ経路を使うので、**同じ sid はどちらから来ても同じファイルに解決する**。

2 経路とも境界は 1 つで、**自 config home の `projects/` ツリーの中しか見ない** (M6)。
announce された path は「そのツリー内にあったから受理された」もので、walk はそのツリーを
歩くものだからである。受理の判定は **ファイルの有無ではなく置き場所**: session-start hook が
名乗る時点では harness はファイルもディレクトリも作っていないし、`projects/` 自体が
未作成の config home (初回セッション) もありうる。存在する区間は realpath で辿り、
無い区間は綴りのまま繋いだ上でツリー内か比べるので、`..` や symlink で外へ出る path は
綴りが内側でも受理されない。受理しなかった path は `peers` の行からその field が消えるだけで、
hello は `ok` のまま (契約は変えない) — **理由は daemon の log に 1 行出す**運用側の責務とする。

## 6. topic の実装

契約は「`topic.subscribe` の直後に `snapshot: true` の frame が 1 回、以後は同型の delta」
という 1 形だけを定める。daemon 側はこれを **topic ごとに書かず、1 つの仕組みとして持つ**。

### 6.1 topic 1 つが持つもの

| 要素 | 内容 |
|---|---|
| 現在値 | 持ち主が答える (§3.3)。topics が持つのは直前に送った wire だけ |
| 購読者 | 接続の集合 |
| 更新の入口 | domain 側から「新しい値」を渡す 1 関数 |
| 抑制 | **値を置き換える粒度に限り**、直前に送った値と同じなら送らない (**全 topic 共通の 1 実装**、M5) |

旧 daemon は 3 つの topic 相当にだけ抑制があり、しかも別実装だった。v2 は抑制を
topic の仕組みに内蔵するので「この topic には抑制がない」が起きない。

### 6.2 差分の粒度

| 粒度 | topic |
|---|---|
| instance ごとの全量置換 | `instances` / `session.errors` / `llm.requests` / `llm.status` |
| 全量置換 | `session.status:<sid>` |
| 要素の追加・更新 | `peers` / `agents` / `inbox` / `kv:<ns>` |
| 追記 (byte offset) | `transcript:<sid>` |
| 追記 (型付きアイテム) | `transcript.items:<sid>` |
| event (値を保持しない) | `notify` |

`transcript:<sid>` の snapshot は **ファイルの現在の末尾 (`size`) だけ**で、追記はその後から
流れる。§5.4 の 2 経路で引けるファイルには常に返るので、**追記が二度と起きない過去セッション
でも「どこから遡るか」は snapshot から分かる**。購読者は size を起点に `transcript.read` で
遡り、追記が来ればそのまま繋がる。

`transcript.items:<sid>` は同じ追記をアイテムで運ぶ (§3.6)。snapshot は**末尾側のアイテム一定数**で、
byte 側の snapshot が「どこから遡るか」を答えるのに対し、こちらは購読者が即描ける末尾そのものを答える
(アイテムには「そこから遡る」ための座標が無く、遡るのは範囲指定の `transcript.items.read` の仕事である。
snapshot の先頭アイテムを `until_id` に渡せばその手前が返り、以降は `prev` を渡し続けて遡れる)。
この末尾は **tail を起動したターンの内側で読む** (byte 側の snapshot が size をそうしているのと同じ理由)。
seed を待たずに答えると snapshot が空になり、末尾から描く client は「アイテムがまだ無い」と「これが末尾だ」を
区別できないまま transcript の先頭を出してしまう。件数で切るのは、tail の読み出し (`FOLD_TAIL_BYTES` = 1 MiB) が bytes で切られているためで、
小さい record が並ぶ file では最初の frame がその読み出しと同じ大きさになってしまう。

**追記された結果が既存の呼び出しを埋めても、その呼び出しは送り直さない。** 購読者は追記しかしない列を持つので、
一度渡したアイテムの差し替えは粒度の意味を壊す。結果の側が `parent_item` で呼び出しを名指すので、
読み手は手元の列の中でそれを結べる (webui が bash の use と result を別に描いているのと同じ形)。

1 本の tail が両方の topic を養う。分類は**購読の有無に関わらず**進める: 分類は file 全体を読み続けている
状態そのもので、今返ってきた結果の呼び出しは遠い過去の bytes にあり、購読された時点で開いた分類はそれを知らない。
保持するものは有界である (未応答の呼び出しと、最初の frame に載せる分のアイテム)。

**抑制がかかるのは全量置換の 2 粒度だけ** (`whole` / `per_instance_whole`)。同じ全量を
もう一度送っても購読側は既に持っている値を持ち続けるので、送る意味が無い。

**`peers` / `agents` は「新しいか」を行ごとに問う**。両者は要素粒度なので frame 単位の抑制は
効かず、代わりに**直前に送った行と比べて違う行だけ**を frame にする。比べ方は同じで (直前に
送った wire と比べる)、単位が値から要素に変わるだけなので、実装は topic の仕組みの側に 1 つ
だけ置く (M5)。何も違わなければ frame は出ない。行が消えたことは不在では言えないので、
`{sid, instance, removed: true}` という印を付けた要素として出す。

差分を取る相手は**購読者に送った内容**なので、購読開始時の snapshot frame (= 全行) もその
基準を更新する。これをしないと、snapshot でしか渡していない行の消失が「前に送っていない行の
消失」になり、誰にも届かない。

`agents` の `polled_at` は載せる。確認 poll (§5.1) のたびに変わる値だが、行の差分が空なら
frame 自体が出ないので、これが heartbeat になることはない。

**delta の粒度 (`element` / `append`) と `event` は素通しする**。同じ内容の frame が 2 回
出るのは「同じことが 2 回起きた」であって重複ではない — inbox の再提示は 1 回目を聞いて
いなかった相手に届く唯一の機会だし、kv の同値再送も追加操作そのものである。**event** は
加えて現在値を持たないので、購読しても snapshot が出ない。抑制の実装は 1 つのままで、
契約の粒度を見て適用範囲を決める。

**instance ごとの全量置換**が mesh の要。frame は発生元 `instance` を必ず伴い、購読側は
「その instance 分だけ」を置き換える。他 instance の分は残る。この規則があるので、
複数 instance の全量が同じ topic 名で衝突しない。

### 6.3 購読の管理

- 購読は接続に従属する。接続が閉じれば購読も消える (別の後始末を持たない)
- **上流の資源は購読者がいる間だけ動かす**。`transcript:<sid>` の購読が 0 になれば tail を止め、
  `agents` の購読が 0 になれば `sessions/` の監視を止める。購読が資源のライフサイクルの唯一の駆動源
- ここで購読に従属するのは **「変化を push するための監視」だけ**であって、**「今どうなって
  いるかを読むこと」ではない**。値の持ち主に現在値を聞く経路 (§3.3) と、§5.1 の分類の入力は、
  購読者が 0 でも同じ答えを返す
- cluster 全体の topic を購読された instance は、mesh の各 peer にも同じ topic を購読させ、
  受けた frame をそのまま (発生元 `instance` を保ったまま) 購読者へ流す (§7.4)

### 6.4 送出側の上限

抑制 (§6.1) は「前と同じ値」しか止められない。**値が毎回変わりながら高頻度で更新される**場合は
全部が frame になり、購読者は読めない量を渡される。そこで **終端 1 つにつき出力 queue を 1 つ**
持ち、topic frame は必ずそこを通す。終端は人の接続・mesh peer・CLI の購読者のいずれでも同じ層で、
経路では分けない。relay が受けた frame も §7.4 の publish を通るので同じ層に乗る。

扱いは契約の粒度 (`TOPIC_ATTRIBUTES`) が決める。抑制と同じ表を 1 箇所で読む (M5)。

| topic 種別 (粒度) | 例 | 扱い |
|---|---|---|
| 全量置換 (`whole` / `per_instance_whole`) | `instances` / `session.status:<sid>` / `llm.status` | **畳む**。`topic × instance` を key に、待っている frame を最新の値で置き換える |
| delta・event (`element` / `append` / `event`) | `peers` / `agents` / `inbox` / `kv:<ns>` / `transcript:<sid>` / `notify` | **畳まない**。発生順に並べ、queue の上限を超えたら投入側に返す |

畳んだ値と並んだ出来事は **同じ flush で、queue に入った順に** 出る。畳んだ値は最初に入った位置を
保ったまま中身だけが最新になるので、出来事との前後関係が入れ替わらない。

| 値 | 種類 | 何を決めるか | 根拠 |
|---|---|---|---|
| flush 周期 100ms (`FLUSH_PERIOD_MS`) | 上限 | 1 つの終端へ frame を出す頻度の上限 | 読み手側: 表示の更新より細かい frame は誰にも見えない一方、遅延として読まれ始めるのは 1/4 秒あたり。cluster 側: relay は hop ごとに 1 回待つので、体感遅延は 100ms × hop 数。2 hop でも「即時」の範囲に収まる |
| 畳めない frame の上限 256 (`QUEUE_LIMIT`) | 上限 | 1 終端が同時に抱える「畳めない frame」の数 | 畳める frame は何度 publish されても 1 件なので上限が要らない。256 は 100ms ごとに捌ける量なので、到達するのは 1 秒あたり 2500 件超を出し続けた場合だけ = 人・セッション・peer のいずれの産出量でもなく、この層が備える storm |

**周期タイマーではない** (M3 の対象外)。timer は「待たされる frame が出た時」だけ armed され、
静かな終端は何も持たない。直前の flush から周期が経っていれば **その場で送る**ので、単発の変化は
待たされない。

上限超過は **黙って捨てずに投入側へ返す** (`publish` が `rate_limited` を返す):

- `notify.send` / `say.post`: op が `rate_limited` を返す。引数は正しく失敗も起きていないので、
  送り手が読み直すべきものは無く、読み手が追いついてから同じ呼び出しを送れば通る
- `message.send` の inbox 経路: 既存の `throttled` と同じ扱い = inbox に保持して後で offer し直す
  (§4.4)。メッセージは落ちない
- `transcript:<sid>` の追記: frame は `start` / `size` を持つので、購読側は欠けを検出して
  `transcript.read` で読み直せる

## 7. mesh

### 7.1 endpoint と id

**endpoint は instance の公開 base URL** (`https://h.example/personal/`、末尾 `/`、`http(s)://`) で、
`<endpoint>ws` (https のまま HTTP upgrade する)・`<endpoint>mesh/*`・`<endpoint>auth/*`・
`<endpoint>webhook/*` はその下の route であって endpoint の一部ではない (契約 `Endpoint`)。

**config が持つのは `peers` (自分の分を含む全 endpoint の一覧) だけで、そのどれが自分かは
起動時の probe で確定する** (mesh-self-identification、§8.2、DR-0001 §2.7)。proxy や別名の
裏に居る instance の URL は、プロセスが自分の socket から読み取れる値ではないが、probe は
どの URL 経由で来たかを読まず「自分に届いたか」だけで決まるので、proxy / alias 越しでも
成立する。

**手順**: `peers` の各 endpoint に宛先ごとに違う token を付けた probe を送り、自分の listener
に届いた token を対応表と照合する。一致した 1 つの URL が自分の endpoint である。自分宛を
送信対象から外してはならない — 自分宛の 1 通は必ず自分に届くので、token を盗んだ peer が
それを送り返しても一致が 2 つになって失敗に落ちる (mesh-self-identification §4.2)。

**一致 0 / 2 以上は起動失敗**。0 は `peers` に自分が居ないか誰も居ない URL を書いた場合、
2 以上は同じ instance に届く URL が 2 つ (別名・LB) 書かれた場合で、どちらを正式な名前と
するか決められない以上、壊れた config と同じ扱いで起動を止める (§8.3)。答えなかった peer は
一致数の計算から外し、記録するだけで起動を止めない (片方の PC が電源断・スリープ中で
あることは、この mesh では常態である。DV-Q11)。§7.2 の dial 対象としては残る。確定した
自分の endpoint は dial しない (§8.2)。

**instance id は endpoint と別のものである。** id は state に持つ固定値 (§3.6)、endpoint は
設定で変わりうる URL で、両者の対応は handshake が作る: `MeshHello` が id を名乗り、proof が
通った時点で束縛される (「proof の後に hello の内容が遡及して信頼される」mesh-peer-auth
§5.1 R7 の規則に乗る)。dial した側は相手の `hello` 応答の `instance` から同じ束縛を作る —
この向きで名乗りを裏付けるのは、dial した URL の TLS である。

**1 つの id が束縛できる endpoint は 1 本だけ**で、既に別の endpoint に束縛済みの id を名乗る
hello は、新しく来た側を close する。名乗りを裏付けるものは operator が配った endpoint の
一覧しか無いので、その一覧が既に裏付けた束縛のほうを残す。引っ越した instance の旧 URL が
まだ生きている場合がこれに当たり、直し方は各 peer の `peers` から旧 endpoint を外すこと
であって、新しく来た link を勝たせることではない。

`to_instance` (id) から dial 先の link を引くのもこの対応表である (§7.3)。一度 handshake が
終わった endpoint は切断後も表に残り、`instances[]` に「到達不能」の印付きで現れる (§7.5)。
**config が挙げた peer は handshake 前でも `instances[]` に出る**が、その行の `id` は無い
(まだ誰も名乗っていないため)。id を持たない行を隠すと、link が落ちている peer — 読み手が
まさに探している行 — が消えるので、endpoint と `reachable` だけで出す。mesh を持たない
instance は名乗る URL が無いので `hello` の `endpoint` を返さず、`instances[]` の自分の行も
endpoint を持たない (行そのものは出る)。

### 7.2 dial と glare

- 各 instance は全 peer に対等に dial する (dial 責務を片側に割り当てない)
- 認証は mesh-peer-auth。`hello.instance` が起点で、C2 で鍵と challenge を交換し、
  C1 で proof を返す。ack を受けるまでメッセージを送らない
- glare (2 本張られた) は両方を検証したうえで、`iss` 文字列の小さい側が dial した接続を残す。
  比べるのは **endpoint URL** である (`iss` は endpoint であって id ではない)。両端が同じ 2 本の
  文字列を比べるので同じ結論に至る、というのがこの規則の全てで、どちらが優れているかではない
- 再接続のバックオフは緩くてよい。相手が復旧すれば相手から dial してくる
- ハートビートは持つ (無通知切断の検出)

### 7.3 op の転送

`locality: instance-local` の op は、対象の担当 instance が自分でなければ転送する。

```
webui ──▶ instance A ──(封筒: to_instance=B, from_instance=A, hops=[A])──▶ instance B
                    ◀──────────── 応答 ────────────────────────────────
```

- 封筒は契約の `RequestEnvelope` の 3 フィールドだけ。mesh 固有の op を持たない
- `hops` に既に自分がいる request は落とす (ループしない)
- 転送先が確立済み接続に無い / 応答が期限内に返らない → `instance_unreachable`
- **転送された op も、転送先で §3.2 の 1〜6 をもう一度通す。** 「A が認可したから B は信じる」に
  しない。A が侵害された場合に B の認可が消えるため
- やり直す相手は封筒の `caller` (認証済み link が名乗った呼び出し元) であって、転送元の判断ではない

「対象の担当 instance」の決め方: sid → 担当 instance の対応は `peers` topic の行 (生存中と、
生存していないが保持期間内のもの) → `agents` topic の行 (ハーネスが把握している全セッション)
の順で探す。知らない sid は「cluster のどこにもない」= `session_not_found`。ただし到達不能な
instance がある間は判定を保留する (§4.2)。

### 7.4 event の relay

instance A に繋いだ購読者が cluster 全体を見るために、A は各 peer の同じ topic を購読し、
受けた frame の `instance` を保ったまま自分の購読者へ流す。A は中身を再計算しない
(再計算すると発生元と A の 2 箇所に同じ判定が生まれる)。

relay するのは **instance ごとの全量置換の topic と、`peers` / `agents`** である。後者は要素
粒度だが、行が自分の instance を名乗るので他 instance の行と同じ topic 名で並べられる
(`inbox` の要素は「どのセッションのものか」しか言わないので relay しない)。行の topic では
A も要素ごとに保持し、**peer が言い直しただけの行は自分の購読者へ流さない** (§6.1 の抑制を
要素単位で適用する)。peer の snapshot frame (= その instance の全行) は「言い直し」ではなく
全量の言い直しとして扱い、peer が持たなくなった行は A が `removed` として下流に伝える。

### 7.5 instance の断絶

- その instance のセッションは **Disappeared の一種**として扱う (issue multi-host-cluster 7)。
  復帰時に戻る
- 断絶中の `instance-local` op は `instance_unreachable`
- 断絶は `hello` の応答に含まれる `instances[]` の `reachable` と、`instances` topic に現れる
- `instances` topic が同じ一覧を運ぶので、購読者は挨拶し直さずに link の切断を知る。
  `peers` の行と分けてあるのは、mesh の見え方が「その instance が全 link をまとめて読んだ
  1 つの値」であって行の集まりではないため (§6.2 の粒度の選び方)
- **断絶した instance の分の全量を消さない**。消すと復帰時に全量が返ってくるまで空になる。
  「到達不能」という印を付けて保持し、**再接続で置き換える。7 日で破棄する** (DV-Q12)。
  7 日は inbox / last_live の保持窓と同じ値で、揃えているのは「その instance が 7 日戻って
  こなければ、そこに紐づく未配送も前回稼働中の記録も既に消えている」ため。片方だけ残っても
  参照先が無い

## 8. 起動と停止

### 8.1 instance ごとに分けるもの

socket path / HTTP の bind / state dir / data dir / ログ。**すべて config home から導く。**
セッション内の CLI は `CLAUDE_CONFIG_DIR` から自分の instance を引く。

### 8.2 config

| 項目 | 中身 |
|---|---|
| 自 config home | この instance が見る唯一の config home (M6) |
| peers | 属する cluster の mesh endpoint 全部、自分の分も含む。**導かれる**: 各 cluster が挙げる instance (各ファイルが与えた address) と、その cluster が知らされた endpoint。どれが自分かは起動時の probe で確定し、読む側が自分を除く (§7.1)。**config に載る URL の一覧はこれだけ**である |
| 入口の許可 | bind、source IP |
| upstream | gateway の URL と webhook source、terminal gateway、launcher (root と テンプレ)、translate helper、sandbox origin |

`upstream.terminal_gateway` は rename の経路であると同時に、人が terminal を開く先として `hello` で名乗る値でもある (§3.1)。

**config は起動時に 1 回だけ読む。無再起動での反映は持たない** (DV-Q8)。instance ごとの
config は小さく、再起動が安い (状態のほとんどが揮発で、永続化するのは §3.6 の 5 種だけ) ので、
「編集が次のリクエストから効く」ための mtime 監視・再読込・再配線を持つ理由がない。
config を変えたら instance を再起動する、が唯一の反映手順になる。

**設定は、判断であるところは TypeScript、一覧であるところは JSON。そして人が編集する物と instance が読む物は別**。人が編集するのは `${XDG_CONFIG_HOME:-~/.config}/ccmsg/`:

| ファイル | 中身 |
|---|---|
| `config_v2.ts` | `({ builtin, config }) => config` — この host の全 instance の出発点 |
| `endpoints.json` | `[{id, endpoint}, …]` — mesh の全 instance。この host の分も他 host の分も |
| `supervisor.json` | `{instances: ["<id>", …]}` — そのうちこの host が起こす分 |
| `instances/instance-<id>.ts` | `({ builtin, default, config }) => config` — instance 1 つ分 |
| `ccmsg-config_v2.d.ts` | TypeScript が書く型の宣言。`daemon add` がここに置く |

instance と監督者が読むのは `$CCMSG_STATE_DIR/config/` の方である: 読んで検証した結果そのものである `satisfied.json` と、その元になった各ファイルの写し。**検証を通らなかった物はここに来ない**し、二度評価もしない — 動くのは検証したその値であって、それを作ったファイルの読み直しではない。

**mesh はデータである**。`endpoints.json` は全 host で同じ一覧で、instance は自分の id の行で自分を見つける。その行が自分の endpoint であり、peer が dial する先であり、handshake の `iss` / `aud` であり、人に見せる URL である (§7.1)。一覧が名指ししていない instance は address が無いので拒否する。設定関数にはこの一覧が渡り、読むのは自由だが (他に誰が居るか知りたい instance はこれを読む)、違う一覧を返したら拒否する。mesh は設定関数が述べるものではないからである。他 host の instance は「ここでは起こさない行」であり、`supervisor.json` がこの host の起こす分、そこに載る id は mesh の行であり自分の設定ファイルを持っていなければならない。

**id は何であるか、name は何と呼ぶか**。id は 16 byte の乱数の hex で、`daemon add` が作って instance の state dir に書く — instance が発行した物すべてがその id で引かれる (§3.6) ので、一度外した config home を足し直しても元の id に答える。name はラベルで、既定は id、置き場はファイルの中。改名でファイルは動かず、記録も書き換わらない。

**起動と reload は同じ 1 本の処理**。全部読み、JSON は JSON として検査し、TypeScript は呼ぶ (設定関数は promise で答えてよいので常に await する)。各ファイルはそれ単体で分かる範囲まで検査するので、間違いはそれを書いた場所で報告される。最後の関門は全体である: 監督者が起こす id は mesh の行を持ち自分のファイルを持つこと、2 つの行が同じ address を持たないこと、2 つの instance が同じ port や同じ config home を持たないこと、どの設定関数も mesh を述べ直していないこと。ここまで通って初めて state 側を書き、起動 / reload する。

**通らなかった設定は何も変えない**。state 側は触らず、何が悪いかを log に書き `ccmsg daemon status` が答え、host は前回適用された物で起動する — セッションを抱えている instance は、ファイルの打ち間違いで奪ってよい物ではない。例外は初回だけで、その時は戻る先が無い。`daemon add` / `daemon remove` も編集用を書いた後にこの同じ処理を通る。

**2 つの側を見比べるのが `ccmsg config`**。`list` は各ファイルが何で、何が悪くて、適用済みの写しと違うかを言う。`diff [file]` はその差、`diff --satisfied` は「適用したら全体が何に変わるか」。`show` は編集用を評価して出来上がる `satisfied.json` を表示する (何も書かない)。`revert <file> | --all` は適用済みの写しを書き戻し、上書きする物を `$CCMSG_STATE_DIR/config.rejected/<パス>.<時刻>` に残してその場所を出力する。`show` と `diff --satisfied` は問いに答えるために設定関数を呼ぶので、**設定関数は副作用を持たない前提**である。

写すのは上に挙げたファイルだけである。設定ファイルが import する先はそのファイルの都合であり、ここでは控えない — そちらが失われても `satisfied.json` があるので instance は起動する。起動させるのは値であってファイルではないからである。

`config_v2.ts` には `builtin` (組み込み既定) が、instance のファイルには `builtin` と `default` (`config_v2.ts` が返した値) が渡る。どちらも深く凍結してあり、`config` は 1 段上のコピーなので、渡された物を書き換えて返す。instance のファイルは自分が答える config home の絶対パスを `config.dir` に書く。**マージ規則は無い。何もマージしないから**である — ファイルは土台の全体を受け取り動かす値の全体を返すので、`config.dump.presets = […]` なら置換、`.push(…)` なら追加で、どちらのつもりかはファイルが言う。

誰も持っていない field を書いた場合は読み取りを終わらせる。例外を投げた場合・設定でない物を返した場合も同じ。綴りを間違えた field は「書いたのに効かない設定」であり、それを黙って落としたまま起動するのは §8.3 が拒否する状態そのものだからである。

### 8.3 起動の順序

1. パス解決と state dir の作成
2. 単一インスタンスの取得 (ロック)。先客がいれば何もせず終了。lock file が名乗る pid の
   プロセスが既に居なければ (signal 0 で確認) file を引き継いで取り直す
3. config 読み込み。**壊れていたら起動失敗** (DV-Q9)。機能を無効にして起動を続けると、
   「設定したはずの機能が黙って効いていない」状態が実行時まで持ち越される。§7.1 の
   peers 検証の失敗と同じく、設定ミスは起動時に落とす。config が名指すものの解決もここで
   行い、同じ理由で落とす: gateway の webhook secret が読めない、translate helper が起動
   できない、はどちらも「設定したはずの機能」が黙って効かない状態そのものである
4. **instance id を読む** (state に無ければここで生成する、§3.6)。id から導かれるもの
   すべてより前に置く: `mid`・store の鍵・`last_live` はどれもこの id で引かれるので、
   id が無いうちに作ってよいものが 1 つも無い。`instances/` のどのファイルも名乗っていない
   config home を `ccmsg daemon run` で起こした場合も、初回の id はここで持つ
   (DR-0001 §2.1)
5. **自分の endpoint の確定** (§7.1)。mesh を持つ構成では **WS を先に bind してから**行う:
   確定の中身は自分が送った probe が自分の listener に届くことなので、listen の前には
   置けない。この間 listener が答えるのは probe と mesh-peer-auth §6 の鍵の 2 経路だけで、
   それ以外の要求は instance ができるまで断る (窓は probe 1 往復分)。一致 0 / 2 以上なら
   起動失敗、答えなかった peer は記録して dial 対象に残す。mesh を持たない構成は dial
   される側にならないので endpoint を持たず、`hello` でも名乗らない
6. `last_live` と inbox の読み込み。4 の後に置くのは、どちらの entry も `instance` として
   instance id を持つから — id から導かれるものは id より前に存在しない
7. listen。pid の記録 → socket dir の用意と、実 path のうち pid が既に死んでいるものの掃除
   (ロックの引き継ぎと同じ判定) → UDS を `daemon.<pid>.sock` に bind → クライアントが使う
   安定 path `daemon.sock` を、accept 開始後に symlink を一時名で作って rename し atomic に
   差し替える (§8.5) → WS (mesh を持つ構成では 5 で bind 済みのものを組み込む。持たない構成で
   HTTP を持つなら、ここで bind する)
8. peers への dial (§7.2)

**upstream の監視 (transcript tail / `sessions/` / gateway) は起動時に始めない。** 購読が
資源のライフサイクルの駆動源 (§6.3) なので、最初の購読で始まる。

### 8.4 instance は常駐する

**lazy 起動 (その config home のセッションが最初に `ccmsg` を呼んだ時に起動する) は採らない**
(DV-Q10)。instance は常駐し、**常駐の面倒を見るのは 2 段の監督**である。

- `ccmsg daemon supervise` — foreground の監督者。共通 config の `instances/` を起動時に
  1 回読み (DV-Q8)、各 config home の instance を子プロセスとして起動し、落ちたら上げ直す。
  再起動の待ちは指数的に伸びる (根拠は実装のコメント: 起動直後に落ちる config 不備を
  spin させないため)。SIGTERM を受けたら各子を `instance.shutdown` で §8.5 の順に止める。

  **instance を起こす経路は監督者だけである。** `ccmsg daemon start / stop / restart /
  status` は監督者への要求であり、CLI が自分で子を起こす経路は持たない — 別経路で起きた
  instance は「誰も上げ直さず、誰も知らない」状態になり、常駐 (DV-Q10) が言っている
  ことと食い違うからである。監督者が居なければこれらは
  `{"error":{"code":"supervisor_not_running"}}` で失敗する。要求は state に置く control
  socket (`<state root>/supervise.sock`、0600) を JSON lines で流れ、op 名は
  `supervise_*` で契約の op と区別する — **これは契約ではない**。ホスト上のプロセスに
  ついての内部プロトコルであって、webui も mesh の相手もここには来ない。

  `ccmsg daemon add <dir>` は instance id を発行して `instances/instance-<id>.ts` を書き
  (ラベルは dir 名から、harness は目印ファイルから、port は登録済みの最大 + 1 の空き)、id と
  その loopback address を `endpoints.json` に、id を `supervisor.json` に載せ、§8.2 の処理を
  通してから監督者に伝える。proxy が前に居るかどうかはここからは見えない deployment の事実
  なので、居る場合はその行を人が直す。`remove <name | id | dir>` は両方のファイルから id を
  外して設定を消し、state dir は残す — そこの id で instance が発行した物すべてが引かれる
  からである。`remove` は見るのをやめるだけで**子は止めない** — 一覧の編集は shutdown では
  なく、その instance と話しているセッションはそのまま話し続ける。

  例外は 2 つ。`ccmsg daemon run [dir]` は foreground の単発起動で監督者の管理外
  (`status` にも出ない)。`ccmsg daemon log` はファイルを直接読む — ログは死んだ後に
  読むものなので、監督者が居ないと読めない設計にはしない
- `ccmsg config list | diff | show | revert` — 書かれている物と適用されている物を見比べる
  (§8.2)。`daemon` の下でなく単独なのは、対象がファイルであり、ファイルはどれか 1 つの
  instance の物ではなく host の物だからである: どれが間違っているか、適用したら何が変わるか、
  通った写しを書き戻す。

- `ccmsg service register` — その監督者を launchd (macOS) / systemd --user (Linux) に
  登録する。ログインを跨いで常駐させるのはこの層の責務であり、`ccmsg plugin install` が
  配るのはエージェント側の plugin だけである。`ccmsg service stop` は launchd では
  **bootout** (unit file は残す)、systemd では `stop` — どちらも「止まったまま」を意味する。
  signal では launchd の `KeepAlive` / systemd の `Restart=always` が起こし直してしまい、
  頼まれたことにならない (止めた上で unit file も消すのが `unregister`)

監督者は特定の config home に属さないので、その出力だけは §8.1 の「config home から導く」の
例外として `${XDG_STATE_HOME:-~/.local/state}/ccmsg/service.log` に置く (systemd では unit の
出力は journal に行くので、`ccmsg service log` はそちらを読む)。`ccmsg service status` は
ccmsg 側の読み (registered / running) と **init system 側の読み** (`service`: loaded /
running / pid / last exit) を並べる — file はあるのに launchd が知らない、のような食い違いを
潰さずに見せるためである。unit に書く program の path は、**版に依存しない安定パス**を
解決して登録する (この build へ辿り着く PATH 上の `ccmsg` を優先し、版付きディレクトリを
含む runtime 自身の path は避ける。次の upgrade でその path ごと消えるため)。`ccmsg service
status` は登録済み unit からその path を読み戻して出す (`program`: path / durable / exists)
— program が移動した監督者は、他のどのフィールドから見ても「一度も起動していない監督者」と
区別が付かないからである

理由は mesh から見た区別が付かないこと。lazy だと、dial できない instance が
「寝ているだけ (呼べば起きる)」なのか「落ちている」のかを外から判別できない。判別できないまま
両方を `instance_unreachable` にすると、寝ている instance 宛の op が永久に失敗し続ける
(誰も起こさないため) — 起こすのは同じホストのセッションだけであり、mesh の相手は起こせない。

常駐だと使っていない config home の daemon も上がり続けるが、instance の常駐コストは
§8.3 のとおり「購読が無ければ upstream の監視も動かない」ので、接続を待つだけの状態になる。

### 8.5 停止の順序

1. 新しい要求の受理を止める (再入ガード)
2. 上流の監視と子プロセスを止める
3. 全接続に「再起動する」を通知する (**transport を落とす前**)
4. 永続化するもの (§3.6) を確定させる
5. listener を閉じる。**UDS を最後に閉じる** — クライアントは「UDS に繋がらない」を退去完了として
   観測するので、後継と競合しうる address (HTTP listener) を手放してから閉じる。UDS 以外の間には
   順序が無いので並行に閉じる (期限がそれぞれ 250 ms あり、直列だと理由なく足し算になる)。
   閉じることで消えるのは自分が bind した `daemon.<pid>.sock` だけで、安定 path の symlink は
   触らない (後継が既に自分へ付け替えているかもしれない。自分を指したままの dangling symlink は
   「UDS に繋がらない」= 退去完了の観測として本項の意味論どおり)
6. pid ファイルとロックを手放す。**listener を全部閉じ切ってから** — pid とロックは「まだ退去中」
   であることの観測可能な証拠なので、これが先に消えると、届かない socket が完了した停止と
   区別できなくなる (= 自分の停止処理で固まったプロセスが、外からは停止済みに見える)。
   listener の close が失敗しても手放す (どちらにせよこの process は去るので、握ったままだと
   誰も serve していない config home に後継が入れない)

listen した path が stop で unlink されるのは Bun の挙動 (1.3.13 実測)。実 path と安定 path を
分けるのは、退去する instance が後継の受け取った address を消さないためである。

**期限**。served な WebSocket は自分で `ws.close()` を呼んだ後 `stop` が settle しない
(1.3.13 実測。mesh は glare の敗者・沈黙した link・手順を外れた peer を落とすので実際に呼ぶ) が、
address は 1 ms 以内に実際に手放されて再 bind できる。よって WS の close は **250 ms** で
打ち切り、以降は promise でなく address を信じる。UDS の `stop` は同期で返るので待ちは無い。
監督者は各子に **10 秒** の graceful を与え、超過したら SIGTERM → さらに 10 秒 → SIGKILL と
上げる。監督者自身の socket を閉じるのは全ての子が終わった後 — 5 と 6 が instance について
言っているのと同じことで、socket が先に消えると、まだ子を看取っている監督者が外からは
消えたものとして観測される。init 側 (`service stop`) も
同型で、SIGTERM の後は監督者 pid の消失を 10 秒待ち、超過したら SIGKILL に上げてから事実を返す。

この順序は旧 daemon で規約として確立しているので引き継ぐ。

## 9. 責務外

理由と、目的のどこに紐づくかを添える。ここに挙げたものを足したくなったら、
足す前に §1 を見直すのが正しい問いになる。

| 対象 | 理由 |
|---|---|
| webui の配信 | webui は自前の静的サイト (DR-0032 §2.1)。daemon は API だけを提供する |
| 権限分離 | A4 (単一 uid)。境界は OS の uid とファイル権限であって daemon の中ではない |
| 認証境界を越える相手 | A5。別 uid / 別 config home の instance とは mesh を張らない |
| 会話ログの保存 | 正本は transcript (契約 §2.1)。ccmsg 側の永続ログを持たない |
| 上流の判定のやり直し | gateway の severity、Claude Code の permission 判定などは発生元が正本。写すだけ (§3.5) |
| 他 config home の観測 | M6 |
| 契約の検証ロジック | A1。protocol リポの検証器を呼ぶ |
| v1 との互換 | 新系は別 instance として横に立てる (DR-0032 §2.2)。両受けしない |

**人の認証はここに入らない。** 「誰が来たか」には daemon 自身が passkey で答える (DR-0001、
実装の接続点は §3.7)。
前段 (proxy の forward auth / tunnel の identity) に寄せると、その構成が利用者ごとに違うぶん
daemon が受け取る identity の形も揃わないためで、前段は透過でよい (DR-0001 §3)。権限分離を
持たないこと (A4) とは両立する: daemon が持つのは「誰か」を確定するところまでで、確定した後の
権限の境界は uid とファイル権限のままである。

## 10. 不採用

| 案 | 不採用の理由 | 再検討のトリガ |
|---|---|---|
| op ハンドラごとに role / capability を検査する | M1 そのもの。属性表と分岐の 2 表現になり、片方だけ変わる | 属性表では表せない認可が要求されたとき (引数の中身で可否が変わる op) |
| 観測系に one-shot 取得 op を残す (CLI の往復を減らす) | M2。往復 1→3 の増加より、同じ値の 2 経路目のほうが高くつく | 往復が「数えるもの」から「体感するもの」になったとき (3 往復が響く規模の一覧) |
| 未配送を時間窓の巻き戻しで救う | 配送保証の穴を時間で塞ぐ形。inbox は「届いたか」を状態として持つので窓が要らない | inbox を持てない配送面が現れたとき (受信側が自分の状態を保持しない) |
| 配送を (b) だけにする | 受信側が購読を張るまでの穴が残り、時間窓が復活する | (a) の経路が harness 側から失われ、1 本目の経路が無くなったとき |
| 配送を (a) だけにする | 非公式プロトコルの世代変更で配送が全滅する | 非公式プロトコルが公式化され、世代変更が予告なしに起きるものでなくなったとき |
| (a) で drop されたものを配送済みにする | 本文が失われる。drop は「今は受け取れない」であって「届いた」ではない (§4.4) | drop が本文を伴って通知され、drop 後に本文を再構成できるようになったとき |
| inbox を揮発にする | 未配送の本文はどこからも再構成できない。daemon の再起動で消える (§3.6) | 未配送の本文を daemon の外が保持するようになり、再起動で消えなくなったとき |
| Busy / Idle を生 status から判定する | 推論が走ったかを知っているのは gateway だけ (§5.1) | gateway を通らないセッションを扱うとき (推論の有無を外からしか見られない別 harness) |
| `claude agents` の subprocess を残す | `sessions/` の監視で同じ集合が得られる。5 秒ごとの子プロセス起動が M3 に当たる | harness が `sessions/` に書かない状態が必要になり、ファイル監視では同じ集合が得られなくなったとき |
| topic ごとに push 抑制を書く | M5。抑制のある topic とない topic が生まれる | 1 つの topic だけが桁違いの流量を持ち、共通の抑制では追いつかなくなったとき |
| mesh 用の転送 op を新設する | 封筒 3 フィールドで足りる。op が面ごとに二重定義になる | 封筒 3 フィールドで運べない転送が要るとき (経路の明示が要る多段中継) |
| 転送された op を転送元の認可で信じる | 侵害された instance が cluster 全体の認可を無効化できる (§7.3) | instance 間の信頼が cluster 単位で確立されたとき (相互 attestation)、転送元の認可がこちらでも意味を持つ |
| instance を lazy 起動する | 寝ている instance と落ちている instance を mesh から区別できず、mesh の相手には起こす手段がない (§8.4) | mesh 側から instance を起こす手段が持てたとき (寝ている instance と落ちている instance が相手から別物になる) |
| config を無再起動で反映する | 反映のための監視・再読込・再配線が増える。再起動が安い (§8.2) | 再起動が安くなくなったとき (config 変更をまたいで保ちたい in-memory 状態ができる) |
| 壊れた config で機能を無効にして起動を続ける | 設定ミスが実行時まで持ち越される (§8.3) | config の一部の破損で instance 全体が起動不能になり、可用性の損失が持ち越しより重くなったとき |
| `~/.claude*` を走査して config home を見つける | M6。instance の境界が実行環境に依存して揺れる | 利用者が config home を明示する手段を持たない環境を対象にするとき (他者が用意した環境) |
| 派生値をディスクにキャッシュする | M4。再構成できるものを永続化すると整合の手順が生まれる | 再構成のコストが起動時間に出る規模になったとき (セッション数が桁で増える) |

## 11. テスト方針

### 11.1 契約の fixture を共有する

protocol リポが持つ「実 wire の JSON が schema を通る」fixture を、daemon のテストも読む。契約は `@ccmsg/protocol/fixtures` から op ごとの `{request, response}` (`OP_FIXTURES`)、topic ごとの frame (`TOPIC_FIXTURES`)、それらが名乗る id と時刻 (`FIXTURE_IDS` / `FIXTURE_NOW`) を export する。

- daemon に投げる request frame は `OP_FIXTURES[op].request` を起点にする。daemon の都合で差し替えるのは、その値が daemon の判断対象そのものである場合だけ (例: 宛先を dispatch に決めさせる sweep では `to_instance` を落とす)
- daemon が返す frame (op の response、topic の snapshot / event) は契約の schema に通す。期待値の JSON を daemon 側に書き写さない (写すと契約が 2 箇所になる)
- テストが名乗る session / instance / endpoint は `FIXTURE_IDS` を使う。daemon が組み立てた frame と契約が述べる frame が同じ id を指す

### 11.2 認可境界は必ず直接テストする

旧 daemon で認可境界を持つ 3 モジュールがテストから 1 度も import されていなかった。
v2 は境界を持つ経路に**その経路を直接呼ぶテスト**を置く。e2e で覆われているから省く、をしない。

- §3.2 の 1〜6 の各段が、それぞれ単独で正しいコードを返す
- 属性表の全 op について、`roles` 外の role が `forbidden` になる (表を走査して自動生成)
- `scope: "role"` の 3 op で、role による可視範囲の差が実際に出る
- ファイルアクセスの containment (contained / workspace / external の各面)
- 配信先の絞り込み (user 限定の topic が session role に流れない)
- 転送された op が転送先でも認可される (§7.3)
- credential が登録先の endpoint でだけ通る (別 origin / 別パス prefix の instance では拒否、§3.7)

### 11.3 「増やさない」を壊す変更を検出する

§1.1 の M1〜M6 は文章で禁じても止まらないので、テストで固定する。

| 対象 | テスト |
|---|---|
| M1 | 属性表の全 op が dispatch を通ること (実装側に role 比較が無いことを、表の走査で確認) |
| M2 | 契約の topic の値を返す op が存在しないこと |
| M3 | 周期タイマーの一覧と、それぞれに根拠のコメントがあること |
| M4 | 起動 → 停止 → 起動で、§3.6 の 5 種と要求に応じた dumps 以外のファイルが増えていないこと |
| M5 | push 抑制の実装が 1 つであること (topic の仕組みを経由しない push が無いこと) |
| M6 | 自 config home 以外を読まないこと (別 config home を置いて、走査されないことを確認) |

### 11.4 配送

配送は「届いたか」を状態として持つので、状態遷移をテストで固定する。

- 経路 (a) が使えない各条件 (flag 無効 / socket 不在 / key を読めない / 世代違い / ack 期限切れ)
  で (b) に落ち、配送の結果が同じであること
- (a) で drop された時、inbox に残り `throttled` が返り、backoff の後に再送されること (§4.4)
- 配送できた時点で inbox から消えること。daemon を再起動しても未配送分が残ること (§4.3)
- 未配送の 6 理由が §4.2 の情報源だけから決まること (理由ごとに別経路を見ていないこと)

### 11.5 mesh

mesh-peer-auth §10 / mesh-self-identification §7 のテスト表をそのまま daemon 側で実施する
(PKI レイヤ / プロトコルレイヤ / 境界ケース / 状態の非残存)。加えて daemon 固有として:

- 転送のループ検出 (`hops` に自分がいる request が落ちる)
- instance 断絶中の `instance-local` op が `instance_unreachable` になり、復帰後に成功する
- 断絶した instance の分の全量が消えず、復帰時に置き換わり、保持窓を過ぎたら破棄される (§7.5)
- 到達しない peer がある状態で起動でき、その peer は dial 対象に残る (§7.1、DV-Q11)
- 同じ `peers` を配った 2 instance が、それぞれ自分の endpoint に確定する (§7.1)
- 一致 0 (`peers` に自分が居ない) / 一致 2 以上 (同じ instance に届く URL が 2 つ) で起動失敗する (§7.1)
- 別の endpoint に束縛済みの id を名乗る hello が、新しく来た側を close する (§7.1)

## 12. 確定した判断

統括裁定 (2026-09-08)。本文の該当節はこの形で書かれている。

| # | 論点 | 判断 | 参照 |
|---|---|---|---|
| DV-Q1 | 配送経路 | **(a) 直送を優先し、(b) topic `inbox` へフォールバック**。(a) は実機確認まで feature flag で無効 | §4.1 |
| DV-Q2 | (a) で drop された時 | **配送済みにせず inbox に残し、backoff で再送**。応答は `delivered: false, reason: "throttled"` | §4.4 |
| DV-Q3 | inbox の永続化 | **永続化する** (append-only の jsonl、配送で消し込み)。未配送の本文は派生では復元できない | §4.3 / §3.6 |
| DV-Q4 | 保持期限と件数上限の根拠 | **契約側に書く**。daemon は契約の値を参照するだけ | §4.3 |
| DV-Q5 | Busy / Idle の判定元 | **gateway の request / response イベントが正**。生 status は `waiting` (dialog) とプロセスの存在にだけ使う | §5.1 |
| DV-Q6 | `claude agents` の poll | **置換する**。自 config home の `sessions/` を監視 + 低頻度の確認 poll で読み、subprocess は持たない | §5.1 |
| DV-Q7 | transcript の fold | **1 本** (M5)。軽 / 重の 2 段は持たない | §3.3 |
| DV-Q8 | config の反映 | **起動時 1 回に統一**。無再起動反映は持たない | §8.2 |
| DV-Q9 | 壊れた config | **起動失敗** (fail-fast、endpoint の確定に失敗した時と同じ扱い) | §8.3 |
| DV-Q10 | 起動タイミング | **常駐** (`ccmsg daemon supervise` が面倒を見て、`ccmsg service register` が OS に登録する)。lazy 起動は採らない | §8.4 |
| DV-Q11 | 到達しない peer | **起動を止めない**。答えなかった peer は一致数の計算から外して記録し、dial 対象に残す。起動失敗は一致 0 / 2 以上に限る | §7.1 |
| DV-Q12 | 断絶 instance の全量 | **再接続まで保持し、7 日で破棄** (inbox / last_live と同じ窓) | §7.5 |

### 12.1 契約側に入った変更

DV-Q2 / DV-Q4 は契約の変更を伴い、統括が protocol v2 設計に反映済み: `throttled` が未配送理由に
加わり、7 日 / 256 件に根拠 (last_live の保持窓と同じ / Claude Code 側の受信 queue 上限との対称) が
付いた。daemon はこの値を参照するだけで、自分では決めない (§4.3)。
