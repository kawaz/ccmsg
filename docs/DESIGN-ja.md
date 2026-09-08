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

## 2. 前提

| # | 条件 | 満たさない場合 |
|---|---|---|
| A1 | wire の契約 (型・op 属性表・topic 属性表・検証器) は protocol リポが正本 | daemon が自分で検証を書き、webui と解釈がずれる (旧 daemon の状態) |
| A2 | instance = 1 config home。daemon プロセスは instance と 1 対 1 | どの config home のセッションを答えているかが不定になる |
| A3 | ランタイムは Bun。UDS・子プロセス・ファイル監視は Bun の API を使う | 起動・配布 (単一バイナリ) の前提が変わる |
| A4 | daemon とセッションと webui の利用者は単一 uid。権限分離はしない | UDS の 0600 と config home の 0600 key が境界にならず、認可を作り直す必要がある |
| A5 | mesh の相手は §7 の認証を通した instance だけで、認証境界 (uid / config home) をまたがない | mesh 越しに来た op を自 instance の権限で実行してよい根拠が消える |

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
| 入口の許可 | source IP の allowlist、Origin の許可集合、WS の entry token、mesh 相手の TLS |
| identity の確定 | `hello` の結果として接続に role と (session なら) sid を束縛する |

entry token は state ディレクトリの `entry.token` (0600、初回起動時に生成) であり、
WS の upgrade 時に `Sec-WebSocket-Protocol: ccmsg.token.<token>` か query `?token=` で提示する
(ブラウザは handshake に header を付けられないため subprotocol 経路が要る)。合致しなければ
upgrade を 401 で拒否する。**これは A4 の言い換えである**: 境界は uid とファイル権限であって
daemon の中ではなく、この token file の 0600 がその境界そのものになる。UDS は到達すること自体が
ディレクトリの権限を通ることなので token を要さない。

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
(`transcript_read` / `dir_list` / `file_read`) だけは、可否ではなく可視範囲が変わるので、
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

書くのは 4 種類だけにする。

| 対象 | 理由 |
|---|---|
| `last_live` (前回稼働中のセッション) | 再起動で失うと、一覧から Paused / Disappeared の行が消える |
| ログ | 落ちた原因を後から読むため。exit 直前の行を落とさない writer を 1 つ持つ |
| inbox (未配送メッセージ) | 他のどこからも再構成できない状態 (§4.3) |
| kv (`kv_write` で保存された値) | 人が保存した値そのもの。派生値ではなく、client 側の複製は写しでしかない |

inbox と kv は M4 の例外ではなく、M4 の対象外である。M4 が禁じるのは**派生値**の永続化であり、
未配送メッセージは派生値ではない。送信側の `message_send` は既に応答を返して終わっており、
transcript にも upstream にも「まだ届いていない本文」はどこにも無い。daemon が失えば
本文ごと消える。kv も同じ理屈で、テーマ等の保存値は daemon が失えばユーザの設定ごと消える
(契約 kv.ts が instance 間ミラーと `updated_at` による決着を前提にしているのも、値が
プロセスより長く生きることを前提にしているため)。

room jsonl は無い (契約 §2.1 で会話ログの正本は transcript)。sandbox grant・購読状態・
fold の途中結果・config dir の一覧はいずれも再構成できるので書かない (M4)。
pid / socket / lock は資源ハンドルであって状態ではない。**mesh の署名鍵も書かない**:
接続 1 本ごとに生成して ack で捨てるエフェメラル鍵であり (mesh-peer-auth §7)、
メモリ上にしか存在しない。state dir に置くと保存場所と復旧手順という管理対象が生まれ、
§1.1 に反する。

## 4. 配送

契約の `message_send` は「宛先 sid に届ける」だけを約束し、届かなかった場合は理由を返す。
daemon 側の実装はその 2 つ (配送手段と、届かない理由の判定) に分かれる。

### 4.1 配送手段の 2 経路

