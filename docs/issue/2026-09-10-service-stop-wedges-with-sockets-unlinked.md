---
title: service stop が socket unlink 後に wedge し、応答と実態が乖離する
status: open
category: bug
created: 2026-09-10T16:21:32+09:00
last_read: 2026-09-10T18:21:21+09:00
open_entered: 2026-09-10T16:21:32+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: 自リポ TODO
---

# service stop が socket unlink 後に wedge し、応答と実態が乖離する

## 概要

本運用 (v0.2.13 監督者 + 3 instance、2026-09-10 16:19) で `ccmsg service stop` を打ったところ、監督者 (pid 59295) と 3 instance (38608/38617/38683) が停止処理に入って `supervise.sock` と各 `daemon.sock` を unlink したまま終了せず、launchd は state=running のまま (再起動されない)、CLI は `supervisor_not_running` / `instance_unreachable` で本運用が全断した。`service stop` の応答は `running: true` だった。

## 背景

復旧は 4 pid への SIGTERM (即終了) → launchd の KeepAlive で監督者が再起動、`service start` 不要だった。

疑い: 旧 issue `mesh-tls-trust-root` (archive) の補足にある Bun 1.3.13 の「サーバ側から `ws.close()` を呼ぶと `Bun.serve().stop()` が resolve しない」挙動 (`src/transport/ws.ts` の `serveWs.close()` は 250 ms の `Promise.race` で回避しているが、監督者 / instance の停止順序 §8.5 のどこかで同じ待ちが残る)。SIGTERM で即終了したので待ちは signal で解ける種類。

## 受け入れ条件

- [ ] 停止順序のどこで止まるかを使い捨て instance + 監督者で再現し特定 (mesh link を持つ 3 instance 構成で)
- [ ] socket の unlink は listener が実際に閉じた後に行う (unlink 済みで process が残ると「動いていない」と誤認される)
- [ ] `service stop` は監督者の終了 (pid 消失) を確認してから `running: false` を返し、期限内に終わらなければ SIGKILL にエスカレートして事実を返す
- [ ] テスト: 3 instance の mesh を張った状態で supervisor stop が N 秒内に完了する

## 追加観測 (2026-09-10 18:10, v0.3.1 → v0.3.2 の `daemon restart --all`)

instance 単体の stop でも再現した。emrd instance (pid 90012) の daemon.log は `mesh peer lost` ×2 → `stopping` を記録した後に終了せず、`daemon status --all` は `running: false` (socket は unlink 済み) を返し、`daemon restart --all` は 600 秒経っても返らなかった。pid 指定の SIGTERM で即終了し、監督者が新しい instance を起動して復旧。personal と bare は同じ操作で正常に止まった (mesh link の閉じ方 = 自分が dial した側か accept した側かで差がある可能性)。停止順序 §8.5 で `stopping` の後に待っているものを特定する。

## 手当て (v0.3.3、2026-09-10 21:28 本番反映)

listener close (entry + mesh 並行、UDS 最後、250 ms 上限) → pid/lock 解放の順序、監督者の graceful 10 s → SIGTERM 10 s → SIGKILL の escalation と各段の log、`service stop` = `launchctl bootout` (KeepAlive の再 spawn を止める) + pid 消失を 10 s 待って SIGKILL、テスト (fake child の escalation、3 subprocess mesh の e2e)。findings: [2026-09-10-stop-wedge](../findings/2026-09-10-stop-wedge.md)。**固まり自体は隔離環境 36 回で未再現** (原因未特定)。本番の載せ替え (v0.3.2 → v0.3.3、旧監督者を bootout) は 0.4 秒で完了した。次に固まった時は監督者 log の `stopping` 段階 (`asked` / `sigterm` / `sigkill` / `exited`、`in_ms`) を証拠にする。受け入れ条件の「どこで止まるかの特定」だけが残る。
