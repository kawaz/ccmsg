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

- [transcript-topic-snapshot-vs-read-asymmetry](./2026-09-09-transcript-topic-snapshot-vs-read-asymmetry.md) — snapshot と `transcript_read` の解決経路の非対称は契約 (DESIGN) 側の意味論として書くかを決める
- [hello-drops-transcript-path-silently](./2026-09-09-hello-drops-transcript-path-silently.md) — 受理しなかったフィールドの理由を hello 応答に載せる契約拡張が論点の 1 つ
- [codex-plugin-delivery-via-thread-queue](./2026-09-09-codex-plugin-delivery-via-thread-queue.md) — hello (SessionMeta) にハーネス種別 or 配送能力を載せる部分は契約側の変更

## このリポの active issue

| date | category | status | slug | 概要 |
|---|---|---|---|---|
| 2026-09-09 | design | open | [codex-plugin-delivery-via-thread-queue](./2026-09-09-codex-plugin-delivery-via-thread-queue.md) | codex plugin: 配送は `codex queue --thread <sid>`、hello でハーネス種別を名乗る |
| 2026-09-09 | design | open | [mesh-tls-trust-root](./2026-09-09-mesh-tls-trust-root.md) | mesh-peer-auth の信頼の根は TLS サーバ証明書 (2 層) だが、daemon の listener... |
| 2026-09-09 | design | open | [sandbox-grant-delivery-path](./2026-09-09-sandbox-grant-delivery-path.md) | sandbox_grant は capability URL を発行するが、`SandboxGrants.find` の呼び... |
| 2026-09-09 | design | open | [transcript-topic-snapshot-vs-read-asymmetry](./2026-09-09-transcript-topic-snapshot-vs-read-asymmetry.md) | `transcript:<sid>` topic と `transcript_read` の見つけ方が非対称。`Transcript... |
| 2026-09-09 | bug | open | [cli-peers-greets-as-session-leaves-last-live-row](./2026-09-09-cli-peers-greets-as-session-leaves-last-live-row.md) | `ccmsg peers` は `CLAUDE_CODE_SESSION_ID` (or `--sid`) があると role sess... |
| 2026-09-09 | bug | open | [hello-drops-transcript-path-silently](./2026-09-09-hello-drops-transcript-path-silently.md) | hello で境界外の transcript_path が黙って捨てられ、送り手に理由が返らない。... |

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
