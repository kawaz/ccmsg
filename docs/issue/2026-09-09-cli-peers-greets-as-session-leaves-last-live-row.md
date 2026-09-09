---
title: ccmsg peers が session として名乗ると、切断後に last_live へ行が残りうる
status: open
category: bug
created: 2026-09-09T16:28:05+09:00
last_read:
open_entered: 2026-09-09T16:28:05+09:00
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

# ccmsg peers が session として名乗ると、切断後に last_live へ行が残りうる

## 概要

`ccmsg peers` は `CLAUDE_CODE_SESSION_ID` (or `--sid`) があると role session で hello する (`src/cli.ts` の `peers`)。実在セッションの sid なら hello の field 単位 merge で実害は無いが、任意の `--sid` を渡した場合や、セッションの外で環境変数だけ残っている場合に、切断で `disappeared` 行が `last_live` に積まれる。本運用の `ccmsg peers` 出力に `sid: 00000000-0000-4000-8000-00000000c0de`、repo/ws/cwd 空、connected/last_seen が同時刻の行を観測 (2026-09-09 16:15 JST 頃、由来は手動テストと推定、未確認)。

## 背景

論点:

1. `peers` の目的は観測なので role user で足りるのでは (sid で名乗る理由は「自分を除いた一覧」か、statedMeta の更新か)。
2. 名乗る場合も、hello 直後に切る接続を「消えた」と数えない条件が状態モデル §5 にあるか。

裁定は契約 (`peers` topic の roles) と DESIGN-ja §5 を読んで決める。

## 受け入れ条件

- [ ] `peers` topic の契約における role の意図 (session vs user) を確認する
- [ ] DESIGN-ja §5 の状態モデルに、hello 直後切断を disappeared として扱わない条件があるか確認する
- [ ] 上記を踏まえて `peers` サブコマンドの hello role (または disappeared 計上条件) の裁定を下す
