---
title: dump と timeline の選択言語を共有する
status: open
category: design
created: 2026-09-11T13:09:08+09:00
last_read:
open_entered: 2026-09-11T13:09:08+09:00
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

# dump と timeline の選択言語を共有する

## 概要

dump と timeline (webui の TL) は「型の階層で item を選ぶ」設計を共有している (kawaz r303m5、2026-09-11)。

方針:

1. 共有するのは「何を選ぶか」= 型 × subject の選択言語 (`--types` の prefix / `-除外` / `@preset` と、TL の型ごとの表示設定) と preset。「どう見せるか」(TL の top/open 2 軸、dump の描画) は各側に残す
2. 具体案: dump の選択子に subject (main/team/sub) を足し、「main では相手 = user、sub では相手 = parent」の in/out を同じ語彙で書けるようにする。config の `dump.presets` を webui の表示 preset としても引けるようにする (契約 `dump.presets.read` は既にある)
3. 作法: dump と TL の一方で新しい論点が出たら、もう一方ではどうするかを横展開して考える (設計時のチェック項目として DESIGN の dump / TL 節に 1 行)

## 背景

dump (`--types` 等の CLI 選択子) と timeline (webui の型ごとの表示設定) は独立に育ってきたが、同じ「型の階層で item を選ぶ」構造を持っている。選択言語を共有すれば、一方で得た知見をもう一方にそのまま持ち込める。

## 受け入れ条件

- [ ] subject (main/team/sub) を選択子の構文にどう載せるか決める (例 `subject:sub` / `@sub`)
- [ ] webui 側が preset を読む時の localStorage 表示設定との優先関係を決める
- [ ] DESIGN の dump / TL 節に「一方で論点が出たらもう一方も検討する」チェック項目を追記する
