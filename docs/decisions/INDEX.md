# Decisions

このリポの判断記録 (DR) の索引。**なぜそう決めたか / 何を捨てたか**はここにあり、[docs/DESIGN-ja.md](../DESIGN-ja.md) / [DESIGN.md](../DESIGN.md) は今の姿だけを述べる。

リポ分離そのものの判断は
[claude-ccmsg の DR-0032](https://github.com/kawaz/claude-ccmsg/blob/main/docs/decisions/DR-0032-repo-split-protocol-first.md)。

Status は各 DR ファイルの `Status:` 行が正本。

## Active

| DR | 要旨 |
|---|---|
| [DR-0001](DR-0001-passkey-auth-for-people.md) | 人の認証は passkey、token は record に紐づく opaque 値、鍵は持たない (entry token の廃止) |
| [DR-0002](DR-0002-contract-holds-the-vocabulary.md) | 契約が語彙と属性表を持ち、daemon が分類と導出を持つ。client は生の jsonl を読まない |
| [DR-0003](DR-0003-naming-rules.md) | op / topic / 型名の統一規則 (`.` は階層、`:` は末尾 1 回、`_` は語の連結)。`mesh.*` は作らない |
| [DR-0004](DR-0004-config-edited-and-applied.md) | 設定は編集用と適用用に分け、検証を通った値だけを適用する。通らなければ前回の値で起動する |
| [DR-0006](DR-0006-dump-writes-typed-items.md) | dump は行ではなく型付き item を書く。呼び出しと答えは 2 item、畳むのは描画側 |
| [DR-0007](DR-0007-classify-by-who-the-conversation-is-with.md) | transcript の item 分類は「相手が誰か」で決める。立場は開いた側が決め、嗅ぎ分けない |
| [DR-0008](DR-0008-direct-route-first-inbox-persisted.md) | 配送は harness 直送を優先し topic へ落ちる。inbox は永続、drop は配送済みにしない |
| [DR-0009](DR-0009-daemon-derives-session-state.md) | セッションの分類は daemon が導出する。busy の正本は gateway、fold は 1 本 |
| [DR-0010](DR-0010-one-topic-mechanism-one-egress-layer.md) | 抑止は topic の仕組みに 1 実装。送出は終端ごとに 1 つのキューを通り、超過は突き返す |
| [DR-0011](DR-0011-peers-is-a-topic-of-rows.md) | `peers` は element 粒度の 1 種類の行。gateway が時刻を動かしても出るのは行 1 つ |
| [DR-0012](DR-0012-gateway-cache-window.md) | gateway の cache 窓は約束 (`cache_notice`) で仮に引き、実結果 (`cache`) で引き直す |
| [DR-0013](DR-0013-instances-are-long-running.md) | instance は常駐し、監督者が唯一の起動経路。監督者の載せ替えは `service stop` → `start` |
| [DR-0014](DR-0014-mesh-has-no-ops-of-its-own.md) | mesh は専用 op を持たない。到達しない peer は起動を止めず、断絶中の全量は 7 日保持 |

## Archived

<!-- 現役の文脈を汚す古い DR は decisions/archive/ に退避し、ここに記載 -->

## Moved to research/

<!-- 判断記録の体を成さなくなり research/ に降格した DR -->

## Superseded

<!-- 後続 DR に上書きされた DR (Status: Superseded by DR-XXXX) -->
