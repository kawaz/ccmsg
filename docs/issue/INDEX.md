# Issue INDEX

active な issue の一覧。close 済みは archive/ にあり、ここには載せない。

| date | category | status | slug | 概要 |
|---|---|---|---|---|
| 2026-09-08 | bug | open | [fs-watch-alone-test-timeout](./2026-09-08-fs-watch-alone-test-timeout.md) | `test/sessions.test.ts` の「the file watch alone carries a change, with the poll too... |
| 2026-09-08 | design | open | [terminal-id-for-unmanaged-classification](./2026-09-08-terminal-id-for-unmanaged-classification.md) | `AgentInfo.terminal_id` を harness の poll では埋めていない (契約は「走っているプロセスの env... |

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
