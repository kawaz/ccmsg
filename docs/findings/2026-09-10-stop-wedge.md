# 停止 wedge の再現と停止時間 (2026-09-10)

`service stop` / `daemon restart --all` が、instance が `stopping` を書いた後に終了しない現象について、本番同型の構成で測った結果。

## 何を測ったか

instance 3 つを **別 subprocess** (`daemon run <config home>`、config home と `XDG_*` は tmp、entry port はエフェメラル) で立て、3 つで mesh を張り、購読者を足した状態で 1 つに `instance_shutdown` を送って終了までの実時間を測る。dial した側 / accept した側の両方を対象にした (daemon.log の `dialled_by_us` で選別)。

購読者の構成は 3 種類:

- なし
- WS 購読者 1 (人 role、実際の登録フローで取った access token)
- WS 1 + UDS 1 + transcript tail 1 (announce した transcript に追記し、delta の受信を確認してから停止)

修正前 = listener 期限と監督者 escalation を入れる前、修正後 = 入れた後。各条件 3 回、計 36 回。Bun 1.3.13 / macOS 26.5 (Darwin 25.5.0)。

## 結果

| 版 | mesh 側 | 購読者 | 平均停止時間 | 固まり |
|---|---|---|---:|---:|
| 前 | dial | なし | 0.261 s | 0/3 |
| 前 | dial | WS | 0.259 s | 0/3 |
| 前 | dial | WS+UDS+tail | 0.260 s | 0/3 |
| 前 | accept | なし | 0.259 s | 0/3 |
| 前 | accept | WS | 0.259 s | 0/3 |
| 前 | accept | WS+UDS+tail | 0.260 s | 0/3 |
| 後 | dial | なし | 0.512 s | 0/3 |
| 後 | dial | WS | 0.511 s | 0/3 |
| 後 | dial | WS+UDS+tail | 0.512 s | 0/3 |
| 後 | accept | なし | 0.512 s | 0/3 |
| 後 | accept | WS | 0.510 s | 0/3 |
| 後 | accept | WS+UDS+tail | 0.516 s | 0/3 |

**instance 単体に `instance_shutdown` を送る経路では、修正前でも固まりは再現しなかった。** よって残 handle の特定はできていない (固まったケースが 1 件も無いので、計装しても見るものが無い)。issue が記録している本番の固まりは、この経路の外 — 監督者を介した停止、または長時間動いた instance の状態 — にあることになる。

固まりの再現には至らなかったので、実装側で対処したのは「固まった時に何秒で諦めるか」であって「固まらなくする」ではない。

## 停止時間が倍になっていた件

修正後の 0.51 s は、served な listener を 1 つずつ閉じていたことによる 250 ms の足し算だった。instance は entry と mesh で listener を 2 つ持つ。UDS 以外の listener の間には順序が無いので並行に閉じるようにして、3 instance mesh の supervisor stop は **0.51 s → 0.26 s** になった (`test/daemon.test.ts` の 3 instance e2e で計測、3 回とも 260-262 ms)。

## Bun 1.3.13 の実測

| 対象 | `stop(true)` の戻り |
|---|---|
| `Bun.listen` (UDS) | 同期。`undefined` を返し、待つものが無い |
| `Bun.serve` (WS) | Promise。自分で `ws.close()` を呼んだ後は settle しない (address は 1 ms 以内に解放済み) |

前者を `Promise.race` に渡しても即 resolve するだけなので、UDS 側の期限は意味が無く、型 (`void`) とも食い違っていた。WS 側の 250 ms だけが実効。

## 未検証

- 本番の固まりそのもの (再現していない)
- `service stop` から launchd を経由する経路の実測 (fake `launchctl` によるテストのみ)
- systemd 側 (Linux ホストでの実行なし)
- Bun 1.3.13 以外
- 長時間稼働した instance、業務規模の transcript / 購読者数
