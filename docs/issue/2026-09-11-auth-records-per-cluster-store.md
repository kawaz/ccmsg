---
title: passkey (credential/token family) の保管を instance 複製から cluster 単位へ
status: open
category: design
created: 2026-09-11T14:05:46+09:00
last_read:
open_entered: 2026-09-11T14:05:46+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by: multiple-clusters-per-host (TS config の cluster 構造の確定形)
origin: 自リポ TODO
---

# passkey (credential/token family) の保管を instance 複製から cluster 単位へ

## 概要

passkey (credential / token family) の保管方式を、instance ごとの複製から
cluster 単位 (同ホストの cluster ごとに 1 部、`$CCMSG_STATE_DIR/clusters/<cluster_id>/`
配下) に変える。権限の単位は cluster なので、保管もそこに揃える。

同ホストの n instance が 1 部を共有することで、instance の remove で記録が
消えない、ホスト内で見え方がずれない、`passkey list --cluster X` が
instance 経由でなく読めるようになる。ホスト間の複製は従来通り `auth.records`
の複製 (cluster 内の mesh) のまま変えない。

## 背景

kawaz r303 m20/m21 (2026-09-11) での判断。現状は instance ごとに passkey を
複製しており、instance を remove すると記録が消えたり、同ホスト内の instance
間で見え方がずれたりする問題がある。

## 決めること

1. 複数 instance プロセスの同一ファイル書き込みの排他 (lock + atomic rename)
   と、更新を同ホストの他 instance に伝える手段 (ファイル監視 / 監督者経由)
2. リモートへの複製を誰が流すか — 各 instance がそのまま流し record id で
   重複排除する案を推す
3. 契約 `auth.records` の説明文を「instance の複製」から「ホスト内 cluster
   複製」に変える (型は不変の見込み)
4. `daemon remove` は state dir を消さない (人が消す) を推す

## 受け入れ条件

- [ ] cluster 単位の passkey store のファイルレイアウトと排他方式が決定される
- [ ] 同ホスト内 instance 間の更新伝達手段が決定・実装される
- [ ] リモート複製の送信元方針 (各 instance が流し record id で重複排除) が実装される
- [ ] 契約 `auth.records` の説明文が更新される
- [ ] `daemon remove` が state dir を消さない挙動になっている (または既にそうなっていることを確認)

## TODO

<!-- wip 時のみ -->
