---
title: test で daemon の時計を差し替えられるようにする
status: discarded
category: design
created: 2026-09-15T13:17:08+09:00
last_read:
open_entered: 2026-09-15T13:17:08+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered: 2026-09-15T20:23:49+09:00
resolved_entered:
discard_reason: ["却下 (kawaz 2026-09-15)。UI の visual 差分を消す目的に対して daemon の実装 (Date.now() の一元化) を歪める手段は釣り合わない。目的は幅固定 (webui test/visual/screenshot.css) で既に達成済み。clock 固定はタイマー依存の振る舞い test で検討するもので、visual の差分消しには持ち出さない"]
pending_reason:
close_reason: ["discarded"]
blocked_by:
origin: 自リポ TODO
---

# test で daemon の時計を差し替えられるようにする

## 概要

webui の visual test で Playwright の `page.clock.setFixedTime()` を使って時刻を固定しようとしたところ (page.clock だけでは webui の visual を決定的にできない)。daemon には時計を差し替える口が無い。

## 背景

2026-09-15 実測。daemon が実時刻で作り実時刻で判定するもの (search の `modified_within` = `Date.now() - within`、prompt cache の活性判定、token の期限、run の `started_at`) と半年ずれて、検索が 0 件・cache の輪が出ない等の機能落ちが起きた (44 failed / 48 passed)。daemon には時計を差し替える口が無く (全て既定引数の `Date.now()`)、接続バーの期限は daemon が実時刻の絶対時刻で出す。

方針: daemon の「今」を 1 箇所 (`now()` の依存注入、`StartOptions.now` は既にある) から取り、test / visual では固定値を注入できるようにする。webui の visual harness は daemon の `now` と `page.clock` を同じ値に揃える。これで時刻由来の描画を mask や幅固定なしに決定的にできる (現状は `test/visual/screenshot.css` の幅固定で対処)。

## 受け入れ条件

- [ ] daemon の `Date.now()` 直呼びが起動時の 1 箇所 (既定の `now`) 以外に無い
- [ ] webui の visual harness が daemon と page の時計を同じ固定値にして走り、`screenshot.css` の幅固定を外しても全件 pass

## 関連

- webui issue `visual-mask-box-dimension-drift` (archive、幅固定の経緯)、`relative-time-via-single-now-signal`
- `src/instance/instance.ts` `StartOptions.now`
