/** The plugin ccmsg hands to Claude Code, as its files.
 *
 * Written out rather than shipped as a directory in the package: the daemon,
 * the CLI and the plugin are one release, and generating the plugin from the
 * running binary is what keeps the three from drifting into three versions of
 * "what ccmsg is". `install` lays these down and registers them; nothing else
 * writes into a config home.
 *
 * The plugin itself is thin on purpose. Messages reach a session through the
 * harness's own socket, so nothing here listens, polls or holds a connection —
 * the skill says how to speak, and the two hooks say hello and goodbye. */

/** The plugin's name, the marketplace's name, and therefore the id Claude Code
 * knows it by. One word for all three: there is one plugin here and a
 * marketplace that exists only to carry it. */
export const PLUGIN_NAME = "ccmsg";
export const MARKETPLACE_NAME = "ccmsg";
export const PLUGIN_ID = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;

const DESCRIPTION = "別の Claude Code セッションと行き来するメッセージ";

/** How a hook reaches `ccmsg`.
 *
 * Through `PATH`, not through the plugin's own directory: the binary is
 * installed by whoever installs ccmsg, and a plugin that carried its own copy
 * would be a second version of it to keep current. A session whose `PATH` has
 * no `ccmsg` is a session with nothing to say, so the hook leaves without
 * saying it — silently, because a person who has not installed ccmsg has not
 * asked to hear about it at every session start. */
function throughPath(command: string): string {
  return `if command -v ccmsg >/dev/null 2>&1; then ccmsg ${command}; fi`;
}

/** How long a greeting or a departure may take before the harness stops
 * waiting on it. Both are one connection to a socket on this same host, and
 * both give up on their own when there is no instance behind it. */
const HOOK_TIMEOUT_S = 5;

const SKILL = `---
name: ccmsg
description: 別の Claude Code セッションへ声をかける・届いたメッセージに返す・見ている人へ知らせる時に使う。
---

# ccmsg

同じ人が動かしている別のセッションと、メッセージをやり取りする。

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

const HOOKS = {
  hooks: {
    SessionStart: [
      {
        matcher: "startup|resume|clear|compact",
        hooks: [{ type: "command", command: throughPath("hello --hook"), timeout: HOOK_TIMEOUT_S }],
      },
    ],
    SessionEnd: [
      {
        hooks: [
          { type: "command", command: throughPath("stopping --hook"), timeout: HOOK_TIMEOUT_S },
        ],
      },
    ],
  },
};

/** Every file the plugin is made of, by its path under the plugin's root.
 *
 * A string is written as it is; anything else is the content of a JSON file
 * and is serialized by whoever writes it, so this states shapes rather than
 * text and there is one place that turns a value into bytes. */
export function claudePluginFiles(version: string): Map<string, string | object> {
  return new Map<string, string | object>([
    [
      ".claude-plugin/marketplace.json",
      {
        name: MARKETPLACE_NAME,
        owner: { name: "kawaz" },
        metadata: { description: DESCRIPTION, version },
        plugins: [{ name: PLUGIN_NAME, description: DESCRIPTION, source: "./" }],
      },
    ],
    [
      ".claude-plugin/plugin.json",
      {
        name: PLUGIN_NAME,
        description: DESCRIPTION,
        version,
        author: { name: "kawaz" },
        license: "MIT",
        repository: "https://github.com/kawaz/ccmsg",
      },
    ],
    ["skills/ccmsg/SKILL.md", SKILL],
    ["hooks/hooks.json", HOOKS],
  ]);
}
