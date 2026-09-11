# Issue INDEX

active な issue の一覧。close 済みは archive/ にあり、ここには載せない。

## 他リポへ移した / 他リポと共有の issue

wire の契約は [kawaz/ccmsg-protocol](https://github.com/kawaz/ccmsg-protocol) が正本なので、
契約の変更と daemon の実装が揃わないと閉じない issue は 2 リポに跨がる。正本の置き場は
「先に決まらないと動けない側」に置き、もう一方からはここで参照する。

契約リポに正本があり、決まった後に daemon 側の実装が要るもの
([契約リポの INDEX](https://github.com/kawaz/ccmsg-protocol/blob/main/docs/issue/INDEX.md)):

- `2026-09-10-token-family-bound-to-endpoint` — `TokenFamily` に endpoint が入ると daemon は `admits` に endpoint を渡し、WS upgrade / `auth_refresh` で照合する
- `2026-09-09-session-status-partial-marker` — `SessionStatusSnapshot` の partial マーカーは daemon v2 の fold (末尾 1 MiB seed) の可視範囲を写すもの
- `2026-09-09-inbox-invisible-to-user-and-lacks-tombstone` — `inbox` の user role 配送と削除印。daemon 側は `src/topics/delivery.ts` の sid 絞り込み
- `2026-09-09-notification-lacks-mid` — `Notification` に `reply_to` が入ると daemon は `ccmsg reply <mid>` の mid を `notify_send` へ渡せる
- `2026-09-09-file-read-paging-and-external-listing` — `file_read` の paging と外部ファイル列挙。daemon 側は narrowing と `external_files`
- `2026-09-09-passkey-list-for-people` — 今は daemon の UDS 管理フレーム (`passkey list` / `remove`) にしか無い一覧を user role の op として出すか
- `2026-09-08-say-unread-on-wire` — 未読マークの置き場が決まると daemon は instance 内の `Notify#unread()` を wire に出せる

このリポに正本があり、閉じるのに契約側の判断が要るもの (下の表にも載っている):

## このリポの active issue

| date | category | status | slug | 概要 |
|---|---|---|---|---|
| 2026-09-11 | bug | open | [daemon-restart-all-leaves-supervisor-on-old-build](./2026-09-11-daemon-restart-all-leaves-supervisor-on-old-build.md) | `ccmsg daemon restart --all` は子 instance だけを新コードで起動し直し、launchd 配下の監督者 (`c… |
| 2026-09-11 | design | open | [dump-raw-jsonl-format](./2026-09-11-dump-raw-jsonl-format.md) | `dump` の出力形式を 3 つにする (kawaz r303 m3/m4、2026-09-11): (1) item JSON (現 `--json`… |
| 2026-09-11 | design | open | [dump-timeline-shared-selection](./2026-09-11-dump-timeline-shared-selection.md) | dump と timeline (webui の TL) は「型の階層で item を選ぶ」設計を共有している (kawaz r303m5、20… |
| 2026-09-10 | bug | open | [service-stop-wedges-with-sockets-unlinked](./2026-09-10-service-stop-wedges-with-sockets-unlinked.md) | 本運用 (v0.2.13 監督者 + 3 instance) で `service stop` が socket unlink 後に wedge し、応答は `run… |
| 2026-09-10 | task | open | [design-doc-reflow-after-v2-settles](./2026-09-10-design-doc-reflow-after-v2-settles.md) | `docs/DESIGN-ja.md` / `docs/DESIGN.md` (と契約リポの DESIGN、README-ja) は v2 の構築中に節を足し続… |
| 2026-09-09 | design | open | [sandbox-grant-delivery-path](./2026-09-09-sandbox-grant-delivery-path.md) | sandbox_grant は capability URL を発行するが、`SandboxGrants.find` の呼び... |
| 2026-09-10 | request | wip | [gateway-cache-notice-and-expired](./2026-09-10-gateway-cache-notice-and-expired.md) | llm-gateway v0.45.0 (2026-09-10) の event 追加への追従依頼: cache リングを gateway の「見込み」で… |

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
