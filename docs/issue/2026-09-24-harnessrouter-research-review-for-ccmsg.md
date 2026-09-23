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

- [x] ccmsg 統括が上記を読み、各所見について「取り込む価値 / 既に解決済み / 取り込まない理由」の評価を本 issue に追記する
- [ ] 取り込む価値ありと判断したものは、基本機能の安定後に ccmsg 側で個別 issue に分ける

## 評価 (ccmsg 統括、2026-09-24)

研究 5 本の ccmsg 向けの節を、ccmsg / ccmsg-protocol / ccmsg-webui の実装と突き合わせた。起草は worker (Opus 5.5)、下記の主要な事実 (stdio の扱い、kill の段階、`stop_reason` の有無、`session.kill` の意味論) は統括がコードで再確認した。

総括: 研究の所見のうち、ccmsg のコードを見ると前提がずれているものが 4 つ (runner §2.2 / §2.3、protocol §3.1、gateway §3.1)。研究が挙げた「子プロセスの後始末」の心配は `codex queue` (stdio 全部 `ignore`、pipe が無い) と launcher (SIGTERM → 500ms で SIGKILL、pipe は `DRAIN_MS` 後に `reader.cancel()`) には当てはまらず、当てはまりうるのは translate helper だけ。一方で研究が気づいていなかった点として、transcript に書かれている `stop_reason` の `max_tokens` / `refusal` を ccmsg がどこにも出していない (src に `stop_reason` は 0 件、手元の実 transcript 30 ファイルには `max_tokens` 51 件 / `refusal` 111 件) ことが最も価値の大きい取り込み候補になる。

### 所見ごとの評価

| 研究の節 | 所見 | ccmsg の現状 (実装エビデンス) | 評価 |
|---|---|---|---|
| runner §2.1 | resume 失敗を同じ作業の続きに見せないか | sid は harness が名乗る値そのまま (DESIGN-ja §2)。sid をまたぐ欄は fork 起点 (`session.fork.origin.read`) だけ、`resumed_from` 類は無い | 解決済み。sid が変われば別の行になる |
| runner §2.2 | プロセスグループ kill + env マーカー掃討 | グループ kill は無い。launcher は SIGTERM → 500ms → SIGKILL、pipe は `DRAIN_MS` 後に手放す (`src/launcher/spawn.ts`)。`codex queue` は stdio 全部 `ignore` (`src/messaging/direct.ts`) | 取り込まない。launcher はセッションを残すのが役目でグループ kill は当のセッションを殺す。`Bun.spawn` 既定は daemon と同じグループなので setsid 無しの killpg は daemon に届く。env マーカーは macOS に `/proc` が無い |
| runner §2.3 | 終わった子の fd を閉じる | `codex queue` は pipe が無い。launcher は `reader.cancel()`。`ps` は `timeout` + `killSignal: SIGKILL`。translate helper (`src/translate/helper.ts`) は常駐で stdin の pipe を持ち、失敗のたび `child.kill()` (SIGTERM のみ) して次回に再起動するが、stdin の FileSink を閉じず終了も待たない | 取り込む価値あり (daemon、対象は translate helper)。fd 漏れは未検証で、helper をわざと失敗させ `lsof -p <daemon>` で fd 数と残った子を数える実測が点検手順 |
| runner §2.4 | 失敗理由を 1 行に決める | `codex queue` の stderr は `ignore`、0 以外は全部 `unavailable` で経路 (b) へ落ち理由が残らない | 取り込む価値あり (小、daemon のログのみ)。wire には出さず、経路 (a) が黙って効かなくなった時の診断材料にする |
| (照合中に発見) | `codex queue` の timeout 後に SIGKILL へ上げていない | 10 秒で `spawned.kill()` (SIGTERM) を送り終了を待たず 124 を返す。launcher / supervise は SIGKILL へ上げる | 取り込む価値あり (小)。書き方を他と揃えるだけ |
| runner §2.5 | codex app-server JSON-RPC 購読 | DESIGN §4.1 で入力に足さないと決定済み | 取り込まない (研究の結論と同じ) |
| runner §2.6 | 正準イベントへの正規化 | 契約が item 型を持ち daemon が分類 (DR-0002、protocol DR-0013) | 解決済み |
| runner §2.7 | harness × 経路 × 状態の到達マトリクス | findings / runbooks は版指定の個別実測 (codex 0.153.4 / 0.154.0) のみ | 取り込む価値あり (中、docs / runbook)。codex の版上げで経路 (a) の意味論が変わりうるのは findings が実際に書いている |
| ui §2.1 | 時間比例の帯 | item に `at`、呼び出しと答えは `parent_item` で結ばれる (protocol `dump.ts`) ので wire を足さず webui で計算できる。webui に所要時間表示は無い | 取り込む価値あり (webui)。帯は窓 (末尾 1 MiB 相当) の範囲だけ |
| ui §2.2 + protocol §3.1 | 「未完了」を失敗と分ける語彙 | 中止は `notice.interrupt` で分類済み、API エラーは fold の `api_error`。`stop_reason` は src に 0 件。研究は「transcript から読めるか未確認」と書くが読める (実測で `max_tokens` 51 / `refusal` 111) | 取り込む価値あり (protocol の item 語彙 → daemon の classify / fold → webui)。gateway の events に頼る必要は無い。特に `refusal` は見えないと何が起きたか分からない停止 |
| ui §2.3 | サーバの理由文をそのまま出す | webui `src/refusal.ts` は契約の `code` で分岐し、人に次の手がある 3 code だけ言葉を当て、他は `msg` をそのまま出す | 解決済み (`msg` で分岐しない分、harnessrouter より筋が良い) |
| ui §2.4 | reconcile poll、固定間隔 SSE 再接続 | snapshot の契約と M2 で閉じている | 取り込まない (研究の結論と同じ) |
| protocol §3.2 | `retry_after_ms` | `rate_limited` は「何も失敗していない、追いつけば通る」、`internal_error` は再試行可否を述べないと明記 (protocol `src/errors.ts`) | 取り込まない (研究の推しと同じ) |
| protocol §3.3 | stream は最適化、保存物が正本 | snapshot + delta (protocol DR-0005)、byte offset + `transcript.read` | 解決済み |
| protocol §3.4 | SKIP ≠ PASS、負例 stub | 契約の自前テストに負例 assert はある。export される fixtures は正例のみ (envelope のエラー 1 件を除く) | 取り込む価値あり (小、protocol の fixtures)。実装 2 つが同じ validator を使うので、現状ほぼ足りている |
| protocol §3.5 | cancel の冪等性と 1 秒以内 | `session.kill` は既に居ない process に `session_not_found` ("the process of … is gone") を投げるので冪等でない。応答は SIGTERM 2 回の設計で最長約 3 秒 (`GRACE_MS`、意図的)。webui `Runs.tsx` は断られた理由をそのまま出すので、1 回目で消えた後に押し直すと "gone" がエラーに見える | 取り込む価値あり (小、webui の文言)。1 秒以内は実測済み設計とぶつかるので取り込まない |
| gateway §3.1 | capabilities の省略と `false` の区別 | `hello` が `capabilities: Capability[]` を返し、属性表の `capability` が集合に無ければ `capability_unavailable` | 解決済み。契約は世代 1 つで互換経路を持たない (protocol DR-0017) ので「省略が古いサーバと見分けられない」問題が起きない |
| docs-ops §2-1 | 結果 JSON から md 生成 | 繰り返し測る対象がまだ無い (findings 7 本とも 1 回きり) | 今は取り込まない。到達マトリクスの 2 回目の測定が来た時点で |
| docs-ops §2-2 | SKIP と ERROR を分ける報告形式 | 無い | 取り込む価値あり (小)。到達マトリクスの表に「検証できなかった組み合わせ」「道具自身の故障」の欄を最初から持たせる形で、単独ではやらない |

