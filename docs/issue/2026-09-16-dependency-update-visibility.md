---
title: 依存パッケージの更新見逃し防止を CI 周りに入れる
status: open
category: task
created: 2026-09-16T16:11:16+09:00
last_read:
open_entered: 2026-09-16T16:11:16+09:00
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

# 依存パッケージの更新見逃し防止を CI 周りに入れる

## 概要

`tldts` (public suffix list を内蔵、same-site 判定に使用) のように更新を見逃すと挙動が古くなる依存があるので、パッケージ更新の見逃し防止を CI 周りに入れる。

推し: Dependabot の `.github/dependabot.yml` (package-ecosystem bun、週次) で更新 PR を出す。CI を fail させる形 (`bun outdated` で落とす) は無関係な更新でも赤くなるので採らない。

## 背景

`tldts` は public suffix list を内蔵しており、リストが古くなると same-site 判定 (cookie partition 境界の判断) の挙動がずれる。このような「更新を見逃すと挙動が古くなる」性質の依存は、通常の semver 追従だけでは気づきにくい。

全 kawaz リポへ広げるなら justfile の canonical (bump-semver) 側で判断する (kawaz 2026-09-16)。

## 受け入れ条件

- [ ] `.github/dependabot.yml` (package-ecosystem bun、週次) を追加し、更新 PR が出る状態にする
- [ ] CI を fail させる形は採らない
