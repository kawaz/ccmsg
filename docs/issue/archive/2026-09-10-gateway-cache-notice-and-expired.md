---
title: gateway cache リングを「見込み」でなく実態 (cache_notice/cache_expired/cache) に同期
status: resolved
category: request
created: 2026-09-10T20:13:15+09:00
last_read: 2026-09-11T13:00:46+09:00
open_entered: 2026-09-10T20:13:15+09:00
wip_entered: 2026-09-11T13:02:23+09:00
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-09-11T13:14:45+09:00
discard_reason:
pending_reason:
close_reason: ["done: v0.9.1 で実装 (src/upstream/{events,gateway,requests}.ts): cache_notice を (sid, prefix) ごとに保持、cache_expired.of が一致した時だけ窓を落とす、response の cache=written で応答時刻起点の新しい窓に引き直す、保持中 request の keepalive=applied と応答の written を request_ts で突き合わせて再構築として扱う (response event に keepalive 欄は無い、gateway events.rs で確認)。実 event: 11301/11302 で request 70 本全てに cache_notice、response に cache (partial 68 / written 1) を観測し written の実物で窓の引き直しを確認。cache_expired と applied+written の組み合わせは実 event 未観測 (テストと gateway 側の期待 JSON で裏取り)。本番は v0.9.1 で稼働中"]
blocked_by:
origin: llm-gateway
---

# gateway cache リングを「見込み」でなく実態 (cache_notice/cache_expired/cache) に同期

## 概要

llm-gateway v0.45.0 (2026-09-10) で event 定義に 3 つ追加が入る。ccmsg 側 (cache リング
表示を持つ unit 11301/11302) はこれに追従し、cache リングを gateway の「見込み」でなく
実態に同期させる。

1. `cache_keepalive` (request event) に単回 id **`cache_notice`** (base64url 22 文字、
   keepalive 合図の nonce と同値) が付く。`cache_expires_at` の約束はこの id 付きで発行される。
2. 新 event **`type: "cache_expired"`** `{ts, session_id, prefix, of: <cache_notice>}` —
   gateway が撃ち漏れ (壁時計で期限切れ) に気づいた時とプロセス再起動時に捨てる系列で出す。
   受け側の規則: `(session_id, prefix)` ごとに最新の `cache_notice` を保持し、
   `cache_expired.of` がそれと一致した時だけリングを 0 にする (一致しなければ別 gateway が
   先に延長しているので無視)。
3. `type: "response"` event に **`cache: "hit" | "written" | "partial" | "none" | "unknown"`**
   (応答 usage からの実結果、数値は無し) が付く。`written` は「cache が消えていて全量書き直した」
   ことを意味するので、その時刻を起点に新しい 1h としてリングを描き直す。keepalive の戻りで
   `keepalive: applied` かつ `cache: written` の組み合わせは「延命のつもりが実は再構築だった」
   ケースなので個別に扱う。

正本: llm-gateway `docs/decisions/DR-0012-request-events.md` の「cache の結果は、見込みでは
なく実際を出す」「約束と取り消し」節、MANUAL の event 欄。

## 背景

MBP のサスペンド復帰後に gateway が期限切れ cache へ盲目的に keepalive を撃ち、ccmsg 側の
cache リングが「7 割経過」という実態と乖離した表示をした (kawaz 指摘)。原因は ccmsg 側が
gateway の keepalive 送出を「延命成功」の見込みで描いており、実際に cache が生きているかを
検証していなかったこと。llm-gateway 側が v0.45.0 で「見込みでなく実際」を event で表現する
ようになるので、ccmsg 側もそれを取り込んでリングの正確性を担保する必要がある。

## 受け入れ条件

- [ ] `cache_keepalive` event の `cache_notice` を `(session_id, prefix)` ごとに最新値として
      保持する
- [ ] `cache_expired` event 受信時、`of` が保持中の最新 `cache_notice` と一致する場合のみ
      リングを 0 にリセットする (不一致は無視)
- [ ] `response` event の `cache` フィールドを見て `written` の場合はリングをその時刻起点の
      新しい 1h として描き直す
- [ ] `keepalive: applied` かつ `cache: written` の組み合わせを再構築ケースとして扱う (延命
      成功と誤表示しない)
- [ ] v0.45.0 展開後の実 event (unit 11301/11302 双方) で動作確認する

## TODO

<!-- wip 時のみ -->
