---
title: daemon restart --all leaves supervisor on old build
status: open
category: bug
created: 2026-09-11T12:59:05+09:00
last_read:
open_entered: 2026-09-11T12:59:05+09:00
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

# daemon restart --all leaves supervisor on old build

## 概要

`ccmsg daemon restart --all` は子 instance だけを新コードで起動し直し、launchd 配下の監督者 (`ccmsg daemon supervise`) は旧コードのまま残る。

## 背景

2026-09-11 の v0.8.2 → v0.9.0 (契約 1.22.0、op 名改名) の載せ替えで、旧監督者が新しい子に旧名 `instance_ping` を送り `daemon status --all` の `version` が全 instance で null になった (子自身は `hello.user` → `instance.ping` に正しく答えていた)。`ccmsg service stop` → `start` で監督者を載せ替えて解消。

決めること:

1. `daemon restart --all` が監督者も含めて入れ替えるべきか (監督者の再 exec、または「監督者と子の build が違う」を status に出す)
2. 監督者が子の応答 `unknown_op` を受けた時に version null で黙らず、build 不一致として表示する

再現: 監督者を起動したまま src を op 名が変わる版に更新して `daemon restart --all` → `daemon status --all` の version を見る。

## 受け入れ条件

- [ ] `daemon restart --all` の監督者取り扱い方針が決まる (再 exec するか、build 不一致を検出・表示するか)
- [ ] 監督者が子から `unknown_op` を受けた場合の `daemon status --all` 表示が version null 以外の意味のある状態を示す

## TODO

<!-- wip 時のみ -->
