# 設定ファイルのフィールド別マージ方針

> 撤去済み。ここで決めた field 別マージ規則は実装に入らず、設定は TypeScript に移った (現行は DESIGN §8.2)。

- Date: 2026-09-10
- Status: Concluded

## 動機

ccmsg の共有設定は `defaults` と `instances[]` の二段構成を持つ。共通値と instance 差分を管理しやすく保ちながら、object、配列、削除を一律の shallow merge または deep merge に押し込めず、フィールドごとの事情を宣言できる設計を探る。

## 調査範囲

ccmsg の `src/instance/config.ts` と `docs/DESIGN-ja.md` にある現行規則を照合し、設定や patch のマージ規則を持つ既存方式を公式仕様・公式文書で比較した。候補設計の実装、既存 config の変更、本番 instance の操作は行っていない。

## 調査メモ

### 2026-09-10: ccmsg の現状

`settingsFor()` は `return { ...shared.defaults, ...entry?.settings }` で合成する。spread はトップレベルだけなので、現状は shallow merge である。その後、合成済み object 全体を `parseConfig()` が検証し、未指定のトップレベル項目には組み込み既定を適用する。

| 対象 | `defaults` にあり instance にない | instance に同名フィールドがある | instance 側で一部の子だけを書く場合 | 配列 |
|---|---|---|---|---|
| `harness`、`direct_delivery`、`fork_origin` | `defaults` を継承 | scalar 全体を置換 | 該当なし | 該当なし |
| `entry` | object 全体を継承 | `entry` object 全体を置換 | `defaults.entry` の子は継承しない。instance の `entry.port` は必須、`host` は `127.0.0.1`、`source_ips` と `trusted_proxies` は空配列という parser の既定になる | `source_ips` と `trusted_proxies` は指定配列で全置換 |
| `upstream` | object 全体を継承 | `upstream` object 全体を置換 | `defaults.upstream` の他の upstream や `launcher` は継承しない | `launcher.root_dirs`、`templates`、`clean_env`、`keep_env` は指定配列で全置換 |
| `peers` | 配列全体を継承 | 配列全体を置換 | 該当なし | 全置換。追加・集合和・key merge はしない |
| instance が `instances[]` にない | `defaults` を使用 | 該当なし | 該当なし | `defaults` の規則どおり |

`docs/DESIGN-ja.md` §8.2 は `instances[].<key>` → `defaults.<key>` → 組み込み既定という「項目」の優先順位を明記している。ただし `<key>` がトップレベルのキーであること、object を再帰マージしないこと、配列を全置換することは明記していない。実装コメントの “key by key” も粒度を明確にはしていない。

### 2026-09-10: 先行事例

