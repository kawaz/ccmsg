---
title: service start after register does not bootstrap the unit
status: open
category: bug
created: 2026-09-10T13:08:48+09:00
last_read: 2026-09-10T13:09:26+09:00
open_entered: 2026-09-10T13:08:48+09:00
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

# service start after register does not bootstrap the unit

## 概要

`ccmsg service unregister` → `ccmsg service register` → `ccmsg service start` の順で実行すると、`register` は plist を書き `service status` は `registered: true, running: true, pid: <旧 pid>` を返すが実体は動いておらず、`service start` は `service: {loaded: false, state: null}` のまま監督者を起動しない (`daemon status` は `supervisor_not_running`)。

`launchctl bootstrap gui/<uid> <plist>` を手で打つと起動し、以後 `service status` は正常。

本番で 2026-09-10 に観測、v0.2.8。

## 背景

論点:

1. `service start` は unit が loaded でなければ `bootstrap` してから `kickstart` する (macOS)。systemd も `daemon-reload` + `enable --now` 相当を確認する
2. `service status` の `running` が旧 pid を返した経路 (`register` 直後に古い状態を読んだ?) を直し、`loaded` と `running` の整合を取る
3. `register` 自体が「登録して起動まで」を行うべきか (今は書くだけ)

reference `cli-daemon-subcommands` の `service` 体系と突き合わせる。

## 受け入れ条件

- [ ] `unregister` → `register` → `start` の順で launchctl unit が確実に bootstrap され daemon が起動する
- [ ] `service status` の `running`/`pid` が実体と一致する (loaded=false のときに running=true を返さない)
- [ ] `register` が起動まで行うか / `start` が bootstrap を担うかの設計判断が記録される

## TODO

<!-- wip 時のみ -->
