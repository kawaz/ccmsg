---
title: `terminals` topic の `hyoui list` 5 秒 polling を socket dir の watch + バックオフ確認 poll に置き換える
status: resolved
category: task
created: 2026-09-15T20:39:27+09:00
last_read:
open_entered: 2026-09-15T20:39:27+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-09-15T21:13:20+09:00
discard_reason:
pending_reason:
close_reason: ["done: terminals は socket dir の watch 駆動になり周期 poll を撤去 (購読開始時 1 回 + イベント時 + 張った直後の 1 回読み直し)。sessions/ の確認 poll は既決事項として残す"]
blocked_by:
origin: 自リポ TODO
---

# `terminals` topic の `hyoui list` 5 秒 polling を socket dir の watch + バックオフ確認 poll に置き換える

## 概要

v1.1.0 で入れた `terminals` topic は購読中 `hyoui list --format=jsonl` を 5 秒ごとに polling している (`src/terminals/terminals.ts`)。`agents` の型を写しただけで、`sloppy-ai-patterns` の自問 (直接通知してくれる primitive は無いか) を経ていない。`hyoui list` 自体が socket dir (`~/.local/state/hyoui/`、セッションごとに 1 socket) の走査なので、出入りは `fs.watch` で取れる。

## 背景

`agents` topic の実装をそのまま流用した結果、polling primitive を無自覚に踏襲している。socket dir の追加/削除は `fs.watch` (ハーネスの `sessions/` で使っている `DirectoryWatch` と同じ仕組み) で直接検知できるはずで、5 秒固定 polling を続ける理由がない。

## 直すこと

- socket dir を `DirectoryWatch` (ハーネスの `sessions/` と同じ) で watch し、追加 / 削除のイベントで `hyoui list` を引く
- 中身の変化 (`child_state` / `child_pid` の遷移) はイベントが無いので確認 poll は残すが、変化が無い間は間隔を伸ばす (指数バックオフ、上限あり)、変化があれば戻す。購読が無い間は止める (既にそう)
- hyoui 側に変化を push する口 (`hyoui wait` は 1 セッションの述語待ち、`tail --follow` は出力) があれば、それで `child_state` の遷移を取れないか確かめる (reference `agent-runtime/event-driven-alternatives`)

## 受け入れ条件

- [ ] 端末の出入りが watch のイベントで 1 秒以内に `terminals` に反映される (test: socket ファイルの作成 / 削除を模擬)
- [ ] 変化が無い時の `hyoui list` 実行回数が 5 秒間隔より減っている (test: 30 秒で N 回以下)

## 訂正 (kawaz 2026-09-15): polling 自体が不要

必要性から整理すると周期 polling は要らない。要るのは (1) `/terminals` を開いた時と socket dir の出入りイベント時の `hyoui list` 1 回、(2) セッション画面の端末タブを開いた時の `hyoui status <id>` 1 回 (id は既知)、(3) セッション一覧の「起動中」の導出は socket dir のイベント時の list で足りる (`agents` の変化は既に watch 済み)。`child_state` の遷移は socket の消滅か、その端末を見ている時の status で分かる。バックオフ付き確認 poll も不要。`terminals` topic の実装は「購読開始時に 1 回 + socket dir の watch で再取得」に縮める。

## 関連

- `src/terminals/terminals.ts`、`src/sessions/harness.ts` の `DirectoryWatch`、reference `agent-runtime/event-driven-alternatives`
