---
title: `test/plugin.test.ts` の hook script test が全件走行の負荷下で 5 秒 timeout する
status: open
category: bug
created: 2026-09-15T20:30:36+09:00
last_read:
open_entered: 2026-09-15T20:30:36+09:00
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

# `test/plugin.test.ts` の hook script test が全件走行の負荷下で 5 秒 timeout する

## 概要

`test/plugin.test.ts` の "which session a process is inside > the hook script runs, names this config home and drops the other harness's" が全件走行の負荷下で 5 秒 timeout する。

## 背景

2026-09-15、`just push` の test 段 (全件) で 1 回 fail (5005.71 ms、timeout)。単体 (`bun test test/plugin.test.ts`) では 2 回とも 24 pass。他の全件走行では pass していた。

### 仮説 (未確定)

test が hook script を実プロセス (`bun` の子) として起動しており、全件並列で bun プロセスが多い時に起動が 5 秒を超える。timeout の値が「hook script の起動時間」と無関係な固定値。

### 直すこと

`test-integrity` rule: timeout 延長で通すのではなく、何を待っているか (プロセス起動) を確定し、test が待つ事象を明示する、または hook script の処理を関数として直接呼ぶ形に分けて、プロセス起動を伴う test は 1 本に絞る。

## 同型の観測 (2026-09-15、load average 20)

`test/terminals.test.ts` "the terminals of a host > are the manager's listing, in the contract's spelling" も全件走行で 5000.90 ms の timeout (単体は 10 pass)。どちらも子プロセス (hook script / fake hyoui) を起動する test で、負荷が高い時に起動が 5 秒を超える。issue の対象を「子プロセスを起動する test の timeout が起動時間と無関係な固定値」に広げる。

## 直すことの訂正 (2026-09-15)

「timeout の値」の話ではない。落ちている test は hook script / fake hyoui を bun の子プロセスとして起動して出力を待っており、負荷で起動が遅れれば上限を何秒にしても同じ構図。直すのは待ち方でなく test の切り方: (1) hook script のロジック (event JSON を受けて何を書くか) は関数として直接呼び、子プロセスを起動しない。`terminals` の listing の読み替えも `hyoui` の jsonl を文字列で与えて関数を test する。(2) 「script として起動できる」「PATH の hyoui を呼べる」の確認は各 1 本だけ残し、`proc.exited` / stdout の行という完了事象を await する (時間で待たない、上限は付けない)。

## 受け入れ条件

- [ ] `just ci` を 5 回連続で pass
- [ ] 真因が test コメントに書いてある
