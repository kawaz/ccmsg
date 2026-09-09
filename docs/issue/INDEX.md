# Issue INDEX

active な issue の一覧。close 済みは archive/ にあり、ここには載せない。

| date | category | status | slug | 概要 |
|---|---|---|---|---|
| 2026-09-09 | design | open | [codex-plugin-delivery-via-thread-queue](./2026-09-09-codex-plugin-delivery-via-thread-queue.md) | codex plugin: 配送は `codex queue --thread <sid>`、hello でハーネス種別を名乗る |
| 2026-09-09 | design | open | [mesh-tls-trust-root](./2026-09-09-mesh-tls-trust-root.md) | mesh-peer-auth の信頼の根は TLS サーバ証明書 (2 層) だが、daemon の listener... |
| 2026-09-09 | design | open | [sandbox-grant-delivery-path](./2026-09-09-sandbox-grant-delivery-path.md) | sandbox_grant は capability URL を発行するが、`SandboxGrants.find` の呼び... |
| 2026-09-09 | bug | open | [remaining-load-flakes](./2026-09-09-remaining-load-flakes.md) | 負荷下でのみ稀に落ちるテストが 2 件ある (2026-09-09 観測、未対応)。timeout ... |
| 2026-09-09 | bug | open | [cli-peers-greets-as-session-leaves-last-live-row](./2026-09-09-cli-peers-greets-as-session-leaves-last-live-row.md) | `ccmsg peers` は `CLAUDE_CODE_SESSION_ID` (or `--sid`) があると role sess... |

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
