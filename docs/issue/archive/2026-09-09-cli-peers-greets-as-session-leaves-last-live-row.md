---
title: ccmsg peers が session として名乗ると、切断後に last_live へ行が残りうる
status: resolved
category: bug
created: 2026-09-09T16:28:05+09:00
last_read:
open_entered: 2026-09-09T16:28:05+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-09-10T13:49:10+09:00
discard_reason:
pending_reason:
close_reason: ["done: 設計どおりで修正不要。peers topic は roles [session,user] で CLI が session で名乗るのは send_message 列を問い手基準で出すため (src/cli.ts の peers コメント)。DESIGN-ja §5.1 で last_live 記録時は sessions/ をその場で読むので実在 sid は CLI 切断後も live のまま (2026-09-10 実測: 自セッション 12824c5d が peers 実行後も state live)。disappeared に残る行は手動テストの偽 sid (00000000-…c0de) と /clear で sid が変わった旧 sid で、§5.2 の Disappeared 定義 (接続が生存の証拠、stopped 印なし) の忠実な記録。daemon は非 claude ハーネスの sid を検証できないので偽 sid を弾く手段は無く、偽 sid で名乗らないことが対処。7 日で自然に消える"]
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
