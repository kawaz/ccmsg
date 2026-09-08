---
title: throttled backoff 再送と成功時の held 流し込みが未実装
status: open
category: design
created: 2026-09-09T00:19:04+09:00
last_read:
open_entered: 2026-09-09T00:19:04+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: 2026-09-08 の設計監査 (fable5-high)
---

# throttled backoff 再送と成功時の held 流し込みが未実装

## 概要

`throttled` 状態からの backoff 再送と、経路 (a) 成功時に held メッセージを
流し込む処理が、設計文書 §4.3/§4.4 に書かれているのに実装されていない。

## 背景

2026-09-08 の設計監査で「mesh 前でなくてよい」と判定された所見の一つ。
設計文書は再送・flush の挙動を約束しているが、実装は「再提示は購読時のみ」
になっている可能性がある。設計を実装するか、文書側を実態 (購読時のみ再提示)
に合わせて修正するかの判断が必要。

## 受け入れ条件

- [ ] §4.3/§4.4 の再送・flush 仕様を実装するか、文書を実装に合わせて修正するか判断する
- [ ] 選んだ側で実装 (or 文書修正) を完了する
- [ ] 該当挙動のテストを追加する