| 方式 | 規則の所在 | object / 配列 | 削除 | 利用者が規則を知る手段 | ccmsg への示唆 |
|---|---|---|---|---|---|
| Kubernetes strategic merge patch | API 型定義の `patchStrategy` / `patchMergeKey` と、それを公開する OpenAPI の `x-kubernetes-patch-*` | object は field ごと。list は schema 指定により replace または merge-key 単位。指定なしの list は replace | patch 値側の `$patch: replace` / `$patch: delete` | API reference、OpenAPI schema、patch 文書の directive | schema 側の既定と値側の局所 override を分離できるが、ccmsg には directive が重い |
| Kubernetes structural schema / Server-Side Apply | OpenAPI schema の `x-kubernetes-list-type: atomic | set | map`、map の `x-kubernetes-list-map-keys` | `atomic` は全置換、`set` は要素集合、`map` は指定 key 単位 | field ownership と apply による不在化。単純な config merge の削除記法ではない | CRD schema と OpenAPI | 配列規則を schema に置く直接的な先例。`replace | set | keyed` の語彙が有用 |
| JSON Merge Patch, RFC 7396 | patch 形式そのもの。フィールド別 schema は持たない | object は再帰マージ。配列を含む非 object は全置換 | object member の `null` | media type `application/merge-patch+json` と RFC | 小さく予測可能。ただし `null` を実値にできず、全 object deep merge は field の意味を無視する |
| JSON Patch, RFC 6902 | 値側の operation と JSON Pointer path | `add` / `remove` / `replace` 等を path 単位で逐次適用。配列 index と `-` を操作可能 | `remove` operation | media type `application/json-patch+json` と operation 一覧 | 正確だが、人が日常編集する defaults + 差分 config としては冗長で index が壊れやすい |
| Helm values | coalesce 実装と公式 values guide。利用者は値側に通常の YAML を書く | nested map は key 単位で合成。list の部分 merge を宣言する schema はない | override 値の `null` で default key を除去 | values guide、`helm get values` 等の最終値表示 | JSON Merge Patch に近く簡単だが、field ごとの配列規則を宣言できない |
| systemd unit drop-in | unit directive ごとの parser semantics。drop-in は path / 名前順で重ねる | scalar は後勝ち。list 型 directive は反復代入で追加するものがあり、規則は directive ごと | list 型 directive は空代入 `Key=` で既存値を reset できるものがある | 各 directive の man page と `systemctl cat` | フィールド別規則と明示 reset は分かりやすい。規則が文書だけに散ると機械検査しにくい |
| CUE | 値・schema を同じ constraint として unify | 一方的な後勝ちでなく、両方を満たす値だけが成立。list の開閉や制約も型に現れる | optional field や comprehension 等で表現するが、一般的な delete directive ではない | schema 自体、`cue eval` / `cue export` | 強力だが、既存 JSON config の上書きモデルを constraint 言語へ変えるのは責務過剰 |
| Jsonnet | 値側の object inheritance、`+` / `+:` 等 | object field は既定で置換し、`+:` で nested object を加算的に継承できる。array の `+` は連結 | field visibility や object 構成で除外。共通 delete directive はない | 言語仕様と評価結果 | call site が field ごとに演算子を選べるが、設定がプログラムになり評価複雑性を持ち込む |
| NixOS module system | option schema の型が merge を定め、値側に `mkDefault` / `mkForce` / `mkOverride` / `mkMerge` | list 型は連結、unique 型は競合、型ごとの merge。優先度の低い定義は捨ててから同優先度を merge | 一般的な delete より、優先度で採用定義を選ぶ | option declaration、生成ドキュメント、評価済み config | 「schema 側の型別 merge + 値側の明示 override」の完成形だが、ccmsg には優先度階層が過剰 |
| Git `.gitattributes` の `merge=` | path pattern 側で merge driver 名を選び、driver 実装は Git config | ファイル全体を指定 driver に渡す。JSON 内の field / array semantics は driver 次第 | driver 次第 | version 管理された `.gitattributes` と `git check-attr` | 規則を対象 path に結びつける先例。ただし ccmsg は単一文書内の field path を扱うので schema table の方が近い |
| OpenAPI / JSON Schema | OpenAPI の `x-*` と JSON Schema の拡張 keyword を application が定義可能。一般標準の config merge keyword はない | 標準 schema keyword は検証・注釈であり、merge 動作は規定しない。Kubernetes の `x-kubernetes-*` は Kubernetes 固有 | application 固有 | schema と生成ドキュメント。ただし consumer が拡張を理解する必要がある | ccmsg 固有の `x-ccmsg-merge` は可能だが、schema を外部公開しない段階なら TypeScript 側の同等 table で十分 |
| 点区切り CLI key | Helm `--set a.b=value` や Traefik の階層化 option など、CLI parser が path として解釈 | 深い leaf を直接置換できる。配列は index / list 構文または製品固有 | 製品固有。多くは delete より明示値の設定 | `--help`、reference、生成済み config | 保存形式の merge 規則ではなく指定経路。将来 CLI override を足す場合も、保存 config の semantics とは分けるべき |

一次資料から見える共通点は、「汎用 deep merge」一つに集約するより、schema / directive ごとに list の意味を定める方式が成熟していることである。特に list は sequence、set、keyed collection のどれかで意味が異なり、構文上すべて array であることから規則を導けない。

### 2026-09-10: ccmsg 向け候補

#### 推奨: schema 側のフィールド別規則

ccmsg の config schema と同じ場所に、field path ごとの merge policy を置く。object は既定 `merge`、scalar と array は既定 `replace` とし、例外だけを宣言する。現時点では `peers` も「全 instance に同じ完成済み一覧を配る」という設計なので `replace` が自然であり、安易に集合和へ変えない。

概念例:

```ts
const MERGE_POLICY = {
  entry: "merge",
  upstream: "merge",
  "upstream.launcher": "merge",
  peers: "replace",
  "entry.source_ips": "replace",
  "entry.trusted_proxies": "replace",
  "upstream.launcher.root_dirs": "replace",
  "upstream.launcher.templates": "replace",
  "upstream.launcher.clean_env": "replace",
  "upstream.launcher.keep_env": "replace",
} as const;
```

現行の運用形を保つ例:

```json
{
  "defaults": {
    "peers": [
      "https://instance-a.example.test/",
      "https://instance-b.example.test/"
    ]
  },
  "instances": [
    {
      "dir": "/config/home/a",
      "entry": { "host": "127.0.0.1", "port": 8643 }
    },
    {
      "dir": "/config/home/b",
      "entry": { "host": "127.0.0.1", "port": 8644 }
    }
  ]
}
```

この規則なら、将来 `defaults.entry` に `trusted_proxies` を置き、instance 側で `entry.port` だけ変えても、object は field 単位で合成される。一方、instance が `trusted_proxies: []` と書けば配列全体を明示的に空へ置換できる。`null` を delete sentinel にせず、空配列と未指定を自然に区別できる。

利点は、規則が parser / validator と同じ schema の責務にあり、DESIGN や生成 schema に同じ情報を載せられること、`daemon status` が effective config と各 field の source (`builtin` / `defaults` / `instance`) を表示できることである。懸念は、手書き table と型定義がずれる可能性であり、実装時には schema 定義から merge、validation、文書用 metadata を同じ正本として導く必要がある。

