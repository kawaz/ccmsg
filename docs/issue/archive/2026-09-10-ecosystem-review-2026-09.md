---
title: エコシステム外部レビュー (2026-09) の指摘への対応検討
status: resolved
category: task
created: 2026-09-10T14:46:04+09:00
last_read:
open_entered: 2026-09-10T14:46:04+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-09-10T15:14:59+09:00
discard_reason:
pending_reason:
close_reason: ["done:採用済み7(C-4,C-5,C-6,P-35,P-24,BE-BS,trusted_proxies)","done:採用1(C-3はdesign-doc-reflow-after-v2-settlesの受け入れ条件に追加、新規起票なし)","discarded:却下2(P-23,P-43)","pending:裁定待ち2(C-1=契約リポissue、C-4配置=dump-sidechain-rows-placement)","done:P-45は既にgreen規範を満たす","done:P-12/14/15/16/27/28/30/31/32/34/48は反映先rules-personalで本リポ作業なし"]
blocked_by:
origin: kawaz 依頼 (2026-09-10、claude-rules-personal セッション経由)
---

# エコシステム外部レビュー (2026-09) の指摘への対応検討

## 概要

外部レビューで本リポ (ccmsg) 向けの指摘が出た。以下 2 ファイルを読んで対応を検討する。

- 個別ファイル: claude-rules-personal の `docs/research/2026-09-10-ecosystem-review/ccmsg.md`
- 共通ファイル: claude-rules-personal の `docs/research/2026-09-10-ecosystem-review/common.md`

## 背景

kawaz からの依頼 (2026-09-10、claude-rules-personal セッション経由)。レビューは初版の指摘から個別プロジェクトの精読を進めるたびに認識が改まり、指摘が覆されたケースが多い。**全面的に鵜呑みにせず実物と照合してから採否を決めること**。「裁定待ち」項目は kawaz の判断が要る。対応タイミングは担当セッションまたは kawaz に任せる。

## 受け入れ条件

- [x] 個別ファイル・共通ファイルの指摘を実物 (本リポのコード・DR・issue) と照合する
- [x] 各指摘について採用 / 却下と理由を判定する (裁定が要るものは「裁定待ち」として明示)
- [x] 採否の結果を本 issue に追記して close する

## 採否 (2026-09-10 判定)

判定の根拠は全て本リポの実ファイルと `git log` で確認したもの。commit は短縮 SHA。

### 個別ファイル (ccmsg.md)

| ID | 要旨 | 判定 | 根拠 |
|---|---|---|---|
| C-1 | 設計中の契約に semver minor を連打しない。ccmsg 側の依存は exact pin に | 裁定待ち + 一部採用済み | ccmsg 側の責務である依存 pin は `package.json` の `"@ccmsg/protocol": "1.9.0"` で範囲指定なしの exact pin 済み。版付け方針そのものは契約リポの決定事項で、ccmsg-protocol 側にも同じレビュー issue が起票済み (契約リポ `a82097f`)。裁定: 1.x を続けるか、v2 確定まで 0.x / 1.0.0-alpha.N に戻すか |
| C-2 | (レビュー側で取り下げ) | 判定対象外 | ccmsg.md 上で「削除」と明記されている |
| C-3 | DESIGN-ja.md / DESIGN.md の hard-wrap を reflow する | 採用 (未着手) | 既存 issue `design-doc-reflow-after-v2-settles` は「追記順の構成を読める順序に並べ替える」ことだけを扱っており、hard-wrap の解消がスコープに入っていない (指摘と既存 issue のずれ)。実物は `docs/DESIGN-ja.md` `docs/DESIGN.md` とも文中改行が残る。同 issue の受け入れ条件に hard-wrap 解消を追加する形で拾う (新規 issue は立てない。着手条件・対象ファイル・日英同時更新の要件が完全に重複するため) |
| C-4 | sidechain (subagent) を dump にどう出すかを決め、実機の保存形式を findings に残す | 採用済み | findings `2026-09-10-transcript-sidechain-format.md` (`daf2978`、実 transcript 3 session + 全体走査 330 project の実測)、issue `dump-sidechain-rows-placement` (`e0acf0b`) が (a) 畳む / (b) Agent の子として 1 段インデント / (c) 除外 の 3 案と推奨 (b) を持つ。裁定待ち |
| C-5 | テストが spawn した daemon の孤児を harness が始末し、残存を fail にする | 採用済み | `b53e902` (v0.2.8)。`test/harness.ts` の `reapOrphans()` が SIGTERM → 猶予 → SIGKILL で残存を停止して名前を返し、残っていた run を fail にする。issue `test-spawned-daemons-outlive-the-run` は `9000cd3` で archive |
| C-6 | 「instance は対等、セッション間は優劣付き」を DESIGN の前提に書く | 採用済み | DESIGN-ja §2 の前提表 A7 (`a298ec6`)。会話規約側は plugin の skill に (`a6029b5`) |

