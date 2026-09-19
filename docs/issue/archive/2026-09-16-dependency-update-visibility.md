---
title: 依存パッケージの更新見逃し防止を CI 周りに入れる
status: resolved
category: task
created: 2026-09-16T16:11:16+09:00
last_read:
open_entered: 2026-09-16T16:11:16+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-09-19T11:49:13+09:00
discard_reason:
pending_reason:
close_reason: ["done: just push の deps に check-outdated (scripts/check-outdated.sh、registry 不達は未確認で通す) と .github/dependabot.yml (bun 週次) を追加。just ci でなく push deps にしたのは GitHub CI が just ci を回すため"]
blocked_by:
origin: 自リポ TODO
---

# 依存パッケージの更新見逃し防止を CI 周りに入れる

## 概要

`tldts` (public suffix list を内蔵、same-site 判定に使用) のように更新を見逃すと挙動が古くなる依存があるので、パッケージ更新の見逃し防止を CI 周りに入れる。

確定形 (kawaz 2026-09-16「ローカル実行時はすぐ直せるので完全に止めてよい」): ローカルの `just ci` (push の gate) に `bun outdated` を入れ、直接依存に更新があれば fail させる (その場で `bun update` して直す)。registry に到達できない時は fail させず「未確認」と表示して通す。推移依存は対象外。GitHub 側の CI は止めず、Dependabot の週次 PR (`.github/dependabot.yml`, package-ecosystem bun) で見える化する。

## 背景

`tldts` は public suffix list を内蔵しており、リストが古くなると same-site 判定 (cookie partition 境界の判断) の挙動がずれる。このような「更新を見逃すと挙動が古くなる」性質の依存は、通常の semver 追従だけでは気づきにくい。

全 kawaz リポへ広げるなら justfile の canonical (bump-semver) 側で判断する (kawaz 2026-09-16)。

## 受け入れ条件

- [x] ローカルの `just ci` に `bun outdated` チェックを追加し、直接依存の更新があれば fail させる (注記: 実装は `just ci` ではなく `just push` の deps になった。`.github/workflows/ci.yml` が `just ci` を実行しており、`ci` に足すと「GitHub 側の CI は fail させない」という裁定に反するため。outdated 検査は `just check-outdated` recipe (`scripts/check-outdated.sh`) として切り出し、`push` recipe の deps に入れた (ローカル push gate では止まる / GitHub では走らない))
- [x] registry 到達不可時は fail させず「未確認」表示で通す (bun outdated は更新があっても registry 不達でも終了コード 0 で、不達時は無出力になり up-to-date と区別できないため、表の行の有無で判定し、行が無い場合のみ `bun info <dep> --no-cache` で registry 到達性を確認して「未確認」と「更新なし」を区別している)
- [x] 推移依存は対象外とする (bun outdated が元から表に出さないことを実機確認済み)
- [x] `.github/dependabot.yml` (package-ecosystem bun、週次) を追加し、更新 PR が出る状態にする
- [x] GitHub 側の CI は fail させない
