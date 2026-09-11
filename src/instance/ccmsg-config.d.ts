/** 設定ファイル (`config.ts` / `instances/<name>.ts`) が書ける値の型。
 *
 * ccmsg がこのファイルを config home に写すので、設定ファイルからは
 * `import type { Instance } from "../ccmsg-config"` の形で参照できる。
 * 型だけを持ち、他の何も import しないので、tsconfig の無い場所でも解決する。 */

/** ある config home が動かすもの。 */
export type Harness = "claude" | "codex";

/** どこで待ち受け、誰からを受けるか。 */
export interface Entry {
  host: string;
  /** 0 はカーネルに空きポートを選ばせる。 */
  port: number;
  source_ips: string[];
  /** `X-Forwarded-For` を信じる送り元 (CIDR)。 */
  trusted_proxies: string[];
}

/** 起動レシピが読む値 1 つ。 */
export interface LauncherParam {
  name: string;
  default: string;
}

export interface LauncherTemplate {
  name: string;
  command: string;
  params?: LauncherParam[];
  shell?: "bash" | "zsh";
}

export interface Launcher {
  root_dirs: string[];
  /** 並び順のまま答える。先頭が既定のレシピ。 */
  templates: LauncherTemplate[];
  depth?: number;
  timeout_secs?: number;
  clean_env?: string[];
  keep_env?: string[];
}

export interface Upstream {
  gateway_url?: string;
  gateway_webhook_source?: string;
  gateway_webhook_token_file?: string;
  /** 末尾に `/` を付けない base URL。 */
  terminal_gateway?: string;
  launcher?: Launcher;
  /** batch を訳すプログラム。絶対パス。 */
  translate_helper?: string;
  sandbox_origin?: string;
}

/** 名前の付いた dump の選択。`types` は型名・その prefix・`-` 付きの除外・
 * 他の preset を差し込む `@name`。 */
export interface DumpPreset {
  name: string;
  description?: string;
  opts: { types: string[] };
}

export interface Dump {
  presets: DumpPreset[];
}

/** 1 instance 分の設定。`config.ts` が返すのも、`instances/<name>.ts` が
 * `dir` を足して返すのも、これ。
 *
 * mesh の相手はここに書かない。この host の instance は `instances/*.ts` の
 * port から、別 host の endpoint は `peers.json` (`ccmsg mesh add`) から入る。 */
export interface Config {
  harness: Harness;
  /** 無ければ unix socket だけで serve する。 */
  entry?: Entry;
  upstream: Upstream;
  direct_delivery: boolean;
  fork_origin: boolean;
  dump: Dump;
}

/** instance の設定。`dir` (= config home の絶対パス) が instance を決める。 */
export interface InstanceConfig extends Config {
  dir: string;
}

/** `config.ts` が default export する関数。
 *
 * `builtin` は組み込みの既定値で、凍らせてあるので書き換えられない。
 * `config` はそのコピーなので、好きに書き換えて返す。 */
export type Defaults = (ctx: {
  readonly builtin: Readonly<Config>;
  config: Config;
}) => Config | Promise<Config>;

/** `instances/<name>.ts` が default export する関数。
 *
 * `default` は `config.ts` が返した値 (凍結済み)、`config` はそのコピーに
 * `dir` の場所を空で足した物。 */
export type Instance = (ctx: {
  readonly builtin: Readonly<Config>;
  readonly default: Readonly<Config>;
  config: InstanceConfig;
}) => InstanceConfig | Promise<InstanceConfig>;