### 取り込む価値あり (影響大 × 点検コスト低の順、基本機能の安定後に個別 issue へ)

1. translate helper の後始末 (fd と SIGTERM を無視する子) を `lsof` で実測する — daemon、影響 中、コスト 低
2. `stop_reason` の `max_tokens` / `refusal` を出す — protocol → daemon → webui、影響 大、コスト 中 (契約の語彙が変わる)
3. `codex queue` の timeout 後に SIGKILL へ上げる — daemon、影響 小、コスト ごく低
4. 経路 (a) が落ちた理由 (`codex queue` の stderr 末尾) を daemon のログに残す — daemon、影響 小〜中、コスト 低
5. `session.kill` で既に居なかった場合の見せ方 — webui、影響 小、コスト 低
6. 窓の範囲の時間比例帯 — webui、影響 中、コスト 中
7. harness × 経路 × 状態の到達マトリクス (SKIP / ERROR の区分付き) — docs / runbook、影響 中、コスト 高
8. 負例 fixtures の共有 — protocol、影響 小、コスト 低

### 統括の推し (個別 issue 化の時点で Q にする候補)

- **`stop_reason` の運び方** (2): 全値をそのまま運ばない。`end_turn` / `tool_use` は item の構造から既に分かる状態で、運ぶと upstream の判断を 2 経路で持つことになる。運ぶのは「未完了」を意味する `max_tokens` / `refusal` だけで、assistant item の欄でなく `notice.*` 系 (中止が `notice.interrupt` で表せている形と揃える)。item の形は protocol DR-0013 の範囲なので契約側の DR で決める
- **`session.kill` の既に居ない場合** (5): daemon からは「自分の signal で消えた」と「最初から居なかった」を区別できないので `session_not_found` は正直な返答。webui の文言で吸収する
- **時間比例帯の範囲** (6): 窓の範囲だけで許容する。セッション全体の帯は instance に集計 op が要り M2 (同じ情報の 2 経路目) に触れるので持たない
- **到達マトリクスの形** (7): 手動の runbook + findings への記録から始める。半自動化は 2 回目の測定が来てから (docs-ops §2-1 と同じ判断)
