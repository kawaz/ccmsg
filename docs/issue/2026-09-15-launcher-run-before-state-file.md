---
title: launcher が起動した run を状態ファイルより前に `agents` に載せる配線 (hyoui から harness の pid を得る)
status: open
category: task
created: 2026-09-15T10:58:20+09:00
last_read:
open_entered: 2026-09-15T10:58:20+09:00
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

# launcher が起動した run を状態ファイルより前に `agents` に載せる配線 (hyoui から harness の pid を得る)

## 概要

契約 DR-0001 §4: launcher (hyoui 等) が起動した pid は、ハーネスが `sessions/` の状態ファイルを書く前から `agents` に `sid` 無しで載る (`terminal_id` と `started_at` はある)。daemon 側の受け口 (`LaunchSource` / `LaunchedRun`、`sid` 無しの `agents` 行、挨拶での結び付け、`runs` への合流) は実装済み (v1.0.0) だが、**`Launcher` からそれを供給する実装が無い**。`launcher.run` が spawn する子はレシピを走らせるシェルで、hyoui は端末を detach するので、ハーネス本体の pid を launcher は知らない。ホスト上の harness プロセスを走査して config home で絞る案は M6 (この instance は 1 つの config home にしか答えない) の線引きを動かすので採らない。

## 背景

方針: hyoui が pane で走っているハーネス本体の pid を答えられるようにし (hyoui への依頼 issue: `hyoui` リポ `docs/issue/`)、launcher は起動直後にそれを問い合わせて `LaunchSource` に供給する。得られるまでは `launches` absent のまま (run は状態ファイルに現れた時点から載る)。

## 受け入れ条件

- [ ] hyoui 経由で起動した直後 (trust ダイアログで止まっている間) に `agents` に `sid` 無し・`terminal_id = hyoui:<id>` の行が載る
- [ ] 挨拶か状態ファイルの出現で同じ行に `sid` が付く (行は移動しない)

## 関連

- 契約 DR-0001 §4、daemon `src/sessions/runs.ts`、`src/launcher/`
- hyoui への依頼 issue (起票次第ここに slug を書く)
