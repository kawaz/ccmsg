---
title: codex plugin: 配送は `codex queue --thread <sid>`、hello でハーネス種別を名乗る
status: resolved
category: design
created: 2026-09-09T16:52:57+09:00
last_read:
open_entered: 2026-09-09T16:52:57+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-09-11T11:51:56+09:00
discard_reason:
pending_reason:
close_reason: ["done:ハーネス種別は契約に載せず instance の属性 (src/harness/index.ts, config `harness: codex`)","done:配送は src/messaging/direct.ts の route (a) が socket 書き込みと `codex queue --thread <sid>` の2実装に分岐 (§4.1)","done:`ccmsg plugin install codex` は src/plugin/codex.ts で SessionStart/SessionEnd hooks + features.hooks 検出"]
blocked_by:
origin: 自リポ TODO
---

# codex plugin: 配送は `codex queue --thread <sid>`、hello でハーネス種別を名乗る

## 概要

調査 `docs/findings/2026-09-09-codex-session-delivery-path.md` の結論に基づく設計課題。Codex CLI 0.153.4 の正規配送口は `codex queue --thread <sid> --message <text>` (app-server `thread/queue/add`) で、Claude Code の messaging socket と違い process ではなく daemon-backed thread queue への永続投入。sid = thread UUID、transcript_path は SessionStart/End hook の stdin に入る。

決めること:

1. **契約**: session の hello (SessionMeta) にハーネス種別 (claude / codex) を載せるか、配送能力 (`direct_delivery` の手段) として表現するか。embedded TUI (queue endpoint を共有しない) は送達可能と扱わない境界の表現。
2. **daemon**: `src/messaging/direct.ts` の経路 (a) を「socket 書き込み」と「`codex queue` 実行」の 2 実装に分け、queue 成功 = 永続化であって表示ではない意味論を receipt/inbox にどう写すか。cold thread policy、100 件上限、`clientUserMessageId` dedupe。
3. **`ccmsg plugin install codex`**: hooks.json (SessionStart/SessionEnd) は `~/.codex/config.toml` の `features.hooks` 前提、skills、legacy notify は使わない。hook の key naming が Claude と違う点は findings §hooks 参照。

順序は規約ファースト (契約 → daemon → plugin)。

## 背景

`docs/findings/2026-09-09-codex-session-delivery-path.md` の調査結果を受けた設計課題の起票。

## 受け入れ条件

- [ ] hello (SessionMeta) にハーネス種別 or 配送能力の表現方針が決まる
- [ ] `src/messaging/direct.ts` の配送経路が socket 書き込み / `codex queue` 実行の 2 実装に分岐する設計になる
- [ ] `ccmsg plugin install codex` の hooks.json 設計 (SessionStart/SessionEnd、features.hooks 前提) が固まる

## TODO

<!-- wip 時のみ -->
