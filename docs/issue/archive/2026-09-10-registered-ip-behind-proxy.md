---
title: registered_ip/last_used_ip が caddy 越しの構成で空になる
status: resolved
category: design
created: 2026-09-10T12:07:53+09:00
last_read: 2026-09-10T13:37:13+09:00
open_entered: 2026-09-10T12:07:53+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-09-10T13:44:07+09:00
discard_reason:
pending_reason:
close_reason: ["done: entry.trusted_proxies (CIDR) を追加し、接続元が含まれる時だけ X-Forwarded-For を右から読んで最初の非信頼 hop を client ip として採用","done: DESIGN §3.1 に多段 proxy の採り方と「IP は手がかりであって認証材料ではない」旨を明記","done: 契約 1.8.0 で AuthRotateArgs に reason/ip/user_agent を追加、rotate 転送でも発行者の last_refresh に反映","done: CIDR 判定 (v4/v6/境界/mapped)・trusted/untrusted・多段・rotate 転送のテスト追加 (ccmsg v0.2.11)","note: 受け入れ条件が指す source_ips は起票時の古い文で、kawaz 裁定節の entry.trusted_proxies が正 (入口の許可 source_ips とは別項目)"]
blocked_by:
origin: 自リポ TODO
---

# registered_ip/last_used_ip が caddy 越しの構成で空になる

## 概要

credential record の `registered_ip` / `last_used_ip` が、前段に caddy 等の
reverse proxy を置く構成で空になる。daemon から見える接続元は常に
`127.0.0.1` (proxy) であり、DR-0001 §2.2 が意図する「記憶の手がかり」として
の IP を記録できていない。

前段 proxy が付ける `X-Forwarded-For` (caddy は既定で付与) を読めば元の
接続元 IP を復元できるが、無条件に信頼すると forwarded ヘッダは誰でも
書けるため偽装が可能になる。

## kawaz 裁定 (2026-09-10 r292m66)

信頼する前段を CIDR で設定できるようにする: `entry.trusted_proxies: ["127.0.0.0/8", "100.64.0.0/10", …]`。接続元がここに含まれる時だけ `X-Forwarded-For` / `X-Forwarded-Host` / `X-Forwarded-Proto` を信じる (最右の信頼できない値を採る)。`source_ips` (入口の許可) とは目的が違うので別項目。含まれない接続元からの forwarded ヘッダは無視して生の接続元を使う。

## 背景

本番 (personal instance、caddy 8643) で観測 (2026-09-10)。

## 論点

1. **読む条件**: 接続元が `entry.source_ips` (= 信頼する前段) に含まれる時
   だけ `X-Forwarded-For` を読み、それ以外は生の接続元 IP をそのまま使う
   (forwarded ヘッダは誰でも書けるため、無条件採用は不可)
2. **複数段 proxy での採り方**: `X-Forwarded-For` がカンマ区切りで複数値を
   持つ場合、最右の値から「信頼できない (= 自分の信頼する前段リストに
   無い) 最初の値」を採る規則にする (最右決め打ちだと多段構成で誤る)
3. **IP は認証材料ではなく手がかり**: 取り違えても実害は小さいが、偽装
   された値がそのまま record に残ると「記憶の手がかり」として逆効果
   (= 誤った手がかりを本人に提示することになる)。この非対称性 (実害小 /
   手がかりとしての逆効果) を doc に明記する

## 受け入れ条件

- [ ] `entry.source_ips` に接続元が含まれる場合のみ `X-Forwarded-For` を
      信頼して `registered_ip` / `last_used_ip` に採用する
- [ ] 多段 proxy 時の値の採り方 (信頼境界の外側で最初に現れる値) を実装・
      doc 化する
- [ ] IP が認証材料でなく手がかりである旨、偽装時の実害と逆効果の非対称性
      を DR-0001 or 関連 doc に追記する