| 経路 | 内容 | 前提 |
|---|---|---|
| (a) Claude Code の messaging socket へ直接 | `sessions/<pid>.json` の `messagingSocketPath` に connect し、config home の 0600 key の `peerToken` で認証してから user frame を書く | 非公式プロトコル。`peerProtocol` の世代一致 |
| (b) topic `inbox` の delta として push | セッション側の購読 (subscribe を張っている常駐) 経由で届ける | セッションが購読していること |

**(a) を優先し、失敗したら (b) にフォールバックする** (DV-Q1)。理由は 2 つ。

- (a) は**受信側が ccmsg の常駐を持っていなくても届く**。「まだ subscribe を張っていない
  セッションには届かない」という穴 (旧 daemon が 3 分の巻き戻し窓で塞いでいたもの) が、
  時間窓ではなく経路の性質として消える
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

### 4.4 (a) で drop された時

受信側は流量制御 (token bucket / 重複判定 / queue 上限) を持ち、受理せずに drop することがある。
**drop されたものを配送済みにしない** (DV-Q2)。inbox に残したまま再提示の機会を待ち、
送信側には `delivered: false, reason: "throttled"` を返す。

理由: drop は「宛先が今は受け取れない」であって「届いた」でも「宛先が居ない」でもない。
配送済みにすると本文が失われ、`session_not_found` にすると宛先が居ないことになる。inbox に
残して再送すれば、§4.2 の他の未配送状態と同じ扱い (受け取れるようになったら出る) に揃う。

`throttled` は契約が定める理由であって、daemon が独自に足すものではない。daemon は契約の理由を返すだけで、
理由の集合を daemon 側で拡張しない。再提示の契機は §4.3 の「出す条件」そのもの (同じ sid への次の
`message_send` が (a) で通った / `inbox` を購読した / セッションが live に戻った) であって、時間ではない。
周期タイマーで再送しない (M3 — 相手の token bucket の回復速度は一次資料に無く、間隔を勘で決められない)。
古い順に 1 通ずつ出し、最初に通らなかったところで止める。通らなかった残りは inbox に順序のまま残る。

## 5. セッションの状態モデル

一覧の分類 (Pinned / Waiting / 生存 / 管理外 / Paused / Disappeared) は **daemon が導く**。
webui が生の値を組み合わせて分類すると、instance ごとに解釈がずれる。

### 5.1 入力

| 入力 | 何が分かるか | 取り方 |
|---|---|---|
| 接続 | ccmsg と話しているか、いつ話したか | transport (イベント) |
| `sessions/` の各 `<pid>.json` | **セッションの存在**と `waiting` (dialog)、messaging socket | 自 config home のみ (M6)。**判定が要る時にその場で読む** |
| llm-gateway の request / response | **実際に推論が走っているか** (= 忙しさ) | webhook (push) |
| `last_live` + `stopped_at` | 前回稼働中・意図して止めた | 自分が書いたファイル |
| transcript の fold | API error で止まっているか、最後の人間入力 | tail |

**分類の入力は購読に依存しない**。`sessions/` を「読むこと」と「監視すること」は別物で、
§6.3 が購読に従属させるのは後者だけ。どのセッションが存在するかは instance 自身の事実
なので、判定が要る瞬間 (message_send の宛先判定 / last_live の記録 / classify) には
その場でディレクトリを読む。監視と poll は「変化を購読者へ push する」ための資源であって、
答えの取得経路ではない。混同すると、誰も購読していない間は生きているセッションが
`session_not_found` になり、生きたままのセッションが last_live へ「消えた」と書かれる。

**`claude agents` の subprocess は持たない** (DV-Q6)。自 config home の `sessions/` を
監視すれば同じ集合が得られるので、5 秒ごとの子プロセス起動が丸ごと消える (M3)。
ファイル監視は取りこぼしうるので、低頻度の確認 poll を**併走**させる — これは旧 daemon が
transcript tail で実測を根拠に採った形と同じで、間隔の根拠は「監視が落とした変化を、
利用者が気づく前に拾う」であって、取得の主経路ではない。

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

