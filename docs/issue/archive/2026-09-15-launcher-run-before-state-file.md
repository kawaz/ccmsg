---
title: launcher が起動した run を状態ファイルより前に `agents` に載せる配線 (hyoui から harness の pid を得る)
status: discarded
category: task
created: 2026-09-15T10:58:20+09:00
last_read:
open_entered: 2026-09-15T10:58:20+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered: 2026-09-15T13:45:32+09:00
resolved_entered:
discard_reason: ["契約 DR-0026 で置き換え: 端末は terminals topic (hyoui list の polling、daemon v1.1.0) として一覧化し、起動直後のハーネスは契約の starting(terminals, agents) (pid があるのに agents に無く、command の先頭がハーネス) で導出する。launcher が agents に偽の行を載せる配線は不要になった"]
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
- [ ] `launches.tie` は挨拶の sid を無条件に信じない (その pid からの接続、または状態ファイルの sid と一致する時だけ結ぶ)。理由: 別セッションの Bash から `ccmsg post --sid B` を打つと `tie(pid_A, B)` になり、B に phantom run が生えて frozen になるため

## 訂正 (2026-09-15)

hyoui への依頼は不要だった。`hyoui status --format=json <session_id>` が `child_pid` (ハーネス本体の pid。hyoui は `claude` を直接 spawn していてシェルを挟まない)、`child_state`、`daemon_version` 等を返し、`hyoui list --format=json` でも取れる。launcher は起動直後に session id で status を引き、`child_pid` と `terminal_id = hyoui:<session_id>` を `LaunchSource` に供給すればよい。hyoui 側の issue `report-harness-pid-of-session` は取り下げ。

## 関連

- 契約 DR-0001 §4、daemon `src/sessions/runs.ts`、`src/launcher/`
