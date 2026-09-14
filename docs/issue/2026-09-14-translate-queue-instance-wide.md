---
title: 翻訳の待ち行列が instance 全体で 1 本なので、無関係なセッションの翻訳が互いを待つ
status: open
category: design
created: 2026-09-14T12:13:47+09:00
last_read:
open_entered: 2026-09-14T12:13:47+09:00
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

# 翻訳の待ち行列が instance 全体で 1 本なので、無関係なセッションの翻訳が互いを待つ

## 概要

`src/translate/translate.ts` の `#queue` は instance 全体の翻訳要求を 1 本の待ち行列に並べる。helper が 1 行 1 答なので直列化自体は必然だが、その代償が無関係なセッション間にも及び、最悪 `MAX_MS` (120 秒) × 待ち行列長のレイテンシになる。この含意は DESIGN に書かれていない。

## 背景

`docs/findings/2026-09-14-blocking-io-audit.md` の調査 (外部の完了待ちの節) で見つかった、instance 全体を1本の待ち行列で塞ぐ既存の設計。`async-io-principle-and-blocking-io-audit` issue は範囲を絞るためこの論点を分離した。

## 決めること

- 行列をセッション (または要求元の接続) 単位に分けて helper を複数持つか、helper を 1 本のまま予算を要求単位で切るか
- helper を増やすなら上限と、増減の契機

## 受け入れ条件

- [ ] あるセッションの長い翻訳 (予算いっぱい) が走っていても、別セッションの短い翻訳がその完了を待たずに返る (test)
- [ ] DESIGN{,-ja}.md の翻訳の節に待ち行列の単位と含意が 1 段落で書いてある

## 関連

- `docs/findings/2026-09-14-blocking-io-audit.md` (外部の完了待ちの節)
- issue `async-io-principle-and-blocking-io-audit` (範囲外として分離)
</content>
</invoke>