「Busy と Idle を分けない」(issue session-list-sections) ので、**生存の中の忙しさは
分類ではなく行の属性**として出す。忙しさは gateway のイベントから導き (§5.1)、
並び順は最終活動時刻。分類の側は忙しさを見ないので、gateway が設定されていない instance でも
セクション構成は成立する (行の属性が 1 つ欠けるだけ)。

### 5.3 「最終活動時刻」の 2 種

旧 daemon は「ccmsg リクエストのたび更新される時刻」(エージェントの忙しさ) と
「人間が入力した時刻」(並び順) の 2 つを別の場所に持っていた。v2 は**用途が違う 2 つの値
であることを型で明示**し、どちらを並びに使うかを 1 箇所で決める。同じ名前で 2 つ持たない。

## 6. topic の実装

契約は「`topic_subscribe` の直後に `snapshot: true` の frame が 1 回、以後は同型の delta」
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
| instance ごとの全量置換 | `peers` / `agents` / `session_errors` / `llm_requests` / `llm_status` |
| 全量置換 | `session_status:<sid>` |
| 要素の追加・更新 | `inbox` / `kv:<ns>` |
| 追記 (byte offset) | `transcript:<sid>` |
| event (値を保持しない) | `notify` |

**抑制がかかるのは全量置換の 2 粒度だけ** (`whole` / `per_instance_whole`)。同じ全量を
もう一度送っても購読側は既に持っている値を持ち続けるので、送る意味が無い。

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

## 7. mesh

### 7.1 自己識別

起動時に `self` (自分の endpoint URL) を確定する。mesh-self-identification の手順 (全 peer に
token 付き probe を送り、自分に届いた token を照合)。**自分宛の probe を省略しない** (省略すると
「一致 2 個以上で落ちる」性質が失われる)。

mesh-self-identification の前提 Q3 (起動時に全 peer へ到達できる) は、ccmsg の運用
(片方の PC が電源断・スリープ中) では常態的に満たされない。**到達しなかった peer を
一致数の計算から外し、起動失敗は一致 0 個 / 2 個以上に限る**緩和を採る (DV-Q11)。

同文書 §4.2 の安全性 (悪意ある正規ピアによる誤認が一致 2 個以上で不成立に終わる) は
「自分宛の probe は必ず自分に届く」にしか依存しないので、この緩和で崩れない。
到達しなかった peer は §7.2 の dial 対象として残る。

### 7.2 dial と glare

- 各 instance は全 peer に対等に dial する (dial 責務を片側に割り当てない)
- 認証は mesh-peer-auth。`role: "instance"` の `hello` が起点で、C2 で鍵と challenge を交換し、
  C1 で proof を返す。ack を受けるまでメッセージを送らない
- glare (2 本張られた) は両方を検証したうえで、`iss` 文字列の小さい側が dial した接続を残す
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

「対象の担当 instance」の決め方: sid → 担当 instance の対応は `peers` topic が持っている。
知らない sid は「cluster のどこにもない」= `session_not_found`。ただし到達不能な instance が
ある間は判定を保留する (§4.2)。

### 7.4 event の relay

instance A に繋いだ購読者が cluster 全体を見るために、A は各 peer の同じ topic を購読し、
受けた frame の `instance` を保ったまま自分の購読者へ流す。A は中身を再計算しない
(再計算すると発生元と A の 2 箇所に同じ判定が生まれる)。

### 7.5 instance の断絶

- その instance のセッションは **Disappeared の一種**として扱う (issue multi-host-cluster 7)。
  復帰時に戻る
- 断絶中の `instance-local` op は `instance_unreachable`
- 断絶は `hello` の応答に含まれる `instances[]` の `reachable` と、`peers` topic に現れる
- `peers` frame の `instances` が同じ一覧を運ぶので、購読者は挨拶し直さずに link の切断を知る
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
| peers | mesh の endpoint URL 一覧。**全 instance に同じものを配れる** (自分の URL を書かない、§7.1) |
| 入口の許可 | bind、source IP、Origin |
| upstream | gateway の URL と webhook source、terminal gateway、launcher (root と テンプレ)、translate helper、sandbox origin |

