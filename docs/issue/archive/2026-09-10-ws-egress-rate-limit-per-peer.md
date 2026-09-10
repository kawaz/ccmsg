---
title: 各 WS 終端の送出側に rate limit 層 (現在値 coalesce / event backpressure)
status: resolved
category: task
created: 2026-09-10T15:40:00+09:00
last_read:
open_entered: 2026-09-10T15:40:00+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-09-10T21:45:02+09:00
discard_reason:
pending_reason:
close_reason: ["done: daemon v0.3.4 (2026-09-10 本番反映)", "impl: src/topics/egress.ts の Egress (WS 終端ごとに1 queue、Topics.publish は必ずここを通る = 人/mesh peer/CLI/relay 同一経路)", "folding: granularity whole/per_instance_whole を topic×instance で最新値に差し替え(位置は保つ)", "queue: element/append/event は順序どおり", "throttle: FLUSH_PERIOD_MS=100ms(待たされるframeが出た時だけone-shotでarm)", "limit: QUEUE_LIMIT=256超過でpublishがrate_limitedを返す。notify_send/say_postは暫定internal_error、message_sendはinbox保持{delivered:false,reason:throttled}", "design: DESIGN §6.4", "契約のrate_limited codeは契約issue rate-limited-error-codeが追う"]
blocked_by:
origin: kawaz 指示 (2026-09-10)
---

# 各 WS 終端の送出側に rate limit 層 (現在値 coalesce / event backpressure)

## 概要

本番で bare instance が `agents` / `peers` を ~1 kHz で publish し (0.92 秒で
882 frame)、mesh 経由で全 instance → webui に fan-out して一覧が振動・UI 停止
した事故の再発防止として、各 WS 終端 (人 / mesh peer / gateway) の送出側に
rate limit 層を入れる。原因側の調査は別 findings
`2026-09-10-sessions-topic-storm` (本 issue はその対症でなく再発防止の本体)。

方針は topic の性質で 2 種類に分ける:

1. **現在値 topic** (`peers` / `agents` / `session_status` / `llm_status` 等、
   granularity が whole / per_instance_whole): 最新値だけ残して間引く
   (coalesce)。間隔は 100 ms 程度を目安にするが、根拠を DESIGN に書く。
   情報は落ちない (最新値は必ず届く) 前提を維持する
2. **出来事 topic** (`notify` / `inbox` 等の event): 間引かない。送り手の
   投入側で上限超過時に `rate_limited` を返し backpressure にする
3. **mesh relay も同じ層を通す**: relay の fan-out が今回の事故の半径を
   広げた本体なので、relay 単体での対応漏れを作らない

## 背景

kawaz 指示 (2026-09-10): 本番事故の再発防止。原因側の修正 (sessions/ 監視の
coalesce・値比較) と同じリリースに入れる想定。

## 受け入れ条件

- [ ] `docs/DESIGN-ja.md` に「送出側の上限」の節を追加: topic 種別 (現在値 /
      出来事) × 扱い (coalesce / backpressure) × 数値と根拠を明記
- [ ] backpressure に伴い契約 (ccmsg-protocol) に error code (`rate_limited`
      等) を足す必要があれば、契約リポ側に issue を起票する
- [ ] テスト: 1 kHz で publish しても購読者には 10 frame/s 以下しか届かず、
      かつ最新値は必ず届くことを確認
- [ ] テスト: event topic (`notify` / `inbox` 等) は rate limit 下でも 1 件も
      落ちない (超過時は `rate_limited` を返す) ことを確認
- [ ] テスト: mesh relay 越しでも同じ制約 (coalesce / backpressure) が効く
      ことを確認
- [ ] 原因側の修正 (sessions/ 監視の coalesce・値比較、findings
      `2026-09-10-sessions-topic-storm` 参照) と同じリリースに含める

## 形 (kawaz 2026-09-10: throttle + queue + folding)

WS 終端ごとに「flush 周期付きの出力 queue」を 1 つ持ち、現在値 topic は `topic × instance` を key に最新 1 つへ畳む (folding)、出来事 topic は順序どおり並べる (queue)、flush は周期の上限で行い 1 回で畳んだ現在値と溜まった出来事をまとめて出す (throttle)。queue が溢れるのは出来事側だけで、その時は投入した op に `rate_limited` を返す。mesh relay / 人 / gateway の全終端が同じ層を通る。
