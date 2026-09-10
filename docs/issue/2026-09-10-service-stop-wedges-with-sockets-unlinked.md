---
title: service stop が socket unlink 後に wedge し、応答と実態が乖離する
status: open
category: bug
created: 2026-09-10T16:21:32+09:00
last_read:
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