**config は起動時に 1 回だけ読む。無再起動での反映は持たない** (DV-Q8)。instance ごとの
config は小さく、再起動が安い (状態のほとんどが揮発で、永続化するのは §3.6 の 3 種だけ) ので、
「編集が次のリクエストから効く」ための mtime 監視・再読込・再配線を持つ理由がない。
config を変えたら instance を再起動する、が唯一の反映手順になる。

### 8.3 起動の順序

1. パス解決と state dir の作成
2. 単一インスタンスの取得 (ロック)。先客がいれば何もせず終了
3. config 読み込み。**壊れていたら起動失敗** (DV-Q9)。機能を無効にして起動を続けると、
   「設定したはずの機能が黙って効いていない」状態が実行時まで持ち越される。§7.1 の
   自己識別の失敗と同じく、設定ミスは起動時に落とす
4. `last_live` の読み込み
5. `self` の確定 (§7.1)。確定できなければ起動失敗 (mesh を持つ構成の場合)
6. listen (UDS → HTTP/WS)。pid の記録は listen より前。UDS が実際に bind するのは
   `daemon.<pid>.sock` で、クライアントが使う安定 path `daemon.sock` は accept 開始後に
   symlink を一時名で作って rename し、atomic に差し替える (§8.5)。listen の前に、
   実 path のうち pid が既に死んでいるものを掃除する (ロックの引き継ぎと同じ判定)
7. peers への dial (§7.2)

**upstream の監視 (transcript tail / `sessions/` / gateway) は起動時に始めない。** 購読が
資源のライフサイクルの駆動源 (§6.3) なので、最初の購読で始まる。

### 8.4 instance は常駐する

**lazy 起動 (その config home のセッションが最初に `ccmsg` を呼んだ時に起動する) は採らない**
(DV-Q10)。instance は常駐し、`ccmsg plugin install` が起動を登録する。

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
5. 資源を手放す。**UDS を最後に閉じる** — クライアントは「UDS に繋がらない」を退去完了として
   観測するので、後継と競合しうる資源 (HTTP listener / pid / ロック) を全部手放してから閉じる。
   閉じることで消えるのは自分が bind した `daemon.<pid>.sock` だけで、安定 path の symlink は
   触らない (後継が既に自分へ付け替えているかもしれない。自分を指したままの dangling symlink は
   「UDS に繋がらない」= 退去完了の観測として本項の意味論どおり)

listen した path が stop で unlink されるのは Bun の挙動 (1.3.13 実測)。実 path と安定 path を
分けるのは、退去する instance が後継の受け取った address を消さないためである。

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

## 10. 不採用

