---
title: transcript:<sid> topic の snapshot と transcript_read の解決経路が非対称
status: resolved
category: design
created: 2026-09-09T17:30:59+09:00
last_read:
open_entered: 2026-09-09T17:30:59+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-09-10T13:57:53+09:00
discard_reason:
pending_reason:
close_reason: ["implemented","design:DESIGN.md §5.4","design:DESIGN.md §6.2 (ja/en)"]
blocked_by:
origin: 自リポ TODO
---

# transcript:<sid> topic の snapshot と transcript_read の解決経路が非対称

## 概要

`transcript:<sid>` topic と `transcript_read` の見つけ方が非対称。`Transcripts.snapshot()` は `pathOf(sid)` (= セッションが hello で announce した transcript_path) が無いと空を返す (snapshot frame が来ない) が、`transcript_read` は `TranscriptFiles` が `projects/**/<sid>.jsonl` を歩いて同じファイルを読める。

webui (ccmsg-webui スライス 2) は「snapshot を待つと未 announce の sid (last_live / pinned / 検索結果の過去セッション) で永久に空」になり、購読・snapshot・接続確立の 3 契機で冪等に 1 ページ目を `transcript_read` する形で回避した。

## 背景

再現: 使い捨て instance の `projects/` に jsonl を置き、announce しない sid で `topic_subscribe transcript:<sid>` → ok だが frame 無し、`transcript_read` → 読める。

## 論点

1. 過去セッション (追記が起きない) に topic の snapshot (`size` だけ) を返す意味があるか。
   - 返せば webui は「どこから遡るか」を 1 つの経路で知れる。
   - 返さないなら契約の DESIGN に「snapshot が無い = 稼働していない (追記も来ない)」を明記し、webui はそれを読む前提にする。
2. `pathOf(sid)` (announce 経由) と `TranscriptFiles` (walk 経由) の 2 つの解決経路を持つ理由 (announce 済みは信頼、walk は探索用?) を契約の §5 / §6 の意味論として書く。

## 受け入れ条件

- [ ] 論点 1・2 について契約 (DESIGN) 側の意味論が明記される、または「webui 側が 3 契機フォールバックで吸収する」が正式な設計として記録される

## TODO

<!-- wip 時のみ -->
