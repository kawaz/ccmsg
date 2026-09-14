---
title: await をまたいだ前提の確かめ直しを全 async 経路で総点検
status: resolved
category: task
created: 2026-09-14T14:38:46+09:00
last_read:
open_entered: 2026-09-14T14:38:46+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-09-14T16:16:11+09:00
discard_reason:
pending_reason:
close_reason: ["finding/2026-09-14-await-crossing-invariants", "done: 323 await の表 (根拠なし0件)、欠落12件を修正、再現test 31件 (test/{files-edit-concurrency,auth-await-crossing,instance-stop-await-crossing,sessions-await-crossing,transcript-await-crossing}.test.ts)、stop の in-flight 待ちに IN_FLIGHT_STOP_MS(5s)上限、据え置き5件は finding の据え置き節、reviewer-sol-high レビューで land前の要修正なし、v0.16.0"]
blocked_by:
origin: 自リポ TODO
---

# await をまたいだ前提の確かめ直しを全 async 経路で総点検

## 概要

DR-0015 で同期 IO を async 化した経路のうち、fable-high の監査で同型の欠落が繰り返し見つかった: `Inbox.hold()` の evict 判定 (古い配列)、`StatusInbox` の二重生成、`Transcripts#open` の await 中の `release()` で孤児 tail、cache 形違いで壊れた entry が残る、`Topics.subscribe` の add 後 await で frame 順序逆転、`SessionStatus.refresh()` の並行で古い値が後着。いずれも「await の前に取った前提 (まだ購読されているか、entry が生きているか、手元の配列が最新か) を await 明けに確かめ直していない」という 1 つの形。

## 背景

async 化した全経路 (findings `2026-09-14-blocking-io-audit.md` の群 1 / 2 / 3 / 4 と外部待ち 3 件、fold の作り直し) を、この 1 つの観点で機械的に走査する: 各 `await` について「その前に読んだ状態 / 取った参照 / 立てた登録が、await 明けにも有効である根拠」を表にする。根拠が無いものを直す (前提の取り直し、世代番号、Promise を map に置く、等の既存の型のどれかで)。表は findings に残す。

## 受け入れ条件

- [x] `docs/findings/` に await × 前提 の表があり、「根拠なし」が 0 件
- [x] 見つけた欠落ごとに再現 test がある

## 関連

- DR-0015 §2 (「await をまたいだら前提を確かめ直す」の項)
- issue `fold-from-head-with-versioned-cache` の監査結果
- `/tmp/ccmsg-fold-audit.md` (消えていたら本 issue の概要が要約)
- findings `docs/findings/2026-09-14-await-crossing-invariants.md`