### 共通ファイル (common.md) のうち ccmsg に当たる項

| ID | 要旨 | 判定 | 根拠 |
|---|---|---|---|
| P-35 | 契約リポの fixture を実装リポのテストが読む (期待値 JSON を写さない) | 採用済み | `6307b02` (v0.2.13)。`test/frames.ts` が `@ccmsg/protocol/fixtures` の `OP_FIXTURES` / `FIXTURE_IDS` から request frame と id を組み立て、実装側に wire のリテラルを持たない |
| P-45 | green の規範 (全 fixture を回す / 抜き取り不可 / spec を pin) | 採用済み | `test/dispatch.test.ts` の「the fixtures」と M1 の sweep が `OP_NAMES` 全件を回しており抜き取りがない。契約は exact pin (C-1 参照)。規範の明文化は反映先が rules-personal の reference なので本リポの作業ではない |
| P-24 | 書き込みは temp + rename の atomic write | 採用済み | `src/messaging/inbox.ts` の compaction が `<file>.<pid>.tmp` へ書いてから rename、`src/files/files.ts` の置換も同型。複数ファイル all-or-nothing に当たる書き込みは本リポに無い |
| P-23 | 外部コマンドに渡すユーザ由来の値の `-` 始まり | 却下 (該当なし) | 外部コマンド起動は全て argv 配列で shell を経由しない (`src/service/service.ts` の launchctl / systemctl、`src/plugin/install.ts` の claude、`src/greeting/meta.ts` の git、`src/launcher/spawn.ts`)。ユーザ由来値を argv に載せる箇所が無い (git は固定の `rev-parse --show-toplevel --abbrev-ref HEAD`、claude は install が組む固定引数、launcher の argv は運用者自身の config テンプレ = 信頼境界内) |
| P-43 | UDS の接続元をプロセスツリー遡上で認証する | 却下 | DESIGN §2 の前提 A4 が「daemon・セッション・webui の利用者は単一 uid、権限分離はしない。境界は UDS の 0600 と config home に委ねる」と明記しており、採用は前提の変更を要する。レビュー自身も「A4 より強い境界が要る時の選択肢」と位置付けている |
| BE / BS | passkey の authData flags (backup eligible / backup state) を登録時・認証時に記録する | 採用済み | `dce2257` (v0.2.10) が authenticator の申告した backup 可否を登録に残す。契約側は 1.7.0。なお BE / BS はレビューの 2 ファイル (ccmsg.md / common.md) には ccmsg 向けの項として存在せず、出所は canddy-app-proxy.md と claude-rules-personal.md |
| trusted_proxies | proxy 越しの登録 IP | 採用済み | `a517a21` (v0.2.11)。issue `registered-ip-behind-proxy` は `e8e4a91` / `b04b1cb` で archive |
| P-12 / P-14 / P-15 / P-16 / P-27 / P-28 / P-30 / P-31 / P-32 / P-34 / P-48 | ccmsg / claude-ccmsg 由来の形を横断 knowledge にする | 本リポの作業なし | いずれも「出所 = ccmsg、反映先 = rules-personal の reference / rule」のバックポート候補で、本リポ側には既に実体がある (P-14 は §11.3 の M1〜M6 テスト、P-15 は §1.3、P-34 は `instance.ts` の clock 注入、P-48 は `config.ts` の `session_launcher`)。反映作業は rules-personal の担当 |

### 裁定待ちの一覧

- C-1: `@ccmsg/protocol` の版付けを 1.x のまま続けるか、v2 確定まで 0.x / 1.0.0-alpha.N に戻すか (実施は契約リポの issue が持つ)
- C-4: dump における subagent 発話の配置を (a) 統括の turn に畳む / (b) Agent 呼び出しの子として 1 段インデント (推奨) / (c) 除外 のどれにするか (issue `dump-sidechain-rows-placement` が持つ)
