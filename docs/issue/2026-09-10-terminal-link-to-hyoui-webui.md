---
title: hyoui 端末セッションに hyoui-webui へのリンクを出す
status: open
category: design
created: 2026-09-10T16:11:58+09:00
last_read:
open_entered: 2026-09-10T16:11:58+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
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
