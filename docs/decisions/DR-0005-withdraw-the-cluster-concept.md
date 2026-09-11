# DR-0005: cluster 概念の撤回

Status: Accepted (2026-09-12。kawaz 裁定)
Date: 2026-09-12
Sponsor: kawaz (2026-09-12)「cluster 議論は権限構造が未解決のまま。実装も設定・コード・文書からの言及も全て打ち消す」
関連: 設計 §7 (mesh)、§8.2 (設定)、[DR-0004](DR-0004-config-edited-and-applied.md)、[DR-0001](DR-0001-passkey-auth-for-people.md) (認証 record の複製)、issue archive `2026-09-11-multiple-clusters-per-host` / `2026-09-11-auth-records-per-cluster-store` (どちらも discarded)

## 1. 背景

1 ホストに複数の cluster (本人 / 家族 / ホームエージェント等) を立て、クレデンシャルは cluster 内の instance に紐づき、cluster がセグメント単位の役割を持つ、という想定があった (kawaz 2026-09-11)。これを受けて v0.10.x で `clusters.json` / `clusters/` / `ccmsg mesh` サブコマンド / `--cluster` オプションを実装した。

しかし **cluster が何の区切りなのか (誰が何をできるか) が決まらないまま、構造だけが先行した**。認証 record を cluster 単位の共有ストアに寄せるか instance ごとのままにするか、多重所属をどう扱うか、admin の権限をどこに置くかが全部未解決で、実装は「複数の cluster を書ける設定ファイルの形」だけを持っている状態だった。

## 2. 決定

**cluster 概念を撤回する。** 参加 endpoint の一覧を信頼する最初のモデルに戻す。

- 設定は `endpoints.json` + `supervisor.json` + `satisfied.json` の形にする (DR-0004)
- `clusters.json` / `clusters/` / `ccmsg mesh` / `--cluster` / `passkey --cluster` を撤去する
- **設定・コード・文書から cluster への言及を消す。** 以後 DESIGN に cluster は出さない
- 認証 record の複製単位は **mesh のまま** (instance ごとに保持し、`auth.records` topic で複製する。DR-0001 §2.6)

### 2.1 再開時のために残す用語

cluster をもう一度考える時は、**権限構造から改めて起票する**。当時の実装や discard した issue の構造案を出発点にしない。用語だけ残す:

| 語 | 意味 |
|---|---|
| instance | 1 つの config home。daemon プロセスと 1:1 |
| mesh | 認証を通した instance の集まり。`endpoints.json` が名指した全員 |
| cluster | **未定義**。権限の区切りとして想定されたが、何を区切るかが決まっていない |

### 2.2 再開時に答えが要る論点

- **多重所属**: 1 つの instance が複数の区切りに属せるか。属せるなら認証 record はどちらに紐づくか
- **複数ホスト**: 区切りがホストをまたぐのか、ホスト内に閉じるのか
- **admin**: 「その区切りを管理できる人」をどう表し、誰がそれを与えるか
- **認証 record の保管**: instance ごと (単一書き手が保てる) と共有ストア (区切り単位で見える) のどちらを取るか。共有ストアにすると単一書き手の性質が壊れる (DR-0001 §2.4)

## 3. 不採用

| 案 | 理由 |
|---|---|
| cluster 構造を残したまま、権限を後から足す | 権限が決まっていないので、今ある構造が正しい形かを検証できない。構造が先にあると、後から来る権限の方が構造に合わせられる |
| cluster を「共通 config の置き場 1 つ = mesh 1 つ = 認証境界 1 つ」と定義して進める | 境界が 3 つ同時に動く定義で、どれか 1 つだけを変えたい時に破綻する。多重所属の問いにも答えていない |
| 認証 record を cluster 単位の共有ストアに寄せる | 単一書き手 (`iss` だけが family を書く) が壊れ、LWW 複製との合流で rotate が消える |

## 4. 影響

- 設定ファイルの構造 (DR-0004)、`ccmsg mesh` サブコマンドの撤去、`daemon passkey` は config home 指定の形に戻る
- issue `2026-09-11-multiple-clusters-per-host` / `2026-09-11-auth-records-per-cluster-store` はどちらも discarded。再開時は本 DR の §2.1 / §2.2 から起こす
