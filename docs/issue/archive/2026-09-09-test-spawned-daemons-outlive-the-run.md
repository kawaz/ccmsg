---
title: テストが spawn した daemon プロセスが実行終了後も孤児で残存する
status: resolved
category: bug
created: 2026-09-09T18:35:28+09:00
last_read:
open_entered: 2026-09-09T18:35:28+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-09-10T13:06:03+09:00
discard_reason:
pending_reason:
close_reason: ["done: test/harness.ts の reapOrphans() で回収 + fail 化 (実機確認済み)", "discarded: daemon 側の自己終了は §8.4 (監督者だけが instance を起こす / daemon run は意図的に管理外) と両立しないため不採用"]
blocked_by:
origin: 自リポ TODO
---

# テストが spawn した daemon プロセスが実行終了後も孤児で残存する

## 概要

本運用と同じホストに、テストが spawn した `ccmsg daemon run $TMPDIR/ccmsg-daemon-*/one` の孤児 (ppid 1) が 5 つ、8 時間以上残っていた (2026-09-09 18:35 JST に pid 指定で停止)。`test/instance.test.ts` の `daemon run` を spawn するケースが、テスト失敗・timeout・`bun test` の中断で子を回収せずに終わる経路がある (CI ログの「killed 1 dangling process」は bun が拾った分で、拾えない分がローカルに残る)。

## 背景

- 実機観測: 対象ホストで `ccmsg daemon run $TMPDIR/ccmsg-daemon-*/one` を cmdline に持つプロセスが 5 個、ppid 1 (孤児化済み) で 8 時間以上生存していた。2026-09-09 18:35 JST に pid 指定で停止した
- テスト側で spawn した子プロセスが、テストの異常終了経路 (失敗 / timeout / `bun test` の中断) で回収されずに残る可能性がある
- CI ログに出る「killed 1 dangling process」は bun のプロセス管理が拾えた分のみで、拾えない分はホストに残置される

## 論点

1. **test helper に終了 guard を入れる**: spawn した子を、テストの終了 (成功・失敗・timeout) に関わらず必ず SIGTERM → SIGKILL で回収する仕組みを `test/instance.test.ts` の spawn helper に入れる (`afterAll` / `process.on("exit")` / 子への `--parent-pid` 監視、等の選択肢がある)
2. **daemon 側の自己終了性**: 「起動元 (監督者、または foreground の親プロセス) が消えたら自分も止まる」性質を daemon 側に持たせられるか。§8.4 の常駐仕様と両立する範囲かの検討が要る。foreground `run` は監督者管理外のため、親の死を検知する根拠 (`--parent-pid` 監視等) が別途必要

## 受け入れ条件

- [ ] `test/instance.test.ts` の `daemon run` spawn 経路で、テストの異常終了時にも子プロセスが残らないことを確認する仕組みが入っている
- [ ] daemon 側の「起動元死亡検知による自己終了」の要否判断 (§8.4 との整合を含む) が記録されている
