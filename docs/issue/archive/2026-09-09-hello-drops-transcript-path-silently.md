---
title: hello で境界外の transcript_path が黙って捨てられる
status: resolved
category: bug
created: 2026-09-09T17:23:41+09:00
last_read:
open_entered: 2026-09-09T17:23:41+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-09-10T00:00:00+09:00
discard_reason:
pending_reason:
close_reason: ["done: ownTranscript() が projects/ 自体も resolveAsFarAsItGoes で解決し、projects/ 未作成の config home でも prefix 判定で受理するよう変更 (config home 自体が無い場合のみ従来どおり undefined)。ツリー外 / .. 脱出 / ディレクトリ名検査は不変","done: 論点1は契約非拡張のまま据え置き、受理しなかった時に daemon log へ sid/path/理由 (not an absolute path | outside this config home's projects tree | not a file | the config home is not there) を1行出す運用で解決","done: DESIGN.md / DESIGN-ja.md §5.4 に受理境界と log の位置づけを記載","done: テスト追加 (projects/ 未作成でも受理 / 境界外は拒否され warn log に理由が出る)"]
blocked_by:
origin: 自リポ TODO
---

# hello で境界外の transcript_path が黙って捨てられる

## 概要

hello で境界外の transcript_path が黙って捨てられ、送り手に理由が返らない。`src/sessions/registry.ts` の `ownTranscript()` は hello の `transcript_path` を「絶対パス / `<config home>/projects/` の実体が存在 / そのツリー内 (symlink 解決後)」で検査し、外れたら undefined にする (= ディレクトリ境界で受理する設計、正しい)。ただし hello の応答は ok のままでフィールドが `peers` の行から消えるだけなので、送り手 (webui のテスト、将来の codex plugin、別ハーネス) からは「なぜ transcript が読めないか」が分からない。webui スライス 1 の worker が `projects/` を作っていない使い捨て instance で踏んで、原因特定に時間を使った。

## 背景

論点は 2 つ:

1. hello 応答に「受理しなかったフィールドとその理由」を載せる契約拡張 (任意フィールドなので minor) が妥当か、daemon.log への warn で足りるか
2. `projects/` が無い config home は本番でも起こりうる (新しい config home の初回セッション前) ので、その場合の扱い (存在しなくても prefix 判定だけで受理するか) を `ownTranscript()` の意味論として決める

## 受け入れ条件

- [ ] 上記 2 論点それぞれについて方針を決める
- [ ] 決めた方針に沿って `ownTranscript()` の挙動または hello 応答契約を更新する

## TODO

<!-- wip 時のみ -->
