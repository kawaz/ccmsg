---
title: セッションの `cwd` を hook event の cwd から採ると Bash ツールの一時 cwd を拾う
status: open
category: bug
created: 2026-09-15T11:57:34+09:00
last_read:
open_entered: 2026-09-15T11:57:34+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: emrd 統括セッション
---

# セッションの `cwd` を hook event の cwd から採ると Bash ツールの一時 cwd を拾う

## 概要

emrd 統括セッション (2026-09-15 報告、事象は 2026-09-10、v1 の room member 情報で観測): セッションの所在 `cwd` が、直前の Bash ツール (`cd <別ディレクトリ> && direnv exec . …`) の一時 cwd になっていた。hook (PreToolUse / PostToolUse 等) の event が「event-time cwd」を運び、それを挨拶 (`hello.session`) がそのまま述べたため。v2 も同じ: `src/cli.ts` の `stated()` が `named.get("cwd") ?? event.cwd` を採り、挨拶はフィールド単位で上書きされる (DR-0010) ので、後から来た hook の cwd で `peers.cwd` が動く。

## 背景

「個別セッションが cd に気をつける」で守らず、セッションの所在は固定値から取る方針。候補: `CLAUDE_PROJECT_DIR` (ハーネスが起動時に固定)、または SessionStart の挨拶で登録した cwd を正とし、以後の hook の `cwd` では上書きしない。

決めること:

- `cwd` の正本を `CLAUDE_PROJECT_DIR` にするか、SessionStart 時の値に固定するか (両方無い時のフォールバックは event.cwd)
- `repo` / `ws` / `repo_root` / `branch` も cwd から導いているので同じ扱いにするか (branch は動きうる)

## 受け入れ条件

- [ ] Bash ツールで別ディレクトリに cd した直後の hook を経ても `peers.cwd` が変わらない (test: event.cwd が違う挨拶を後から送っても最初の値のまま)
- [ ] v1 (`kawaz/claude-ccmsg`) にも同じ issue を起票 (相互参照)

## 関連

- 契約 DR-0010 (挨拶はフィールド単位)、`src/cli.ts` `stated()`、`src/greeting/meta.ts`
- 報告: emrd 統括セッション、room r311 (v1)
