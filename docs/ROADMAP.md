# ロードマップ

**やる順に並べた束**と、各行から実体 (issue) への参照。読者は kawaz と AI。

**進捗の正本は issue** なので、ここには状態も経緯も書かない。何がどこまで進んだかは各 issue の frontmatter を見る。

3 リポにまたがる:

| 略号 | リポ | issue の置き場 |
|---|---|---|
| daemon | kawaz/ccmsg (本リポ) | [`./issue/`](./issue/) |
| 契約 | kawaz/ccmsg-protocol | `~/.local/share/repos/github.com/kawaz/ccmsg-protocol/main/docs/issue/` |
| webui | kawaz/ccmsg-webui | `~/.local/share/repos/github.com/kawaz/ccmsg-webui/main/docs/issue/` |

## 束 0 — v1 パリティ (kawaz が v2 に移るために要るもの)

kawaz が v1 の webui を使い続けている理由を潰す束。**契約と daemon は揃っていて、webui だけの作業**。これが他の束より先。画面は全部を移植するのではなく候補で、v1 の形は踏襲しない。試作して意見を聞きながら直し、最後にデザインシステム (束 1 のカラーシステムを色 + 型 + 部品の語彙に広げる) で揃える。

- webui `2026-09-12-first-connect-flow.md` — スマホ初回アクセスの接続・認証導線
- webui `2026-09-12-timeline-width-and-bubble-gutter.md` — TL の幅崩れとバブル左余白
- webui `2026-09-12-composer-enter-newline.md` — Composer の Enter を改行にする
- webui `2026-09-12-v1-parity-for-migration.md` — 候補 9 件 (Usage / クォータ、cache リング + LLM status、翻訳タブ、Status タブの中身、Session Search、Session Launcher、LLM stats、dump ボタン、kill / rename / pinned)

契約 / daemon 側から要る 3 件 (sandbox の配信、Composer の添付、`.code-workspace`) は束 2 に寄せる。

## 束 1 — dump と Timeline

- daemon [`./issue/2026-09-11-dump-raw-jsonl-format.md`](./issue/2026-09-11-dump-raw-jsonl-format.md) — 元 jsonl を型で grep した生の行を出す形
- daemon [`./issue/2026-09-11-dump-timeline-shared-selection.md`](./issue/2026-09-11-dump-timeline-shared-selection.md) — dump と Timeline で選択言語を共有する
- webui `2026-09-11-team-overview-view.md` — teammate 同士の会話を俯瞰する view
- webui `2026-09-11-anchor-snapshot-one-frame-stale.md` — Timeline 遡り読みの錨が 1 フレーム古い
- webui `2026-09-12-color-system-three-layers.md` — v1 で揉み始めた案 (3 層構造 / テーマエディタ) を、v2 で設計の続きから詰める。束 1 と並行してよい

判断の下地は [DR-0006](./decisions/DR-0006-dump-writes-typed-items.md) / [DR-0007](./decisions/DR-0007-classify-by-who-the-conversation-is-with.md)。

## 束 2 — 契約の穴を 1 回の minor でまとめて塞ぐ

個別に minor を切らず、まとめて 1 回で出す。

- 契約 `2026-09-09-inbox-invisible-to-user-and-lacks-tombstone.md` — inbox が user role へ配送されず、要素の削除印も無い
- 契約 `2026-09-09-notification-lacks-mid.md` — Notification に `reply_to` (mid) が無い
- 契約 `2026-09-09-session-status-partial-marker.md` — fold の可視範囲を示す partial マーカー
- 契約 `2026-09-09-file-read-paging-and-external-listing.md` — Files タブの paging と外部ファイル列挙
- 契約 `2026-09-08-say-unread-on-wire.md` — say の未読を wire に載せる
- 契約 `2026-09-10-transcript-snapshot-implies-nothing-about-liveness.md` — snapshot が返ることの意味を契約 DESIGN に明記するか
- ここに束 0 から寄せた 3 件 (sandbox の配信、Composer の添付、`.code-workspace`) が入る

## 束 3 — 認証

- daemon [`./issue/2026-09-12-webauthn-tests-library-grade.md`](./issue/2026-09-12-webauthn-tests-library-grade.md) — 自前 WebAuthn のテストを既存ライブラリ水準まで ([DR-0001](./decisions/DR-0001-passkey-auth-for-people.md) §2.11 の条件)
- 契約 `2026-09-09-passkey-list-for-people.md` — 人が自分の passkey 一覧を保守する op
- 契約 `2026-09-10-token-family-bound-to-endpoint.md` — **裁定待ち**。TokenFamily を mint 時の endpoint に束縛する
- daemon [`./issue/2026-09-09-sandbox-grant-delivery-path.md`](./issue/2026-09-09-sandbox-grant-delivery-path.md) — `sandbox_grant` の URL に配信経路が無い

## 束 4 — 運用の bug

- daemon [`./issue/2026-09-11-daemon-restart-all-leaves-supervisor-on-old-build.md`](./issue/2026-09-11-daemon-restart-all-leaves-supervisor-on-old-build.md) — `restart --all` が監督者を旧 build のまま残す ([DR-0013](./decisions/DR-0013-instances-are-long-running.md) §2.4 が残した未決点)
- daemon [`./issue/2026-09-10-service-stop-wedges-with-sockets-unlinked.md`](./issue/2026-09-10-service-stop-wedges-with-sockets-unlinked.md) — `service stop` が socket unlink 後に wedge する

## 束 5 — docs

- daemon [`./issue/2026-09-10-design-doc-reflow-after-v2-settles.md`](./issue/2026-09-10-design-doc-reflow-after-v2-settles.md) — DESIGN の reflow と DR 起こし
- 契約 `2026-09-10-ecosystem-review-2026-09.md` — 外部レビューの指摘への対応
- 契約 `2026-09-10-schema-library-choice-record.md` — TypeBox 採用の根拠が記録されていない

## 束 6 — 保留 (kawaz)

- **cluster / 権限構造** — 再開する時は権限構造から起票し直す ([DR-0005](./decisions/DR-0005-withdraw-the-cluster-concept.md) §2.1 / §2.2 に用語と論点がある)
- **Codex の hook trust** — trust を install 側が書かない方針のまま、人が承認する導線を用意していない

## 関連

- [decisions/INDEX.md](./decisions/INDEX.md) — 確定した設計判断
- [DESIGN-ja.md](./DESIGN-ja.md) — 今の姿
