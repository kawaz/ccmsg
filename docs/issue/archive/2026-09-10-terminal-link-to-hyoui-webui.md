---
title: hyoui 端末セッションに hyoui-webui へのリンクを出す
status: resolved
category: design
created: 2026-09-10T16:11:58+09:00
last_read:
open_entered: 2026-09-10T16:11:58+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-09-10T17:19:52+09:00
discard_reason:
pending_reason:
close_reason: ["done: 契約 1.10.0 (hello に terminal_gateway)、daemon v0.3.1 (config upstream.terminal_gateway を hello で名乗る、pattern 検証)、webui v0.2.9 (一覧の端末リンク + Terminal タブ iframe ?embed=1&resize=1、fab は v2 に浮遊ボタンが無いので落とした)。本番 3 instance に terminal_gateway = hyoui を設定し、kawaz が実機で Terminal タブの動作を確認 (2026-09-10 17:19)。"]
blocked_by:
origin: kawaz 依頼 (2026-09-10)
---

# hyoui 端末セッションに hyoui-webui へのリンクを出す

## 概要

セッションが hyoui の端末で動いている時、webui の一覧とセッション画面に hyoui-webui
の当該端末へのリンクを出す (起動時プロンプトで hook より前に止まっているケース等を
人が端末で対処する導線)。

## 背景

部品の現状: `agents` の行に `terminal_id` / `terminal_namespace` (プロセス環境から
読んだ hyoui セッション ID、`src/sessions/terminals.ts`) が既に載る。足りないのは
飛び先の URL で、これは instance の deployment 事実。

設計 (統括判断):

1. **契約 minor** — hello の応答 (instance 側の自己申告) に `terminal_webui`
   (URL テンプレ、`{terminal_id}` と `{namespace}` を置換) を optional で足す
2. **daemon** — config `upstream.terminal_webui` を読んで hello に載せる
   (`terminal_gateway` とは別。gateway は rename 用の API、webui は人が開く URL)
3. **webui** — `agents` 行に `terminal_id` があり hello に `terminal_webui` が
   あれば、一覧の行とセッション画面ヘッダに端末リンク (新しいタブ) を出す

## 受け入れ条件

- [ ] 契約 publish (hello に `terminal_webui` optional field)
- [ ] daemon: config `upstream.terminal_webui` → hello に反映、DESIGN 日英更新、テスト
- [ ] webui: `terminal_id` + hello `terminal_webui` からリンク描画、テスト、DESIGN 更新
- [ ] 本番 config に personal の `terminal_webui` 値を入れる (hyoui-webui の URL 形式) は kawaz に確認

## v1 の実装 (移植元、kawaz 2026-09-10「v1 が既にやっている」)

旧 claude-ccmsg: daemon config `terminal_gateway_url` (本番値は `https://hyoui.<host>`、絶対 URL のみ受理) → hello 応答 `terminal_gateway_url` → webui が `${base}/sessions/<HYOUI_SESSION_ID>?embed=1&resize=1&fab=right:16,bottom:64,size:51,bg:%233b82f6` を SessionView の Terminal タブ (iframe) に埋める (`packages/webui/src/client/terminal-gateway-store.ts` の `buildTerminalEmbedUrl`、不正 URL / id 無しは Terminal タブ自体を出さない)。rename も同じ gateway 経由。v2 は `upstream.terminal_gateway` (rename 用) と `agents.terminal_id` まで移植済みで、hello への URL 露出と webui の Terminal タブが未移植。設計はテンプレでなく v1 と同じ「base URL + 固定パス `/sessions/<id>`」でよい (hyoui gateway の URL 仕様)。一覧行にはリンク (新規タブ)、セッション画面には Terminal タブ (embed) の両方。
