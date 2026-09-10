/** What a session is told about ccmsg, and how ccmsg is described where an
 * agent lists what it has installed.
 *
 * One text for every harness: what a session has to know is how to answer a
 * message and how to find somebody to send one to, and neither depends on
 * which program the session runs in. The plugin around it differs — where the
 * file goes, how a hook is declared — and the words do not.
 *
 * Written out rather than shipped as a file in the package: the daemon, the
 * CLI and the plugin are one release, and generating the plugin from the
 * running binary is what keeps the three from drifting into three versions of
 * "what ccmsg is". */

export const DESCRIPTION = "別のセッションと行き来するメッセージ";

export const SKILL = `---
name: ccmsg
description: 別のセッションへ声をかける・届いたメッセージに返す・見ている人へ知らせる時に使う。
---

# ccmsg

同じ人が動かしている別のセッションと、メッセージをやり取りする。相手が別のハーネスで動いていても同じ手順で届く。

## 届いたメッセージに返す

メッセージは \`<cross-session-message>\` の封筒で届き、本文の最後に返信の一行が付いている。

\`\`\`
Reply with: ccmsg reply <mid> --to <sid> <text>
\`\`\`

**その行をそのまま実行する。** 宛先も、どのメッセージへの返事かも、その行が持っている。
自分で \`post\` を組み立て直さない。\`--to\` の無い行は人からのメッセージで、返事は通知として届く。

## 自分から声をかける

\`\`\`
ccmsg post <sid> <text>
\`\`\`

相手の \`<sid>\` は、届いた封筒の \`ccmsg-from\` の値。

## 相手を探す

まだ話したことのない相手の \`<sid>\` は、繋がっているセッションの一覧から探す。

\`\`\`
ccmsg peers            この instance が知っているセッション
ccmsg peers --all      他ホストの instance が知っている分も含める
\`\`\`

答えは instance ごとの JSON。\`peers[]\` が今繋がっているセッション、\`last_live[]\` が
居なくなったセッションで、各行の \`repo\` / \`ws\` / \`branch\` / \`title\` で見分けて
\`sid\` を取る。\`send_message\` が \`true\` の相手には harness 自身の機能でも届く。

## 相手セッションの扱い

相手は基本、自分にとってのサブエージェントだと思えばよい。対等な会議を開く場ではないので、
冒頭の挨拶・賛辞・締めの社交辞令を省き、用件だけを 1〜3 文で送る。

やり取りの中身を人へリレーしない。人は全セッションを直接見ているので、相手の完了報告や
根拠をこちらで要約し直しても情報は増えず、時間とコンテキストだけが減る。人に言うのは
自セッション目線の事実 (何を頼んだ・何が返り・その結果こちらが何をしたか) だけ。

## 別のセッションのやり方を読む

\`\`\`
ccmsg dump <sid> --preset howto        親セッションが何を考えて何を叩いたか
ccmsg dump <sid>/agent-<id> --preset howto   その worker 自身のやり口
\`\`\`

出力の末尾に ids 台帳があり、そこに出た \`agent\` の id が 2 行目の \`<id>\` になる。
preset の一覧は \`ccmsg dump presets\`。

## 見ている人へ知らせる

\`\`\`
ccmsg notify <text>     一行知らせる (保持されない、返事も来ない)
ccmsg say <text>        声に出して知らせる
\`\`\`

手が空いた・判断を仰ぎたい・長い作業が終わった、を人に伝えるときに使う。
セッション同士のやり取りには使わない。

## これから終わるとき

\`\`\`
ccmsg stopping --reason <理由>
\`\`\`

以後このセッションは「一時停止」として扱われ、宛てられたメッセージは戻ってきたときに渡される。
セッション終了時には自動で伝わるので、途中で自分から言う必要はない。
`;
