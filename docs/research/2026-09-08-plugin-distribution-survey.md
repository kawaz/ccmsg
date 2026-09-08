# エージェント向け plugin 配布方式の先行事例

ccmsg のエージェント側 (hook / skill) をどう配るか — (A) エージェント固有の marketplace 経由か、
(B) 本体 CLI の `ccmsg plugin install <agent>` で配置するか — を決めるための先行事例調査。
調査日 2026-09-08。推測は「未確認」と明記。

## 結論

- 単一の主流はない。(A) と (B) が併存し、常駐バイナリを持つプロダクトは **binary first + エージェントごとの登録経路** に落ち着いている
- ccmsg に最も近い構造は BioMCP (常駐バイナリ + Claude plugin + Codex `mcp add` + CLI の skill installer)
- installer 型は install / uninstall の**非対称**が実例として起きる (Smithery: MCP remove はあるが skill remove が README に無い)
- `claude plugin marketplace add <ローカル dir>` は公式に可能。第三者 CLI が subprocess でそれを叩いて自己登録する公開実例は未確認
- Codex は remote plugin catalog と Claude Code 同 schema の hooks を持つ (config reference)。lifecycle (install / update / uninstall) の成熟度は未確認

## 事例表

| プロダクト | 方式 | 統合の書き込み先 | 更新経路 | アンインストール | 出典 |
|---|---|---|---|---|---|
| Claude Code plugin system | A | `.claude-plugin/plugin.json` + marketplace.json。local directory source 可 | `marketplace update` と `plugin update` は別段階。install は cache への snapshot、内容変更時は version bump 必須 | `plugin uninstall` / marketplace remove / disable | [plugins](https://code.claude.com/docs/en/plugins.md), [marketplaces](https://code.claude.com/docs/en/plugin-marketplaces.md) |
| Anthropic 公式 marketplace | A | `claude-plugins-official`。skills 単体も `strict:false` + `skills` で公開可 | 標準更新。公開 slug の rename は `renames` map | 標準 | [claude-plugins-official](https://github.com/anthropics/claude-plugins-official) |
| BioMCP | 併用 | binary は install script / `uv tool install` / brew。Claude は marketplace plugin、Codex は `codex mcp add biomcp -- biomcp serve`、skills は `biomcp skill install ~/.claude --force` | binary は `biomcp update`。skills の自動追従は未確認 | binary は `biomcp uninstall`。統合の一括削除は未確認 | [biomcp](https://github.com/genomoncology/biomcp), [marketplace.json](https://github.com/genomoncology/biomcp/blob/main/.claude-plugin/marketplace.json) |
| arxiv-mcp-server | 併用 | `uvx arxiv-mcp-server`。Claude は plugin (MCP + skill)、Codex は `codex mcp add` or Codex plugin marketplace、VS Code / Cursor は deep link | package pin と plugin 更新が別。README が direct MCP と richer plugin を選ばせる | 未確認 | [arxiv-mcp-server](https://github.com/blazickjp/arxiv-mcp-server) |
| Smithery CLI | B | `smithery skill add <skill> --agent claude-code`、`smithery mcp add <url>` | CLI は npm `smithery@latest`。接続先の自動版同期は未確認 | `smithery mcp remove`。skill remove は README で未確認 | [smithery cli](https://github.com/smithery-ai/cli) |
| `claude mcp` | B (公式 writer) | Claude の MCP 設定へ直接登録 (marketplace 非経由) | server が `npx` / `uvx` なら起動時解決 | `claude mcp remove` | [mcp](https://code.claude.com/docs/en/mcp.md) |
| `codex mcp` | B (公式 writer) | `~/.codex/config.toml` / trusted project の `.codex/config.toml` | server 更新と設定更新は別。`enabled=false` で無効化 | config reference 参照 | [codex mcp](https://developers.openai.com/codex/mcp/), [config](https://developers.openai.com/codex/config-reference/) |
| direnv / Starship / zoxide | 生成して評価 | `<tool> init <shell>` の出力を rc が評価 (設定ファイルを恒久編集しない) | CLI upgrade だけで次回から新しい生成結果 | rc の 1 行を削除 | [direnv](https://direnv.net/docs/hook.html), [starship](https://starship.rs/guide/), [zoxide](https://github.com/ajeetdsouza/zoxide) |

## Codex CLI の拡張点 (2026-09、config reference)

- 設定: user `~/.codex/config.toml`、project は trusted project の `.codex/config.toml`。`notify` は user-level のみ
- `notify = [command, ...]`: JSON payload を引数に外部 command を実行 (ccmsg の notify hook に直接対応)
- hooks: `features.hooks` で有効化、`hooks.json` or inline `[hooks]`。Claude Code と同一 schema (PreToolUse / PostToolUse / SessionStart / SessionEnd / Stop / UserPromptSubmit 等)。command と MCP tool handler を支援、prompt / agent handler は skip
- skills: `skills.config = [{ path, enabled }]`、`skills.max_context_tokens`
- MCP: `[mcp_servers.<id>]` に stdio / HTTP
- plugin: `features.remote_plugin` (default on)、`plugins.<plugin>.mcp_servers` override。lifecycle は config reference だけでは未確認
- 出典: [config reference](https://developers.openai.com/codex/config-reference/), [codex docs](https://github.com/openai/codex/tree/main/docs), [skills](https://developers.openai.com/codex/skills/)

## 方式ごとの長所・短所 (実例に基づく)

### A. marketplace / plugin を正本

- 長所: install / update / disable / uninstall、trust consent、version、依存、private repo 認証が標準化。slug rename も `renames` でプラットフォームが migration を持つ
- 短所: marketplace clone 更新と plugin 更新が別操作。plugin は snapshot なので version 据え置きでは更新されない。バイナリを別配布する plugin は二重 lifecycle になる (BioMCP も「binary first, then plugin」の二段導入)

### B. 本体 CLI の install / integrate を正本

- 長所: 同じ binary から skills を配置し、エージェント差は登録 command に吸収 (BioMCP)。複数エージェントと daemon の版を 1 release に束ねやすい。`--force` 等の再配置も本体側で制御
- 短所: 各エージェントの設定 schema / scope / trust / merge / migration / uninstall を CLI 作者が負う。install / remove の片面化が起きやすい (Smithery)

### 併用

- BioMCP / arxiv は direct MCP を「最短経路」、plugin を「richer integration」として意味分離している (同一物の二重配布ではない)
- 懸念: binary / direct 登録 / plugin / copied skill の状態が別々に残りうる。全統合を一括で戻す経路は両者とも未確認

## ccmsg への示唆 (フラグ)

- BioMCP を一次資料として見る価値がある。`ccmsg` binary / daemon が主、hook / skill が従、という責務関係が近い
- marketplace を採るなら plugin は PATH 上の `ccmsg` を呼ぶ thin adapter にする。binary 不在 / 版不整合の診断文言と version negotiation が要る
- `ccmsg plugin install <agent>` を正本にするなら、対称な `status` / `update` / `uninstall`、既存設定の非破壊 merge、自分が書いた変更だけを戻す receipt が要る (Smithery の非対称が確認ポイント)
- 併用するなら責務を明示分離する (CLI = 全エージェント対応 + 整合性、marketplace = Claude 専用の入口)
- Codex は remote plugin を持つので「config.toml 直書きしかない」と固定しない。lifecycle の一次資料を確認してから採否を決める
