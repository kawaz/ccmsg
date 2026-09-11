# DR-0007: transcript の item 分類は「誰との会話か」で決める

Status: Accepted (2026-09-11。統括判断。実測 11,012 agent file に基づく)
Date: 2026-09-11
Sponsor: 統括判断 (dump の型体系の一部として)
関連: 設計 §5.2 (誰との会話かの分類)、`docs/design/dump-kinds.md`、[DR-0006](DR-0006-dump-writes-typed-items.md)、[DR-0003](DR-0003-naming-rules.md)

## 1. 背景

`message.<X>.<in|out>` の `X` が何を名指すかが、2 通りに読めた。「主語自身の立ち位置」(自分は main か worker か) と「相手が誰か」の 2 つで、前者だと同じ型が主語によって違うものを指す。

もう 1 つ、transcript の record だけからは **teammate (名前を持って居続ける agent) と使い捨ての worker が区別できない**。両方 sidechain file に書かれ、どちらも封筒付きの user 行で始まりうる。

## 2. 決定

### 2.1 `X` は相手の種類を名指す

`parent` = 起こした相手、`sub` = 下で起こす使い捨て、`team` = 名前を持って居続ける相手、`session` = ccmsg 経由の別セッション。

**唯一の例外が `user`** で、これは関係ではなく人。agent にとっての親はセッションか別の agent なので、そこを `user` と呼ぶと読み手が機械を人と取り違える。

harness の実名 (`main` / `team-lead` / teammate 名) は型に置かず、item の `harness_name` に残す。`to` / `from` は `message.session` が sid を書く場所であって、名前の場所ではない。

### 2.2 名前を持つことが teammate であることの中身

**「その名前が teammate のものか使い捨ての agent のものか」は別に問わない。** 名前を持つ agent は居続けて、また書ける。返ってきたものはそれ自体が 1 通の message として届く。使い捨ての方は起動した呼び出しに答えて終わる。

だから **他に何も特定しない名前は `team` と読む**。`sub` と読むと、返る道の無い答えを待つ呼び出しとして描かれてしまう。

### 2.3 自分の言葉で書ける相手かは、居続けるかで決まる

teammate は居続けるので人が直接打てる。セッション自身のファイルと同じ。だから **どちらでも、途中の封筒無し user 行は `message.user.in`**。

使い捨ての agent には起こした相手しか書かないので、**同じ行はそのファイルの中では `message.parent.in`** (人が喋ったのではなく指示が続いた)。

**先頭の record は主語がどこに立っていても `message.parent.in`**。何をせよと言われることは、書きかけられることとは違う。

### 2.4 どの立場で読むかはファイルを開いた側が決め、全 item が言う (`subject`)

record 自体には teammate と使い捨ての区別が無い (実測 9,573 agent file: 先頭 record が封筒かどうかは harness 自身の `taskKind` と 98.9% しか一致せず、`isSidechain` は 9,572 に立っている)。だから分類器は **嗅ぎ分けない。言われた立場で読む**。

言うのは harness がファイルの隣に置く note (`agent-<id>.meta.json`) で、`taskKind` が `in_process_teammate` なら teammate、それ以外は使い走り、セッション自身のファイルは `main`。teammate を名前で引く経路が既に同じ note を読んでいるので、新しい入力は増えない。

**先頭の封筒を根拠にしない。** 封筒は item の中身 = 誰でも書けるテキストである。note のある 8,223 agent file のうち 24 件 (0.29%) で両者が食い違い、そのほとんどは指示に message を引用した使い走りだった。

### 2.5 note の無いファイルは `sub` と読む

答えようのない問いがどちらに倒れるかは、間違えた時に読み手が何をするかで決める。`team` と読めば、もう居ない相手に書き返す先を差し出す。`sub` と読めば、teammate が名乗れたはずの名前を失うだけ。実測 11,012 agent file のうち 2,789 件が note を持たない (全部古いセッション) ので使い走りとして読む。セッション自身のものとして開いたファイルが sidechain record を持っていた場合も同じく `sub` に落ちる — **立場は狭まる方にしか動かない**。

### 2.6 teammate の名前は `ids` ledger に載らない

ledger は読み手が下りて行くためのもので、載るのは dump の主語にできるものだけ。名前は `DumpIdKind` のどれでもなく、名前で dump は取れない。teammate の `agent_id` は起動した呼び出しの答えから分かるので、それを載せ、`harness_name` を `label` にする。

### 2.7 名前の取れなかった結果は `tool.unknown`

途中から読み始めた transcript (topic の seed、別ファイルから再開した transcript) には指す先の `parent_item` が無く、record も何の tool だったかを言わない。**`tool.unknown` はこれのための予約名**で、「結果はここにある、tool の名前はこの instance が知らない」を意味する。返ってきた中身から名前を推測しない。`parent_tool_use_id` は常に運ぶので、読み手は手元の呼び出しの `tool_use_id` と突き合わせて名前を復元できる。

### 2.8 harness の 2 つの綴りは 1 つの型にまとめる

agent を起こす tool は `Agent` とも `Task` とも書かれてきたが、読み方も意味も同じなので型は `tool.Agent` に正規化する。同じものが語彙に 2 度立つと、選択子が「この transcript はどちらの綴りか」を知らなければならなくなる。record が使った綴りは `harness_name` に残す。

### 2.9 返る道の無い呼び出しは、待っているものと分けて描く

`SendMessage` で agent に書くのは往復の片道で、返事はその agent が送ろうと思った時に、この呼び出しを名指さない自分の message として届く。分類は「対を持たない」と印を付け、描画は `(未着)` ではなく `(片道)` と読ませる。

## 3. 不採用

| 案 | 理由 |
|---|---|
| `X` を主語自身の立ち位置にする | 同じ型が主語によって違うものを指す |
| 親を `user` と呼ぶ | agent の親はセッションか別の agent。読み手が機械を人と取り違える |
| 型に harness の実名 (`main` / teammate 名) を置く | 実名は関係ではない。`message.main` は「main の入出力がどこにいても漏れ聞こえる」と読める |
| 先頭 record が封筒かどうかで teammate を嗅ぎ分ける | 封筒は誰でも書けるテキスト。実測で `taskKind` と 0.29% 食い違う |
| note の無いファイルを `team` と読む | もう居ない相手に書き返す先を差し出すことになる |
| 名前の取れない結果に、返ってきた中身から推測した tool 名を付ける | 推測が事実として記録に残る |
| `Agent` と `Task` を別の型にする | 同じものが語彙に 2 度立つ |

## 4. 影響

- 設計 §5.2、`docs/design/dump-kinds.md`
- 契約の `TranscriptItemType` の doc に `tool.unknown` の予約名を明記
