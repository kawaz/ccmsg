---
title: transcript tail が bulk append に追いつかない (Linux)
status: open
category: bug
created: 2026-09-12T09:38:52+09:00
last_read:
open_entered: 2026-09-12T09:38:52+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: webui visual test (CI run 34661324095)
---

# transcript tail が bulk append に追いつかない (Linux)

## 概要

webui の visual test (CI Linux、2026-09-12、run 34661324095 の error-context) で観測: session が greeting した後に transcript の jsonl へ 500 行を一括 append すると、instance の `transcript.items:<sid>` の取り込みが bulk 299 付近 (item 221) で止まり、20 秒待っても追いつかなかった。macOS では追いつく。

## 背景

webui 側はテストの依存 (追記の取り込み速度に賭ける形) を外して対処済みだが、実機で長い追記の束 (subagent の一括書き込み、compaction 後の書き戻し等) が来た時に tail が遅れる / 止まるなら daemon の問題。

見立て:

- watcher のイベント合流で途中の変更を落としている
- 1 回の読み取りで読む上限がある
- fold の途中で読み込みが打ち切られる

## 受け入れ条件

- [ ] 再現条件 (Linux、greeting 済み session の jsonl に 500 行を一括 append、`transcript.items` の item 数を 20 秒観測) で再現し、真因を特定する
- [ ] 真因が Linux の CI 環境固有 (使い捨て環境のリソース制約等) か daemon の実装上限かを切り分ける
- [ ] daemon の実装に起因する上限・バッチ化仕様が見つかれば DESIGN に明記する

## TODO

<!-- wip 時のみ -->