#### 候補 2: instance 側の明示 operation wrapper

通常値は現在どおり replace とし、必要な field だけ `{ "$merge": ... }`、`{ "$replace": ... }`、`{ "$delete": true }` のような値側 directive を許す。

```json
{
  "defaults": {
    "peers": ["https://instance-a.example.test/", "https://instance-b.example.test/"],
    "entry": { "host": "127.0.0.1", "trusted_proxies": ["127.0.0.1/32"] }
  },
  "instances": [
    {
      "dir": "/config/home/a",
      "entry": { "$merge": { "port": 8643 } }
    }
  ]
}
```

規則が override 箇所に見える利点がある。一方、通常の config 値と operation language が混ざり、全 field で wrapper validation が必要になる。日常的な object 差分のたびに `$merge` を書くなら二段 config の簡潔さを損なうため、第一候補にはしない。

#### 候補 3: flat path overrides

instance 差分を JSON Pointer または dot path の map にする。

```json
{
  "defaults": {
    "peers": ["https://instance-a.example.test/", "https://instance-b.example.test/"]
  },
  "instances": [
    {
      "dir": "/config/home/a",
      "overrides": {
        "entry.host": "127.0.0.1",
        "entry.port": 8643
      }
    }
  ]
}
```

leaf の置換は曖昧でなく、差分だけが並ぶ。ただし autocomplete と JSON schema が弱くなり、rename が文字列置換になり、object 全体や配列をどう操作するかには別の operation が要る。CLI の一時 override には適するが、人が保守する正本 config には推奨しない。

## 暫定的な結論

推奨は、schema 側で field path ごとの merge policy を持つ方式である。object は再帰的に field 単位で merge、scalar と配列は replace を基本とし、配列を set / keyed collection として扱う必要が生じた field だけ schema に例外を宣言する。これは Kubernetes と NixOS module system が示す「型・schema が意味を知る」方向に沿いながら、値側 directive や優先度付き定義を ccmsg へ持ち込まない小さい設計になる。

`peers` は現状 replace のままがよい。全 instance に同じ完成済み一覧を配るというドメイン上の意味があり、集合和にすると instance が既定 peer を外せなくなる。将来、差分追加が本当に必要になった場合だけ `set` policy と、明示的な replace / remove 操作を一緒に設計すべきである。

DESIGN には少なくとも、マージ単位が top-level か再帰 field か、各配列が replace / set / keyed のどれか、未指定・空配列・`null` の意味を表で明記する必要がある。`daemon status` は effective config を出すだけでなく、可能なら各値の由来も表示すると規則を実機で確認できる。

## kawaz に判断してほしいこと

1. object の既定を recursive field merge に変え、配列は replace のままとするか。
2. `peers` は完成済み一覧として replace を維持するか、将来の set merge を今回から設計するか。
3. 削除 sentinel は当面導入せず、未指定と空値で足りない具体例が出た時に operation を追加する方針でよいか。

## 関連

- `src/instance/config.ts` の `settingsFor()`、`parseConfig()`、`entryOf()`、`upstreamOf()`
- `docs/DESIGN-ja.md` §8.2
- [Kubernetes: Update API Objects in Place Using kubectl patch](https://kubernetes.io/docs/tasks/manage-kubernetes-objects/update-api-object-kubectl-patch/)
- [Kubernetes: Server-Side Apply — Merge strategy](https://kubernetes.io/docs/reference/using-api/server-side-apply/#merge-strategy)
- [Kubernetes: CustomResourceDefinition — list type](https://kubernetes.io/docs/tasks/extend-kubernetes/custom-resources/custom-resource-definitions/#list-type)
- [RFC 7396: JSON Merge Patch](https://datatracker.ietf.org/doc/html/rfc7396)
- [RFC 6902: JSON Patch](https://datatracker.ietf.org/doc/html/rfc6902)
- [Helm: Values Files](https://helm.sh/docs/chart_template_guide/values_files/)
- [systemd.unit](https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html)
- [CUE: The Logic of CUE](https://cuelang.org/docs/concept/the-logic-of-cue/)
- [Jsonnet: Language Reference — Object Inheritance](https://jsonnet.org/ref/language.html#object-inheritance)
- [NixOS Manual: Modularity](https://nixos.org/manual/nixos/stable/#sec-modularity)
- [NixOS Manual: Setting Priorities](https://nixos.org/manual/nixos/stable/#sec-option-definitions-setting-priorities)
- [Git: gitattributes — Performing a three-way merge](https://git-scm.com/docs/gitattributes#_performing_a_three_way_merge)
- [OpenAPI Specification: Specification Extensions](https://spec.openapis.org/oas/latest.html#specification-extensions)
- [JSON Schema: Creating your own vocabularies](https://json-schema.org/understanding-json-schema/reference/schema#creating-your-own-vocabularies)