| 案 | 不採用の理由 |
|---|---|
| op ハンドラごとに role / capability を検査する | M1 そのもの。属性表と分岐の 2 表現になり、片方だけ変わる |
| 観測系に one-shot 取得 op を残す (CLI の往復を減らす) | M2。往復 1→3 の増加より、同じ値の 2 経路目のほうが高くつく |
| 未配送を時間窓の巻き戻しで救う | 配送保証の穴を時間で塞ぐ形。inbox は「届いたか」を状態として持つので窓が要らない |
| 配送を (b) だけにする | 受信側が購読を張るまでの穴が残り、時間窓が復活する |
| 配送を (a) だけにする | 非公式プロトコルの世代変更で配送が全滅する |
| (a) で drop されたものを配送済みにする | 本文が失われる。drop は「今は受け取れない」であって「届いた」ではない (§4.4) |
| inbox を揮発にする | 未配送の本文はどこからも再構成できない。daemon の再起動で消える (§3.6) |
| Busy / Idle を生 status から判定する | 推論が走ったかを知っているのは gateway だけ (§5.1) |
| `claude agents` の subprocess を残す | `sessions/` の監視で同じ集合が得られる。5 秒ごとの子プロセス起動が M3 に当たる |
| topic ごとに push 抑制を書く | M5。抑制のある topic とない topic が生まれる |
| mesh 用の転送 op を新設する | 封筒 3 フィールドで足りる。op が面ごとに二重定義になる |
| 転送された op を転送元の認可で信じる | 侵害された instance が cluster 全体の認可を無効化できる (§7.3) |
| instance を lazy 起動する | 寝ている instance と落ちている instance を mesh から区別できず、mesh の相手には起こす手段がない (§8.4) |
| config を無再起動で反映する | 反映のための監視・再読込・再配線が増える。再起動が安い (§8.2) |
| 壊れた config で機能を無効にして起動を続ける | 設定ミスが実行時まで持ち越される (§8.3) |
| `~/.claude*` を走査して config home を見つける | M6。instance の境界が実行環境に依存して揺れる |
| 派生値をディスクにキャッシュする | M4。再構成できるものを永続化すると整合の手順が生まれる |

## 11. テスト方針

### 11.1 契約の fixture を共有する

protocol リポが持つ「実 wire の JSON が schema を通る」fixture を、daemon のテストも読む。
daemon が返す frame をその fixture と同じ検証器に通すことで、**契約違反が daemon のテストでも
落ちる**。daemon 側に期待値の JSON を書き写さない (写すと契約が 2 箇所になる)。

### 11.2 認可境界は必ず直接テストする

旧 daemon で認可境界を持つ 3 モジュールがテストから 1 度も import されていなかった。
v2 は境界を持つ経路に**その経路を直接呼ぶテスト**を置く。e2e で覆われているから省く、をしない。

- §3.2 の 1〜6 の各段が、それぞれ単独で正しいコードを返す
- 属性表の全 op について、`roles` 外の role が `forbidden` になる (表を走査して自動生成)
- `scope: "role"` の 3 op で、role による可視範囲の差が実際に出る
- ファイルアクセスの containment (contained / workspace / external の各面)
- 配信先の絞り込み (user 限定の topic が session role に流れない)
- 転送された op が転送先でも認可される (§7.3)

### 11.3 「増やさない」を壊す変更を検出する

§1.1 の M1〜M6 は文章で禁じても止まらないので、テストで固定する。

| 対象 | テスト |
|---|---|
| M1 | 属性表の全 op が dispatch を通ること (実装側に role 比較が無いことを、表の走査で確認) |
| M2 | 契約の topic の値を返す op が存在しないこと |
| M3 | 周期タイマーの一覧と、それぞれに根拠のコメントがあること |
| M4 | 起動 → 停止 → 起動で、§3.6 の 3 種以外のファイルが増えていないこと |
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
- 到達しない peer がある状態で起動でき、`self` が確定する (§7.1 の緩和)

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
| DV-Q9 | 壊れた config | **起動失敗** (fail-fast、自己識別の失敗と同じ扱い) | §8.3 |
| DV-Q10 | 起動タイミング | **常駐** (`ccmsg plugin install` 時に起動登録)。lazy 起動は採らない | §8.4 |
| DV-Q11 | 自己識別の緩和 | **採る** (到達しない peer は一致数から外す。起動失敗は一致 0 / 2 以上のみ) | §7.1 |
| DV-Q12 | 断絶 instance の全量 | **再接続まで保持し、7 日で破棄** (inbox / last_live と同じ窓) | §7.5 |

### 12.1 契約側に入った変更

DV-Q2 / DV-Q4 は契約の変更を伴い、統括が protocol v2 設計に反映済み: `throttled` が未配送理由に
加わり、7 日 / 256 件に根拠 (last_live の保持窓と同じ / Claude Code 側の受信 queue 上限との対称) が
付いた。daemon はこの値を参照するだけで、自分では決めない (§4.3)。
