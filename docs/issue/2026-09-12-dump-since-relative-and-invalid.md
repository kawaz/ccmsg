---
title: dump --since/--until が相対指定未対応、かつ不正値でも黙って items 0 になる
status: open
category: bug
created: 2026-09-12T06:45:43+09:00
last_read: 2026-09-12T06:46:23+09:00
open_entered: 2026-09-12T06:45:43+09:00
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

# dump --since/--until が相対指定未対応、かつ不正値でも黙って items 0 になる

## 概要

`ccmsg dump --since / --until` は ISO / epoch ms / record uuid だけを受け、`-10m` のような相対指定は未対応。しかも不正な値を渡すと error にならず items 0 の dump が黙って出る (2026-09-12 実測: `--since -10m` で `items: 0`、同じ対象を範囲無しで 1075)。`recover` / `journal` のように since / until で区間を切って使う preset が前提なので、以下 2 点を直したい。

1. 相対指定 (`-10m` / `-2h` / `-1d`、今からの差) を受ける
2. 解釈できない値は `invalid_args` で止める (黙って空にしない)

## 背景

契約 `session.dump.write` の args の型 (`at | uuid`) を広げるか、CLI 側で絶対時刻に解決してから渡すかの 2 択が考えられる。契約を触らない後者 (CLI 側で相対値を絶対時刻へ解決してから渡す) が推し。

## 受け入れ条件

- [ ] `--since` / `--until` に `-10m` / `-2h` / `-1d` 形式の相対指定を渡せる (今からの差として絶対時刻に解決される)
- [ ] 解釈できない `--since` / `--until` 値を渡すと `invalid_args` 相当のエラーで止まる (items 0 の dump を黙って返さない)
