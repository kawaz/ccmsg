---
title: `session.search` のユーザ指定正規表現が 1 回の `test()` でイベントループを塞ぎ切る
status: open
category: design
created: 2026-09-14T12:07:23+09:00
last_read:
open_entered: 2026-09-14T12:07:23+09:00
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

# `session.search` のユーザ指定正規表現が 1 回の `test()` でイベントループを塞ぎ切る

## 概要

`src/sessions/search.ts:144-163` は `regex: true` の検索でユーザ指定の正規表現を各レコードに `matcher.test(text)` で当てる。`CLAUSE_BUDGET_MS` (2000 ms) の予算は `test()` の呼び出しの合間にしか効かず、1 回の `test()` は最後まで塞ぐ (コード中のコメントに `[a-z]+ing` で 86 秒かかった実測がある)。JS の RegExp には打ち切りが無いので、読みを非同期にしても (issue `async-io-principle-and-blocking-io-audit`) この阻害は残る。塞がれている間は全接続の処理が止まる。

## 背景

`docs/findings/2026-09-14-blocking-io-audit.md` の同期 fs API 以外のイベントループ阻害の節、および issue `async-io-principle-and-blocking-io-audit` の調査で見つかった。

## 決めること

- worker / 子プロセスに追い出して予算超過で kill するか、パターンを制限する (長さ・ネストした量指定子の禁止・固定文字列への降格) か、その両方か
- 制限するなら契約のエラー (`bad_request` の理由) をどう述べるか

## 受け入れ条件

- [ ] `[a-z]+ing` 相当のパターンで数十 MB の transcript を検索しても、同一 instance の `instance.ping` が予算 (2 秒) を超えて待たされない (test)
- [ ] 予算超過時の応答が契約の語彙で「何が超えたか」を述べる

## 関連

- `docs/findings/2026-09-14-blocking-io-audit.md` (同期 fs API 以外のイベントループ阻害の節)
- issue `async-io-principle-and-blocking-io-audit`
