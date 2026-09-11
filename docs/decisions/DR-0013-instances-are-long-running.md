# DR-0013: instance は常駐し、監督者が唯一の起動経路

Status: Accepted (2026-09-08 に常駐を裁定 (DV-Q10)。監督者と init system の分界は 2026-09-10 の実機確認で確定)
Date: 2026-09-10
Sponsor: 統括裁定 (2026-09-08、常駐)。`service register` の挙動は本番の観測 (2026-09-10)
関連: 設計 §8.4 (instance は常駐する)、§8.3 / §8.5 (起動と停止の順序)、[DR-0004](DR-0004-config-edited-and-applied.md)、[DR-0014](DR-0014-mesh-has-no-ops-of-its-own.md)、issue archive `2026-09-10-service-start-after-register-does-not-bootstrap`、issue `2026-09-11-daemon-restart-all-leaves-supervisor-on-old-build`

## 1. 背景

instance をいつ起こすかに 2 案あった。lazy 起動 (その config home のセッションが最初に `ccmsg` を呼んだ時に起こす) と常駐である。

## 2. 決定

### 2.1 instance は常駐する

lazy 起動は採らない。**理由は mesh が違いを言えないことにある。** lazy だと、dial できない instance が「寝ているだけ (呼べば起きる)」なのか「落ちている」なのかを外から区別できない。区別できないまま両方 `instance_unreachable` にすると、寝ている instance 宛の op は永久に失敗する — 起こせるのは同じホストのセッションだけで、mesh peer には起こす手段が無い。

常駐の代償は「使われていない config home の daemon も動き続ける」ことだが、購読が無ければ上流も監視しないので (§8.3)、接続を待つだけの状態で座っている。

### 2.2 常駐の面倒を見るのは 2 段の監督

- **`ccmsg daemon supervise`** — 前景の監督者。各 instance を子プロセスとして起こし、落ちたら上げ直す。再起動までの待ちは指数的に伸びる (起動で失敗する設定が監督者を回し続けてはならない)
- **`ccmsg service register`** — その監督者を launchd (macOS) / systemd --user (Linux) に登録する。ログアウトを越えて生き残るのはこの層の仕事

### 2.3 監督者が instance を起こす唯一の経路

`ccmsg daemon start / stop / restart / status` は監督者への **要求**であって、CLI は子を起こす自前の経路を持たない。別の経路で起こされた instance は「誰も上げ直さず、誰も知らない」ものになり、常駐が言っていることと食い違う。監督者が居なければ `{"error":{"code":"supervisor_not_running"}}` で失敗する。

要求は state に置いた制御 socket (`<state root>/supervise.sock`、0600) 上の JSON 行として運ばれ、op 名は `supervise_` を前置して契約のものと分ける — **これは契約ではない**。このホストのプロセスについての内部プロトコルで、webui も mesh peer も届かない。

例外は 2 つ。`ccmsg daemon run [dir]` は監督者の外での一度きりの前景起動 (`status` の外でもある)、`ccmsg daemon log` はファイルを直接読む (log は何かが死んだ後に読むものなので、監督者が生きていることを必要としてはならない)。

### 2.4 `restart --all` が入れ替えるのは子だけ

監督者自身は入れ替わらない。**新しい build へ載せ替えるのは `ccmsg service stop` → `start`** である。監督者と子の build が食い違った時にどう見せるか (再 exec するか、不一致を `status` に出すか) は未決で、issue `2026-09-11-daemon-restart-all-leaves-supervisor-on-old-build` が追う。

### 2.5 `service stop` は「止めて、止まったままにする」

launchd では **bootout** (unit file は残る)、systemd では `stop`。signal では駄目で、`KeepAlive` / `Restart=always` が上げ直してしまう。止めた上で unit file も取り去るのが `unregister`。`register` は unit を書いて start する所まで (= 登録は起動まで含む) に一本化する。

### 2.6 `service status` は 2 つの読みを並べる

ccmsg 自身の読み (registered / running) と **init system の読み** (loaded / running / pid / last exit) を並べる。「file は在るのに launchd は聞いたことがない」のような食い違いを、均して隠さず見せるため。

unit が名指すプログラムは **upgrade を越えて生きるパス**として登録する (`PATH` 上の `ccmsg` で、次の upgrade が取り去る runtime 固有の版付きパスではない)。`service status` はそのパスを unit から読み戻して出す (`program`: path / durable / exists) — プログラムが動いてしまった監督者は、他の全部の欄から見ると一度も起動されていないものと見分けがつかないため。

### 2.7 監督者の出力は config home に属さない

監督者はどの config home のものでもないので、出力は §8.1 の「config home から導く」の唯一の例外として `${XDG_STATE_HOME:-~/.local/state}/ccmsg/service.log` に行く (systemd では unit の出力は journal なので `ccmsg service log` はそちらを読む)。

## 3. 不採用

| 案 | 理由 | 見直す条件 |
|---|---|---|
| lazy 起動 (最初の呼び出しで起こす) | mesh から見て「寝ている」と「落ちている」が区別できず、mesh peer には起こす手段が無い | mesh 側から instance を起こす方法ができ、寝ていることと落ちていることが peer にとって別のものになったとき |
| CLI が自前で子を起こす | 誰も上げ直さず誰も知らない instance ができる | — |
| 監督者の制御経路を契約に載せる | ホストのプロセスについての話で、webui も mesh peer も関係しない | — |
| `service stop` を signal で行う | `KeepAlive` / `Restart=always` が上げ直す | — |
| unit に runtime 固有の版付きパスを書く | 次の upgrade がそのパスを取り去る | — |

## 4. 影響

- 設計 §8.3 / §8.4 / §8.5
