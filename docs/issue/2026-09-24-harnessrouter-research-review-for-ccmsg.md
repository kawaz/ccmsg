---
title: harnessrouter 研究 (llm-gateway 側で実施) の ccmsg 向け所見を読んで評価・感想を返す
status: open
category: idea
created: 2026-09-24T00:06:28+09:00
last_read:
open_entered: 2026-09-24T00:06:28+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: llm-gateway
---

# harnessrouter 研究 (llm-gateway 側で実施) の ccmsg 向け所見を読んで評価・感想を返す

## 概要

kawaz の依頼で llm-gateway 統括が HarnessRouter/harnessrouter (Codex / Claude Code をハーネスとして backend 化する層、UHP プロトコル) を観点別に研究した。ccmsg に関わる所見が多く出たので、ccmsg 統括に**読んで評価・感想を返してほしい** (kawaz 2026-09-24: 「基本機能の実装で忙しいのでそれらが一通り安定してから取り組むで良いが、所見については一度目を通させて評価や感想を聞きたい」)。実装着手はこの issue の対象外。

## 背景

読むもの (llm-gateway リポ、`main@origin` に push 済み):

`~/.local/share/repos/github.com/kawaz/llm-gateway/main/docs/research/` の 5 本。ccmsg 向けの節:

- `2026-09-23-harnessrouter-runner.md` §2 — 子プロセスの後始末 (プロセスグループ kill + env マーカーで残党掃討、閉じ忘れた pipe で fd 枯渇した実例)、resume_lost、失敗理由の優先順、codex app-server JSON-RPC、正準イベントへの正規化、検証マトリクスの判定規則。**影響が大きく点検コストが低いのは 2.2 / 2.3**
- `2026-09-23-harnessrouter-ui-observability.md` §2 — 時間比例の帯 (tool 実行を長さのある棒、20 秒超の間隙を idle 色)、「未完了」を失敗と分ける状態語彙、サーバの理由文をそのまま出す。§2.4 に取り込まない方がよいもの (4 秒 reconcile poll、固定間隔 SSE 再接続)
- `2026-09-23-harnessrouter-protocol.md` §3 — 終端状態の規則、`retry_after_ms` と再試行可否、stream は最適化で保存物が正本、SKIP は PASS ではない、cancel の冪等性
- `2026-09-23-harnessrouter-gateway.md` §3 — 版交渉と discovery、capabilities で省略と false を区別
- `2026-09-23-harnessrouter-docs-ops.md` §2 — conformance の結果区分 PASS / FAIL / SKIP / ERROR、結果 JSON から md を生成

注意: 5 本とも harnessrouter を動かさずコードと docs を読んだ研究。「実例あり」は harnessrouter 側の記録に依拠。ccmsg のコードは runner 観点の worker が docs しか読んでいない箇所がある (§5 未確認に明記)。

## 受け入れ条件

- [ ] ccmsg 統括が上記を読み、各所見について「取り込む価値 / 既に解決済み / 取り込まない理由」の評価を本 issue に追記する
- [ ] 取り込む価値ありと判断したものは、基本機能の安定後に ccmsg 側で個別 issue に分ける
