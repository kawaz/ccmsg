---
title: session.status の fold を transcript の頭から畳み、version 付きキャッシュに置く
status: open
category: design
created: 2026-09-14T11:54:33+09:00
last_read:
open_entered: 2026-09-14T11:54:33+09:00
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

# session.status の fold を transcript の頭から畳み、version 付きキャッシュに置く

## 概要

instance は `session.status` (走っている worker、TODO、`external_files`、`last_user_input_at` 等) を transcript を畳んで作るが、`src/transcript/tail.ts` の `#seed()` は末尾 `FOLD_TAIL_BYTES` (1 MiB) だけを同期で読んで fold の種にしている。それより前で起きたことは状態に現れず、契約の「値が無い = 無い」と「途中からなので知らない」が区別できない (webui は空を「無い」と描く)。

kawaz の裁定 (2026-09-14): 途中から畳んで不完全な状態を作るのはあり得ない。初めて読むセッションは頭から全部読んで畳む。性能が問題なら、セッション毎に「この byte まで畳んだ状態」をキャッシュに置き、キャッシュに形式 version を持たせて、畳む対象や形式が変わったら version を上げ、version 違いのキャッシュは捨てて頭から畳み直す。契約に印 (`folded_from` / `partial`) は載せない (契約 issue `session-status-partial-marker` はこの理由で close)。

## 背景

`src/transcript/tail.ts` の `#seed()`、`src/transcript/fold.ts`、`src/transcript/transcripts.ts` が対象。DESIGN{,-ja}.md §6 に `FOLD_TAIL_BYTES` の記述がある。

## 決めること (daemon 内の設計判断、着手前に固める)

1. **初回の畳みを同期でやらない**: seed は購読に答えるターンの内側で同期に読んでいる (DESIGN §6、snapshot を空で返さないため)。頭から全部を同期で読むと大きい transcript で instance が固まる。初回だけ非同期で畳み、畳み終えるまで `session.status` の値を述べない (「まだ畳み中」は一時状態なので契約の印は要らない) か、述べられる範囲で述べるかを決める。`transcript.items:<sid>` の snapshot (末尾 200 item) と byte snapshot は fold と別なので従来通りでよいか確認する
2. **キャッシュの中身と鍵**: fold の facts (`TranscriptFacts`) + 畳み終えた byte offset + 形式 version + transcript の識別 (path / size / inode 等、file が置き換えられたら捨てる)。置き場は `~/.cache/ccmsg/<instance>/…` (XDG cache、消えても頭から畳み直せる)
3. **version の上げ忘れ防止**: 畳む対象が増えた時に version を上げ忘れると古いキャッシュを正として読む。facts の型 / fold の実装からハッシュを機械で作るか、テストで version の更新を強制するかを決める
4. **再開**: 起動時にキャッシュがあれば offset から差分を畳み、無ければ頭から。file が offset より短ければ置き換えられたとみなして捨てる (今の tail の `size < offset` の扱いと揃える)

## 受け入れ条件

- [ ] 1 MiB より前で名指されたファイル / 発言が `session.status` に現れる (test で 1 MiB 超の transcript を作って確認、`test/transcript.test.ts` の既存 padding テストを流用)
- [ ] version 違いのキャッシュを置いた状態で起動すると捨てて頭から畳み直す (test)
- [ ] 大きい transcript (数十 MB) の購読開始で instance が固まらない (計測を journal に)
- [ ] DESIGN{,-ja}.md §6 の `FOLD_TAIL_BYTES` の記述を新しい仕組みに書き換える (経緯は書かない)

## 関連

- 契約 issue `session-status-partial-marker` (close 予定)
- `src/transcript/tail.ts` (`FOLD_TAIL_BYTES`、`#seed`)、`src/transcript/fold.ts`、`src/transcript/transcripts.ts`
