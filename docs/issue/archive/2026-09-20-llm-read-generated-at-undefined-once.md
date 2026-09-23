---
title: llm-read-generated-at-undefined-once
status: resolved
category: bug
created: 2026-09-20T22:50:31+09:00
last_read: 2026-09-24T00:54:31+09:00
open_entered: 2026-09-20T22:50:31+09:00
wip_entered: 2026-09-24T01:23:44+09:00
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-09-24T01:34:50+09:00
discard_reason:
pending_reason:
close_reason: ["journal/2026-09-24-test-timeout-from-bloated-tmpdir","done:commit 7714a9a"]
blocked_by:
origin: 自リポ TODO
---

# llm-read-generated-at-undefined-once

## 概要

`test/llm-read.test.ts:146` が full run で 1 回だけ失敗した観測記録。現象: `expect(answer.generated_at).toBe(NOW)` が `Received: undefined` で落ちた (現行のファイルでは 145 行目。二次エラーで、真因は下記)。実出力は「Received: undefined / at <anonymous> (test/llm-read.test.ts:146:33)」で、同一 run の他 1220 件は pass。

## 背景

発生は 2026-09-20 の daemon issue バッチ作業中 (sandbox capability 撤去の commit 直前の ci)。変更範囲は files / upstream keepalive / auth store で llm-read とは無関係。

再現状況: 同ファイル単独実行 (`bun test test/llm-read.test.ts`) で 7 pass、その後の `just ci` の full run 4 回すべて green で再現せず。原因未特定 (fakeGateway の起動と最初の取得が競合する疑いがあるが未調査)。flaky として片付けず、次に落ちた時のために観測を残す。

## 受け入れ条件

- [x] 失敗時に `llm.usage.read` が何を返したか (error code / 本文) が分かる形で記録できていること
- [x] 再現条件が特定できていること

## 真因 (2026-09-24、worker Opus 5.5 の調査を統括が確認)

146 行目 (現行は 145 行目) の `Received: undefined` は二次エラーで、真因は同じテスト (`llm.usage.read` の最初の test) の **5 秒 timeout**。bun は timeout 後もテスト本体を止めずに `afterEach` を走らせて fake gateway を止めるので、その後で本体の fetch が "Unable to connect" → `{ok:false, error:{code:"internal_error"}}` になり、`generated_at` を読む assert が "Unhandled error between tests" として出る。issue 起票時の「`ok:true` 以外を返したか gateway の document が届かなかった」は前者だが、test が応答を無検査で cast しているので当時の出力からは区別できなかった。

遅い理由: プロセス内で最初の `start()` が払う設定ファイルの `import()` (`src/instance/config.ts` の `called`) で、Bun がモジュール解決のために祖先ディレクトリを読む。テストの root は `$TMPDIR` 配下で、`$TMPDIR` はテストが消さない `ccmsg-*` ディレクトリで 248,356 エントリ (統括の実測。ccmsg-mesh 79k / ccmsg-instance 32k / ccmsg-auth 18k / ccmsg-launcher 16k / ccmsg-llm 14k / ccmsg-caps 12k) に膨らんでいる。無負荷で初回 `start()` が約 1.1 秒 (CPU プロファイルで 1114ms が import)、2 回目以降は 4〜36ms。full suite で `llm-read.test.ts` は 2 番目のファイルで、1 番目 (`dispatch.test.ts`) は `start()` を呼ばないので、このテストがプロセス全体の初回コストを負担する。負荷が乗ると 5 秒を超える。

再現 (worker の実測):

- 決定的: 最初の `start()` の前に 5.5 秒待つ scratch コピーで、同じ「1 fail / 1 error」(`Received: undefined`)
- 負荷下: 単独実行 16 並列 + full suite 2 本を並走 → 240 回中 200 回失敗、応答は全部 `internal_error` "Unable to connect"
- A/B (同負荷): 既定 `$TMPDIR` で 80 回中 35 回失敗 (初回 start 最大 7.1 秒)、`/private/tmp` 配下の空ディレクトリを `TMPDIR` にすると 80 回中 0 回 (最大 183ms)
- 無負荷では再現しない (単独 1,750 回、full suite 7 回すべて pass)

否定した仮説: fake gateway 起動と初回 fetch の競合 (`Bun.serve` は同期で listen)、keep-alive の再利用、port 0 の衝突 (2000 回で 0)、一時ポート枯渇 (TIME_WAIT 84〜114)、無関係な frame の混入。

## TODO

- [x] 成功を期待する呼び出し (145 / 173 / 207 行目) を `expect(answer).toMatchObject({ ok: true })` で確かめる helper に置き換える (失敗時に `error.code` / `msg` が差分に出る = 受け入れ条件 1)
- [x] `just test` を `/tmp` 配下の小さな専用 `TMPDIR` で走らせ、終わったら消す (`$TMPDIR` の中に作ると祖先に T が残るので効かない)
- [x] 後始末をしない test (capabilities / llm-read / entry / launcher / kv / gateway / transport) に `afterEach` で root を `rmSync` する処理を足す (`plugin.test.ts` の `dirs` 方式)
- [x] `$TMPDIR` の既存の `ccmsg-*` 残骸を掃除する (統括)
- [x] 「最初の import のコストが祖先ディレクトリのサイズに比例する」を `called` の性質として docs に残す (本番の config は XDG 配下で祖先が小さいので実害は薄い)

timeout の延長と warm-up は症状を隠すだけなので採らない。
