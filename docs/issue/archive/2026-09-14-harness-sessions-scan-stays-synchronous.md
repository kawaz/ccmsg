---
title: harness.ts の scan() (config home の sessions/ の読み) が同期のまま残っている
status: resolved
category: design
created: 2026-09-14T14:28:13+09:00
last_read:
open_entered: 2026-09-14T14:28:13+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-09-15T12:55:27+09:00
discard_reason:
pending_reason:
close_reason: ["implemented","dr/DR-0015","finding/2026-09-14-blocking-io-audit"]
blocked_by:
origin: 自リポ TODO
---

# harness.ts の scan() (config home の sessions/ の読み) が同期のまま残っている

## 概要

`sessions/harness.ts` の `scan()` (config home の `sessions/` の読み) が同期のまま残っている

## 背景

DR-0015 の監査で群 3 に分類した `src/sessions/harness.ts` の同期 fs (`readdirSync` / `readFileSync` + `JSON.parse`、fs.watch の callback と 5 秒ポーリングから走る) は、fold の作り直し (issue `fold-from-head-with-versioned-cache`) で群 3 を一本化した際に**意図して残した**。理由: `scan()` を async にすると `Sessions.classify()` → `inputs()` → `#own()` が async になり、`message.send` の配送判定・`last_live` の再計算・`peers` / `agents` の行組み立てまで連鎖する。`src/sessions/harness.ts:163-175` のコメントが「どちらも promise を返すと意味が変わる (購読者が居ることが『セッションが存在する』の条件になってしまう)」とこの同期性を意図として書いている。据え置きの根拠はこの意味論だけである — 読む量の小ささは根拠にしない (DR-0015 §3 が量での線引きを採らない)。

## 決めること

- 原則 (DR-0015) に従って async 化するなら、`Sessions.classify()` の同期契約 (存在判定が購読者に依存しない) をどう保つか。案: `scan()` の結果をメモリに持ち、watch / ポーリングが非同期に更新、`classify()` は最新のメモリを同期に読む (読みと判定を分離)
- 残すなら DR-0015 の例外として DESIGN に明記する (「セッションの存在は購読者に依存しない」を同期で保つ、という意味論上の理由で)

## 受け入れ条件

- [ ] どちらの結論でも、`docs/findings/2026-09-14-blocking-io-audit.md` の該当行と DR-0015 / DESIGN の記述が実態と一致する

## 関連

- issue `async-io-principle-and-blocking-io-audit`、`fold-from-head-with-versioned-cache`
- `src/sessions/harness.ts`、`src/sessions/registry.ts` (`classify` / `inputs` / `#own`)
