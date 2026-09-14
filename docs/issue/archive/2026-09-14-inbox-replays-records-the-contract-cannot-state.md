---
title: inbox が起動時に読み戻した保持レコードを契約で検証せず、人向け view の frame が webui で弾かれる
status: resolved
category: bug
created: 2026-09-14T13:41:07+09:00
last_read:
open_entered: 2026-09-14T13:41:07+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-09-14T13:47:17+09:00
discard_reason:
pending_reason:
close_reason: ["implemented:commit 9163cb56, test/delivery.test.ts","done:保持期限は契約の7日で妥当(9/7→9/14は期限直前)、DESIGN §6.7によりdaemon側の値決め直しは追加なし"]
blocked_by:
origin: 自リポ TODO
---

# inbox が起動時に読み戻した保持レコードを契約で検証せず、人向け view の frame が webui で弾かれる

## 概要

2026-09-14、webui に「契約に合わない frame が届きました: inbox — この画面を再読み込みしてください」が出続けた。原因は personal instance の `inbox.jsonl` に 9/7 のテスト残骸 1 件 (宛先 sid `00000000-0000-4000-8000-00000000c0de`、`mid` が旧形式 `ws://localhost/<dir>/2`) が残っており、契約 1.23.0 の人向け inbox view (`Delivery.snapshot()` の `#waiting()`) がそれをそのまま frame に載せ、webui が契約の `Mid` (`^[0-9a-f]{32}/\d+$`) で弾いたこと。人向け view が入った v0.13.0 から出ていた。対処はその 1 行を除いて personal instance を再起動 (元ファイルは `/tmp` に退避)。

## 背景

`Inbox.load()` は保持ファイルをそのまま内部状態に読み戻しており、契約の schema (`InboxMessage` / `Mid`) による検証を経ていない。旧形式の mid や存在しない宛先 sid を持つレコードが混入すると、`Delivery.snapshot()` がそれをそのまま人向け view の frame に載せてしまい、webui 側の契約チェックで弾かれる。

## 直すこと

- `Inbox.load()` で読み戻したレコードを契約の schema (`InboxMessage` / `Mid`) で検証し、述べられないものは `dropped` (理由は新しい語が要るなら契約に相談) として捨てて log に残す。instance 自身が契約で述べられない値を frame に載せない (DR-0015 の「述べるなら本当のことだけ」と同じ姿勢)
- 宛先 sid が存在しない / 一度も現れないメッセージが無期限に残らないよう、inbox の保持期限 (`#expire()` の条件) を確認する。7 日残っていたので期限が無いか長すぎる
- 契約の mid 形式が変わった時の移行 (旧形式の保持レコードの扱い) を DESIGN §6 に 1 文

## 受け入れ条件

- [ ] 旧形式の mid を含む `inbox.jsonl` で起動しても、人向け inbox view の frame が契約 schema を通る (test: 契約の `Value.Check` で frame を検証)
- [ ] 捨てたレコードが log に残る

## 関連

- `src/messaging/inbox.ts` (`load()` / `#compact()`)、`src/messaging/delivery.ts` (`snapshot()` / `#waiting()`)
- 契約 `src/identifiers.ts` の `Mid`
