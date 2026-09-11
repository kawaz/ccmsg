# DR-0002: 契約が語彙を持ち、daemon が分類を持つ

Status: Accepted (2026-09-12。骨子は kawaz 裁定 r303 m45/m46、細部は統括判断)
Date: 2026-09-12
Sponsor: kawaz r303m45 (2026-09-12)「契約が語彙、daemon が分類、webui は型付き item を受ける」
関連: 設計 §2 (契約との関係と層)、§5 (transcript の分類と dump)、§9.3 (増やさないの検査)、[DR-0003](DR-0003-naming-rules.md) (名前の規則)、[DR-0006](DR-0006-dump-writes-typed-items.md) (dump)

## 1. 背景

契約リポ (`@ccmsg/protocol`) と daemon の分界が、部位ごとに違う答えになりかけていた。op と topic の属性表は契約が持つと決まっている一方、transcript の item をどちらが作るかは決まっておらず、「型を契約に置くなら読み方も契約に置く」「client が生の jsonl を受けて自分で解釈する」の両方が案として立った。

transcript の jsonl は **harness (Claude Code / Codex) の内部形式**で、我々の合意なしに変わる。一方 item の型名は契約の語彙 (`types` の選択子、topic の payload、webui の描画の分岐) として複数のリポが共有する。この 2 つを同じ場所に置くと、harness の形式が変わるたびに契約の release が要る。

## 2. 決定

### 2.1 契約が持つのは語彙と属性、daemon が持つのは分類と導出

| 誰が | 何を |
|---|---|
| 契約 | 型 (wire の JSON の形)、op 属性表 / topic 属性表 (`roles` / `needs_hello` / `capability` / `locality` / `granularity`)、schema と検証器、item の**型名の語彙**、値の根拠 (保持期限・件数上限) |
| daemon | jsonl を読んで item に分類するコード、セッションの分類 (Waiting / alive / Paused / Disappeared)、不達の理由の判定、上流の値を契約の型へ写すこと |
| client (webui / CLI) | 受け取った型付きの値を描くこと |

**client は生の jsonl を読まない。** 読むのは常に型の付いた item で、型名は契約の語彙にある。harness の形式が変わったら daemon の分類だけが直り、契約も client も動かない。Codex の rollout 形式が同じ分類に吸収されるのはこの性質による。

### 2.2 認可は属性表を引く 1 つの関数で行う (M1)

op の実装は「引数は検証済み、呼び手は呼んでよいと確定済み」の状態から始まる。role / hello の要否 / capability / 転送先の判断を op の handler に書かない。可視範囲が role で変わる op (`scope: "role"`) だけが role を実装に渡され、それも属性表が `scope` を宣言した op に限る。

### 2.3 観測できるものは topic からだけ出す (M2)

同じ値に一発 fetch の op と push の両方を用意しない。

### 2.4 派生値を disk に置かない (M4)

他の状態から再構成できる値をファイルに書かない。書くのは再構成できないものだけ (instance id / `last_live` / log / inbox / kv / 認証 record)。

## 3. 不採用

| 案 | 理由 |
|---|---|
| op の handler ごとに role / capability を見る | M1 そのもの。属性表と分岐の 2 つの表現ができ、片方だけが変わる |
| 観測用に一発 fetch の op を残す (CLI の往復を減らすため) | M2。同じ値への 2 本目の経路のコストが、往復 1 → 3 の増分より大きい。往復が数えられる量でなく測れる量になったら考え直す |
| jsonl の読み方を契約に入れる | harness の内部形式が変わるたびに契約 release が要る |
| client が生の jsonl を受けて自分で解釈する | 解釈が client ごとに分かれ、同じ行が webui と CLI で違う意味になる |
| 派生値を disk にキャッシュする | M4。再構成できるものを永続化すると整合の手順が生まれる。再構成が起動時間に現れたら考え直す |

## 4. 影響

- 設計 §2 が本 DR の適用範囲。§5 の「client は生の jsonl を読まない」もここから導かれる
- §9.3 の M1 / M2 / M4 の機械検査が本 DR の担保
