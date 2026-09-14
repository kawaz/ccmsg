---
title: IO を伴うイベント / メッセージ処理を非同期にする原則を v2 daemon の DR に起こし、接続後に走る同期 IO を監査して直す
status: open
category: design
created: 2026-09-14T11:56:56+09:00
last_read:
open_entered: 2026-09-14T11:56:56+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: 自リポ TODO
---

# IO を伴うイベント / メッセージ処理を非同期にする原則を v2 daemon の DR に起こし、接続後に走る同期 IO を監査して直す

## 概要

v1 (`claude-ccmsg`) の DR-0029「IO を伴うイベント / メッセージ処理は全て非同期化する」は v2 daemon に持ち越されておらず、daemon DESIGN §6 は「snapshot を空で返さないために seed は購読に答えるターンの内側で同期に読む」と、それと衝突する判断を別の目的から明文化している。kawaz (2026-09-14): 原則は「IO を伴う処理を同期でやらない」。IO を伴わない処理 (メモリ上の情報を返すだけの req/res、`hello.session` / `hello.user` の同期応答など) は同期で構わない。

v1 が実測で問題にした症状 (218 MB transcript の cold scan 中に同一接続の `ping` が 1.15 秒待つ、v1 `docs/findings/2026-09-02-session-status-same-connection-latency.md`) は v2 でも同じ形で起こりうる。

## 背景

daemon v2 の設計・実装が進む中で、blocking IO を接続後のホットパスに置かない原則が明文化されないまま、DESIGN §6 の同期 seed のような個別判断が先行してしまっている。v1 で既に痛みとして観測済みの症状を v2 で再発させないため、原則を DR として固定し、既存コードの同期 IO 箇所を棚卸しする。

## 原則の一文 (kawaz 2026-09-14 確定)

**メモリと CPU だけで完了する処理だけが同期で、それ以外 (ファイル、ネットワーク、プロセス、エージェント応答、承認、lock など外部の完了を待つもの全て) はプロトコルも実装も非同期にする。** CPU だけでも長い処理 (巨大な JSON の parse、大きいファイルの走査) はイベントループを塞ぐので、同期でよいのは短く終わるものに限る。DR の決定文はこの一文を使う。

## やること

1. **DR を起こす** (`docs/decisions/`): 原則 = 「IO を伴うイベント / メッセージ / 購読の処理は async で行い、イベントループを塞がない。メモリだけで答える処理は同期でよい。まとめ処理 (batching / 窓集約) は kawaz の承認なしに入れない」。v1 DR-0029 の決定と追補 (相関 id による同一接続の並行実行) のうち v2 に既にある前提 (`request_id`) は前提として書き、経緯は書かない
2. **DESIGN{,-ja}.md §6 の同期 seed の記述を改める**: 「snapshot を空で返さない」という目的は保ちつつ、同期に読むことでは達成しない。どう達成するかは契約側の CT-Q8 (開始応答で値を述べないまま開くことを契約が許すか) の裁定と issue `fold-from-head-with-versioned-cache` の設計に従う
3. **接続後に走る同期 IO の監査**: CLI 以外の `*Sync(` 146 箇所 (2026-09-14 時点) を「起動時 / 停止時に 1 回だけ走る (同期でよい)」「接続を握った後、イベント / メッセージ / 購読の処理から走る (直す)」に分類して findings に表で残す。まず疑わしいのは `src/transcript/tail.ts` (seed の `readSync` / `#sliceSync`)、`src/transcript/read.ts`、`src/kv/store.ts` (`readFileSync`)、`src/upstream/gateway.ts`
4. 「直す」に分類したものを直す。fold の seed は issue `fold-from-head-with-versioned-cache` の側で直すので、ここでは重複させず参照だけ

## 「IO」の定義 (kawaz 2026-09-14)

原則で言う IO はファイル / ネットワークに限らない。エージェントへの依頼の応答待ち、バックグラウンド実行の結果取得、何かの承認処理の待ちなど、**外部の完了を待つブロッキング待ち全般**を同じ枠組みで IO と呼ぶ。DR ではこの定義で書く。対して、メモリ上の情報を返すだけの req/res は同期でよい。

監査 (やること 3) にもこの定義を適用する: 同期 fs API に加えて、ハンドラが外部の完了 (peer の応答、子プロセス、承認、lock) を待つ間に他の処理を止めている箇所 (接続・topic・instance 単位の直列化、lock の保持中の await、`spawnSync` / `execSync`) を同じ表に載せる。

## 受け入れ条件

- [ ] DR が INDEX に載り、DESIGN §6 に同期 seed の記述が残っていない
- [ ] `docs/findings/` に監査表 (ファイル:行、走る契機、分類、処置) がある
- [ ] 「直す」に分類した箇所の同期 fs 呼び出しが無くなり、`just ci` が通る
- [ ] 大きい transcript (数十 MB 以上) を持つセッションの購読開始中に同一接続の `instance.ping` が待たされないことを test で確認する

## 監査結果と裁定 (2026-09-14)

監査表は `docs/findings/2026-09-14-blocking-io-audit.md`。(C) 71 件、async 化の対象 63 件、連鎖の範囲で 4 群 (file / dir / sandbox 系 op 21、transcript を読む op 24、topic の値を作る経路 12、永続化 13)。群 3 は topic の「値を述べる」入口が Promise を返す形になるので CT-Q8 の裁定と歩調を合わせる。

統括の裁定: `instance/log.ts` の `appendFileSync` は原則通り async 化する (書き込みキューで行の順序を保つ。クラッシュ直前の取りこぼしはログとして許容)。`mesh/keys.ts` の `generateKeyPairSync` は CPU のみ・固定コストなので同期のまま。`auth/records.ts` の dead export `ensureDir` は削除。ユーザ指定正規表現の阻害は async 化で解けないので issue `session-search-regex-unbounded` に分離。

## 外部の完了待ち (監査の追加分、2026-09-14)

findings の「外部の完了待ちで他を止めている箇所」の節。直すのは 3 件で、いずれもハンドラ内で完結し連鎖しない:

- `daemon/supervise.ts` の `#over()` が `--all` の各 config home を逐次 await している(並行にする)
- `messaging/direct.ts` の `sessions/` 走査が 1 件ずつ `await readJson` で deadline も無い(並行 + deadline)
- `messaging/delivery.ts` の `retry()` が sid ごとに独立な `#offer` を逐次 await している(並行にする)

統括の裁定: `translate/translate.ts` の instance 全体で 1 本の翻訳待ち行列(helper が 1 行 1 答なので直列自体は必然、代償が無関係なセッションに及び最悪 `MAX_MS` × 行列長)は本 issue の範囲外。設計の含意として DESIGN の翻訳の節に 1 文書き、行列をセッション単位にするか helper を複数持つかは別 issue `translate-queue-instance-wide` にする。

## 関連

- v1 `~/.local/share/repos/github.com/kawaz/claude-ccmsg/main/docs/decisions/DR-0029-async-io-principle.md`、同 `docs/findings/2026-08-12-blocking-io-audit-full.md` (監査の型)
- issue `fold-from-head-with-versioned-cache`
- 契約 CT-Q8 (`docs/QUESTIONS.md`)
