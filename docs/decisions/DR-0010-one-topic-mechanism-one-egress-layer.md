# DR-0010: topic は 1 つの仕組みで、送出は終端ごとに 1 層

Status: Accepted (2026-09-10。kawaz 指示 (2026-09-10)。本番の storm 事故を受けた再発防止)
Date: 2026-09-10
Sponsor: kawaz 指示 (2026-09-10)「各 WS 終端の送出側に rate limit 層を入れる」
関連: 設計 §6.1〜§6.4 (topic)、§1.1 (M5)、[DR-0011](DR-0011-peers-is-a-topic-of-rows.md)、issue archive `2026-09-10-ws-egress-rate-limit-per-peer`、findings `2026-09-10-sessions-topic-storm`

## 1. 背景

旧 daemon で push の抑止 (前回と同じ値なら送らない) を持っていたのは topic 相当の 3 箇所だけで、しかもそれぞれ別実装だった。抑止を持つ topic と持たない topic が生まれる。

2026-09-10 の本番で、bare instance が `agents` / `peers` を ~1 kHz で publish し (0.92 秒で 882 frame)、mesh 経由で全 instance → webui に fan-out して一覧が振動し UI が停止した。抑止は「前回と同じ値」しか止められず、**毎回変わる値が高頻度で述べられる**と全部が frame になる。

## 2. 決定

### 2.1 抑止は topic の仕組み自体に組み込む (M5)

topic 1 つが持つのは「現在値 / 購読者 / 更新の入口 / 抑止」で、抑止は **全 topic が共有する 1 実装**。「この topic には抑止が無い」が起こりえない形にする。

どこに抑止が効くかは **契約の粒度 (`TOPIC_ATTRIBUTES`) を読んで決める**。値を置き換える粒度 (`whole` / `per_instance_whole`) にだけ効く — 同じ全体をもう一度送っても、購読者は既に持っているものを持ち続けるだけで、送る中身が無い。

差分と event (`element` / `append` / `event`) は素通し。同じ中身の frame 2 つは重複ではなく **2 度起きたこと**である (inbox の message をもう一度差し出すのは、最初に聞いていなかった相手に届く 1 度きりの機会であり、`kv` の entry を述べ直すこと自体が操作である)。

### 2.2 送出は終端ごとに 1 つのキューを通る

**人の接続も mesh peer も CLI の購読者も同じ 1 層**で、経路で分けない。relay が受け取った frame も同じ publish を通るので、同じ層に乗る。

| 粒度 | 扱い |
|---|---|
| `whole` / `per_instance_whole` | **畳む。** `topic × instance` を鍵に、待っている frame を最新値で置き換える |
| `element` / `append` / `event` | **畳まない。** 上がった順に並べ、キューの上限を超えたら上げた側へ突き返す |

畳まれた値とその隣の出来事は **同じ flush で、キューに入った順に**出る。畳まれた値は最初に述べられた時の位置を保ち、中身だけが進むので、周りの出来事を追い越しも遅れもしない。

### 2.3 上限を超えたら黙って捨てず、生産側へ突き返す

`publish` が `rate_limited` を返す。

- `notify.send` / `say.post`: op が `rate_limited` を返す。引数は正しく何も失敗していないので、送り手に読み直すものは無い。読み手が追いついてから同じ呼び出しをやり直せば通る
- `message.send` の inbox 経路: 既存の `throttled` として扱い、inbox に保持して後で差し出す (DR-0008)。message は失われない
- `transcript:<sid>` の追記: frame が `start` / `size` を運ぶので、購読者は隙間を見て `transcript.read` で読み戻せる

### 2.4 flush の周期は周期タイマーではない

タイマーは **待たされる frame が出た時だけ** one-shot で arm され、暇な終端は 1 つも持たない。前回の flush から周期が過ぎていれば frame はその場で出るので、単発の変化が遅れることはない (M3 の対象外)。

| 値 | 決めること | 理由 |
|---|---|---|
| `FLUSH_PERIOD_MS` = 100ms | 1 つの終端に frame が出る頻度の上限 | 読み手にとって: 表示の再描画より近い frame は誰にも見えず、待ちは 1/4 秒あたりから遅延として読まれ始める。cluster にとって: relay された frame は hop ごとに 1 度待つので遅延は 100ms × hop 数。2 hop でも人が即時と読む範囲に収まる |
| `QUEUE_LIMIT` = 256 | 畳めない frame を 1 終端が同時に持てる数 | 畳める frame に上限は要らない (何度述べられても 1 entry)。256 は終端が 100ms ごとに掃ける量なので、到達するとは毎秒 2500 frame 超が続くということで、人もセッションも peer も出さない量 = この層が存在する理由である storm の側 |

## 3. 不採用

| 案 | 理由 | 見直す条件 |
|---|---|---|
| topic ごとに push の抑止を書く | M5。抑止を持つ topic と持たない topic ができる | 1 つの topic が他より桁違いの流量を持ち、共有の抑止が追いつかなくなったとき |
| 上限超過の frame を黙って捨てる | 送り手も受け手も、何が落ちたかを知る手段を持たない | — |
| 経路 (人 / mesh / CLI) ごとに送出層を分ける | 同じ技法の実装が複数になる (M5)。storm は経路を選ばない | — |
| 全 frame を周期タイマーで掃く | 暇な終端がタイマーを持ち、単発の変化が必ず遅れる | — |

## 4. 影響

- 設計 §6.1〜§6.4。実装は `src/topics/egress.ts` (`Topics.publish` は必ずここを通る)
- 契約の `rate_limited` code は契約リポの issue が追う
