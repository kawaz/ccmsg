---
title: refresh token (TokenFamily) のサーバ側置き場をストア層で抽象化する
status: open
category: design
created: 2026-09-16T11:57:27+09:00
last_read:
open_entered: 2026-09-16T11:57:27+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: kawaz
---

# refresh token (TokenFamily) のサーバ側置き場をストア層で抽象化する

## 概要

refresh token (TokenFamily の record) のサーバ側の置き場は当面ファイルでよいが、ストア層を 1 枚挟んで DB / キーバリューストアへ差し替えられる形にする。切り口は record の複製単位 (TokenFamily) に合わせる。

## 背景

kawaz 2026-09-16 の指示。CT-Q12 (ブラウザ側の運び方) とは独立で、どの裁定でも同じ形で入る。着手は CT-Q11 / Q12 の daemon 反映と同じ窓でよい。

## 受け入れ条件

- [ ] TokenFamily record の読み書きがストア層のインターフェース越しになっている
- [ ] 当面の実装はファイルベースのまま (DB / KV への差し替えは別途)
- [ ] ストアの分割単位が TokenFamily に一致している
