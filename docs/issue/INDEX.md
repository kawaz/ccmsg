# Issue INDEX

active な issue の一覧。close 済みは archive/ にあり、ここには載せない。

| date | category | status | slug | 概要 |
|---|---|---|---|---|
| 2026-09-09 | bug | open | [misc-hardening-findings](./2026-09-09-misc-hardening-findings.md) | 2026-09-08 の設計監査で指摘された、個別 issue を立てるほどではないが放置すべきでな... |
| 2026-09-09 | bug | open | [last-live-session-model-effort-contract](./2026-09-09-last-live-session-model-effort-contract.md) | `LastLiveSession.model` / `.effort` は「transcript の最後の turn から読... |
| 2026-09-09 | bug | open | [instance-ping-network-status](./2026-09-09-instance-ping-network-status.md) | `InstancePingResult.network` が常に `unknown` を返し、`NetOnlineEvent`... |
| 2026-09-09 | design | open | [mesh-tls-trust-root](./2026-09-09-mesh-tls-trust-root.md) | mesh-peer-auth の信頼の根は TLS サーバ証明書 (2 層) だが、daemon の listener... |
| 2026-09-09 | design | open | [sandbox-grant-delivery-path](./2026-09-09-sandbox-grant-delivery-path.md) | sandbox_grant は capability URL を発行するが、`SandboxGrants.find` の呼び... |
| 2026-09-09 | design | open | [gateway-webhook-session-scope](./2026-09-09-gateway-webhook-session-scope.md) | gateway webhook が受け取る `session_id` が config home 単位でスコープされて... |
| 2026-09-09 | design | open | [daemon-invented-limits-contract-promotion](./2026-09-09-daemon-invented-limits-contract-promotion.md) | daemon 実装が独自に決めている上限値 (`TITLE_MAX` / `READ_LIMIT` / `transcri... |
| 2026-09-09 | task | open | [design-doc-additions](./2026-09-09-design-doc-additions.md) | 2026-09-08 の設計監査で「実装済みだが設計文書に反映されていない」と指摘された項目をまとめて設... |
| 2026-09-09 | task | open | [test-strengthening-findings](./2026-09-09-test-strengthening-findings.md) | 2026-09-08 の設計監査で指摘されたテスト設計上の弱点: |
| 2026-09-08 | bug | open | [fs-watch-alone-test-timeout](./2026-09-08-fs-watch-alone-test-timeout.md) | `test/sessions.test.ts` の「the file watch alone carries a change, with the poll too... |

<!--
INDEX の列構成・canonical 順序・行形式の唯一の正本:

- 列構成は固定 (= 上記 5 列、列名と順序を変えない)
- 行の {{rows}} は active issue の行に置換する
- canonical 順序:
  1. status 優先順: idea → open → wip → blocked → pending-sublimation
  2. 同 status 内は date 降順 (= 新しい起票が上)
- 各行: `| YYYY-MM-DD | <category> | <status> | [<slug>](./YYYY-MM-DD-<slug>.md) | <本文 1 行目から 80 文字以内> |`
- 概要は 80 文字を超えたら末尾を「…」で省略
-->
