---
title: config を JSON + マージ規則から TS ローダーに移す
status: resolved
category: task
created: 2026-09-11T13:12:45+09:00
last_read:
open_entered: 2026-09-11T13:12:45+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-09-11T14:52:50+09:00
discard_reason:
pending_reason:
close_reason: ["done:v0.10.0/v0.10.1 で実装、本番移行済み(2026-09-11)","done:構造は kawaz 裁定(r303 m16/m17/m26)通り config_v2.ts -> clusters.json -> clusters/cluster-<id>.json -> instances/instance-<id>.ts、権威データでディレクトリ走査なし","done:daemon add/remove/list, ccmsg mesh add/list/remove, daemon passkey --cluster を実装","done:本番4 instance を v0.10.1 へ移行、peers --all 到達確認済み","done:MERGE_RULES と JSON config 撤去済み(config.json のみなら移行先を示す config error)","followup:multiple-clusters-per-host(cluster 跨ぎ隔離)は別 issue","followup:auth-records-per-cluster-store(claim に cluster)は別 issue"]
blocked_by:
origin: 自リポ TODO
---

# config を JSON + マージ規則から TS ローダーに移す

## 概要

ts-config-loader: config を JSON + マージ規則から TS に移す。裁定 CM-Q1 (2026-09-10 r298m35) = TS で書く。defaults は `~/.config/ccmsg/config.ts` が `({builtin, config: builtin のコピー}) => config` を export、instance は `~/.config/ccmsg/instances/<name>.ts` が `({builtin, default, config: default のコピー}) => config` を export し、`builtin` / `default` は immutable で渡す (深い / 浅いマージの問題が消える)。

CM-Q2a (2026-09-11、kawaz が QUESTIONS.md にチェック) = ファイル構成は `config.ts` + `instances/<name>.ts` (instance ごと 1 ファイル、自動発見)。`daemon add` はテンプレを 1 ファイル生成、`remove` は削除。

やること:

- daemon に TS config の loader を実装 (bun で import)
- v0.3.5 の `MERGE_RULES` と JSON config (`docs/research/2026-09-10-config-merge-policy.md` の規則) を撤去
- `daemon add` / `remove` をテンプレ生成 / 削除に変更
- `daemon status` の実効 config 表示はそのまま維持

本番 `~/.config/ccmsg/config.json` の移行は統括が deploy 時に行う (JSON → TS の変換は手動、backup `.bak-*` あり)。このタスクのスコープ外。

## 背景

CM-Q1 (2026-09-10) の裁定で config を TS 化することが決まった。JSON + `MERGE_RULES` によるマージ規則は深い/浅いマージの区別が必要で複雑だったが、TS ローダーが `builtin` / `default` を immutable で渡し呼び出し側が明示的にコピーして加工する形にすることでこの問題が消える。ファイル構成 (CM-Q2a) も 2026-09-11 に kawaz が QUESTIONS.md でチェック済み。

## 受け入れ条件

- [ ] daemon が `~/.config/ccmsg/config.ts` と `~/.config/ccmsg/instances/<name>.ts` を bun 経由で import してロードできる
- [ ] v0.3.5 の `MERGE_RULES` と JSON config 読み込みコードが撤去されている
- [ ] `daemon add <name>` が `instances/<name>.ts` のテンプレを 1 ファイル生成する
- [ ] `daemon remove <name>` が対応する `instances/<name>.ts` を削除する
- [ ] `daemon status` の実効 config 表示が従来どおり機能する
- [ ] 決めること 2 点 (下記 TODO) が解決している

## TODO

- [ ] TS ファイルの型: `@ccmsg/protocol` またはdaemon が export する型を `import type` で config ファイルから参照できるか、参照する場合の import path をどうするか決める
- [ ] `dump.presets` のように instance 単位と defaults 単位の両方を持つ値の template の形をどうするか決める
