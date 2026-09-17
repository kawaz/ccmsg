# GUI 設計記事・vlmkit・ccmsg の比較

- Date: 2026-09-17
- Status: Concluded

## 動機

Zenn の記事「バイブコーディングで GUI が壊れていく理由とその対策プロンプト」と、その内容を「だいたい mizchi/vlmkit で実装してあった」とする反応を一次資料から確認する。特に、ccmsg の UI 設計が独自の素人判断に留まるのか、他者の設計原則や実装と比べてどこが強く、どこが不足しているかを明らかにする。

## 調査範囲

記事本文、`mizchi/vlmkit` の README・リポジトリ構成・主要 manifest・GitHub の commit 履歴と metadata、ccmsg daemon・protocol・webui の `docs/DESIGN-ja.md` と `docs/decisions/INDEX.md`、webui の DR-0001〜0003 を対象とした。記事への反応そのものの投稿は出典が提示されていないため、発言の真偽や意図は評価せず、「記事の提案と vlmkit の実装にどこまで対応関係があるか」をコードと文書から検証した。

## 調査メモ

### 2026-09-17: 記事の主張と設計提案

記事が扱う問題は、AI に複数画面を持つ GUI を継続的に変更させると、各画面が自分と隣の画面を直接操作し、タイマー、ロック、リトライ、表示命令が衝突する構造へ崩れやすいことである。例として、連打時の表示と消去の競合、取り消し後も選択状態から戻らない問題、送信中の再操作による画面初期化の競合を挙げている。

提案は次の一文に集約される。

> すべてのコンポーネントを Root からなる階層構造下に置き、各コンポーネントは MVP パターンの Passive View として描画に関わるパラメータだけを操作し、動作は Chain of Responsibility でイベントをバブリングさせて、ステートマシンとして振る舞う Mediator に裁定させること。

この一文は五つの責務分離を要求している。

| 要素 | 記事で担う責務 |
|---|---|
| Passive View | View は描画と入力の転送に留まり、表示可否や他画面の状態を自分で決めない |
| Root を頂点とする Presenter 木 | UI の包含関係と判断の委譲先を同じ木で表し、子は担当範囲だけを見る |
| Chain of Responsibility | イベントを内側から外側へバブルし、処理できる層が引き受ける |
| Mediator | 画面同士を直接結ばず、競合する要求を一箇所で裁定する |
| ステートマシン | 有限状態と許される遷移を明示し、現在状態に合わない入力を受理しない |

提案の方向は妥当だが、記事は適用前後のコード、テスト結果、比較データを示していない。著者自身も「扱いやすい構造になるかな」「はずです」と述べ、挙動確認にはテストがあるとなおよいとしている。したがって、これは経験に基づく設計処方であり、効果がこの記事内で実証された手法ではない。

### 2026-09-17: vlmkit の正体

vlmkit はエージェント UI や複数エージェントの会話画面ではない。フロントエンド作業に対する決定的な検証 toolkit である。README は対象を、壊れたページの scan、copy fidelity、responsive boundary、keyboard operability、scripted flow、visual regression、design audit、repair と定義し、各 gate の失敗を machine-parsable な修正一覧として出す。人と coding agent の両方が同じ検証器を使うことが中心である。

#### アーキテクチャ

リポジトリは `core` から CLI まで 11 package を層状に分ける workspace で、README は manifest から生成した依存図を掲示している。主要 package 名からも責務が分かれている。

- `vlmkit-core`: 検証結果や共通処理の基礎
- `vlmkit-capture`: browser capture
- `vlmkit-ai`: model 接続を要する処理
- `vlmkit-generate` / `vlmkit-heal` / `vlmkit-plan`: 生成、修復、計画
- `vlmkit-markup`: markup 検証
- `vlmkit-mcp`: agent が stdio MCP 経由で gate を呼ぶ接続面
- `vlmkit-anim` / `vlmkit-animation-eval`: 変更・animation の可視化と評価

Playwright を browser 実行境界として再利用し、pixel comparison、semantic verification、accessibility、interaction、flow を個別 command と workflow にする。設定は route と threshold を持つ `vlmkit.config.json`、snapshot は baseline、viewport ごとの差分、承認という lifecycle を持つ。gate suppression は理由・owner・expiry を持ち、期限切れ suppression は適用されない。

#### データモデル

中心データは会話ではなく検証 run の input と artifact である。

- URL、HTML、画像、design target、flow definition が入力になる
- viewport ごとの screenshot、baseline、diff heatmap、report が visual regression の artifact になる
- semantic gate は verdict、defect、selector や位置を含む fix list を返す
- flow は複数 step の goal と各 step の観測結果を持つ
- config は route、threshold、gate 集合を宣言する

ccmsg の session、run、message、inbox に相当する恒久的な会話モデルはない。vlmkit における run は検証実行であり、会話 transcript を共有する agent process の run ではない。

#### UI

vlmkit 自身は一つの常設 Web application に情報設計を集約していない。用途ごとに HTML report、visual diff、heatmap、component gallery、architecture animation、CLI の verdict と fix list を提供する。これは検証結果を対象物に近い表現で見せるには強い。一方、session 一覧、conversation timeline、inbox、操作 scope のような運用 UI は目的外である。

#### エージェントとの接続

接続面は二つある。

1. stdio MCP server が gate を tool として公開する。
2. 一つの可視 skill が依頼を分類し、11 の内部 workflow から該当するものを読み、gate 実行、修正、再実行までを導く。

重要なのは、エージェントの推論を検証結果の正本にしない点である。決定的 gate が verdict と機械可読の fix list を返し、エージェントはそれを見て修正し、green まで再実行する。model key を要する機能は一部の自動修復や model 評価に限られ、README はそれ以外を key-free と明記する。

#### 成熟度

2026-09-17 の GitHub API 観測では、リポジトリは 2026-03-30 作成、最終 push は 2026-09-16、commit 履歴は 969 件、version は 0.23.0、license は MIT である。22 stars、1 fork、open issue 0 だった。数値は成熟度の質を直接証明しないが、約 5 か月半で高頻度に開発され、前日まで更新されている。

テストは Vitest の通常・coverage・example suite、distribution smoke、workspace package test、Playwright 連携、複数の dogfood/evaluation script を持つ。文書は introduction、task routing、完全な CLI reference、configuration、MCP tool table、knowledge、dated experiment report、changelog を分離している。README だけの prototype ではない。ただし短期間に 969 commit と 0.23.0 まで進んだ活発な pre-1.0 project でもあり、長期互換性や外部利用実績はこの資料だけからは主張できない。

### 2026-09-17: ccmsg との比較

| 軸 | 記事 | vlmkit | ccmsg |
|---|---|---|---|
| 目的 | AI が GUI を壊しにくい責務構造 | frontend の見た目・意味・操作を検証し、修正可能な defect にする | Claude Code / Codex の session 間 messaging、観測、操作と、人の運用画面 |
| 対象 | 複数画面が相互作用する desktop GUI | frontend を作る人と coding agent | session、agent、run、instance と、それらを監督する人 |
| agent 接続 | prompt で構造を指示 | MCP tool と skill/workflow、決定的 gate の再実行 | harness hook、CLI、wire contract、daemon が transcript を型付き item に分類 |
| データモデル | component tree、event、global state machine | target、capture、baseline、diff、verdict、fix list、flow | session と run の分離、1 sid 宛 message、永続 inbox、typed transcript item、topic snapshot/delta |
| UI | Passive View と Root/Presenter 木、内→外の event bubbling | report、diff viewer、heatmap、gallery、animation、CLI output | session 一覧、typed Timeline、agent drilldown、Files、Runs、Terminals、Usage、inbox、settings、action scope tree |
| 複数 agent | 言及なし | 同じ gate を任意の coding agent が利用するが、agent 間通信モデルはない | main/sub/team/session の主語相対 item、worker 固有 timeline、session 間配送、複数 run の重複検知 |
| security | 扱わない | local tool を基本とし、key を要する機能を区別。常設 multi-user UI の認証設計はない | passkey、opaque token、credential の endpoint＋webui 束縛、Origin / Sec-Fetch-Site、CORS、mesh 再認可 |
| 拡張性 | pattern の組合せを prompt で適用 | gate、workflow、MCP tool、package の追加 | protocol の op/topic 属性表、開いた item type family、transport/dispatch/domain 分離、client 共通導出関数 |

#### 記事・vlmkit にあり、ccmsg に足りないもの

1. **画面全体の状態遷移を一望できる state machine**。ccmsg は session liveness、connection、auth、send outcome、duplicate run、action availability を個別の純関数や state module で厳密に扱っているが、UI 全体について「状態、event、guard、遷移」を一枚で示す正本はない。記事の Mediator＋state machine は、競合時の裁定をレビューしやすくする点で ccmsg より明示的である。
2. **UI を外部から決定的に検査する gate と machine-parsable fix list**。ccmsg-webui は unit test と本物の daemon・passkey を使う visual test を持つが、responsive boundary、keyboard operability、copy fidelity、semantic defect を同じ contract で検査して修正 loop へ返す統一面は vlmkit の方が強い。
3. **検証 artifact の体系**。baseline、diff heatmap、gallery、dated evaluation report は、設計意図だけでなく実際の見え方の差を継続観測する。ccmsg の visual baseline は比較には使えるが、defect の説明と修正入力までを artifact 化していない。

#### ccmsg にあり、記事・vlmkit にないもの

1. **session と process run の分離**。一つの transcript に 0、1、複数の process があり得ることを型と UI の両方で表し、二重 writer 時は fold を凍結する。これは agent 運用 UI 固有の深い domain model である。
2. **配送と観測の意味論**。message は 1 sid 宛で、即時配送できなくても永続 inbox に残り、人の閲覧では消費されない。room log を増やさず transcript を正本とする設計は vlmkit の範囲外である。
3. **transcript の型付き projection と原文への可逆性**。daemon が harness 固有 JSONL を `message.user.in`、`message.team.out`、`tool.Bash` 等へ分類し、各 item に元 record の offset/bytes を残す。UI は通常 typed item を読み、疑わしい分類だけ原文を取り寄せられる。
4. **複数 agent の主語と関係のモデル**。main/sub/team を `subject`、parent/sub/team/session/user を主語相対の関係として分けるため、worker の transcript を同じ Timeline 語彙で開ける。
5. **認証境界**。passkey だけでなく、credential を「どの instance に入れるか」と「どの page から来てよいか」の二つへ束縛し、token 漏洩だけでは別 origin の page から接続できない。

### 2026-09-17: ccmsg UI の率直な評価

ccmsg の UI 設計は素人の思いつきではない。特に webui DR-0003 は記事の提案と独立にほぼ同じ骨格へ到達している。

- UI の component tree と同型の action scope tree を持つ
- action は内側から外側へバブルし、現在の scope が処理できなければ上へ渡す
- button と key binding は同じ action を起動する
- action catalogue は実装を持たず、availability と実行は scope が提供する
- state は component の局所事情に閉じず、Signals の state module と純関数の導出へ寄せる

これは記事の Root/Presenter 木、Chain of Responsibility、Passive View に対応する。しかも ccmsg は「一覧は session の子ではなく workspace 下の兄弟」「同じ action id を複数 scope が担当できる」「危険な action は確認を開くまでが責務」のように、自分の UI domain へ具体化している。記事の一文より実装可能性が高い。

良い点はほかにもある。

- Timeline を取得・純粋 model・描画の三層に分け、typed item と virtual window を分離している
- 色を入力、semantic token、component use の三層にし、component が具体色を持たない
- setting の preview と persist を分け、section 単位で適用・取消できる
- 送れない理由、inbox 待ち、duplicate run、truncated file など、domain の不都合を UI で隠さない
- worker drilldown、親への往復導線、run URL の意味を domain identity に合わせている

劣る点・未完了点も明確である。

- DR-0003 は部分実装で、タブ、端末、Files の木と preview、翻訳切替、主要 FAB が action 化されていない。設計原則は良いが、操作体系全体の一貫性はまだ完成していない。
- action bubbling は記事のイベント経路と近い一方、画面全体の状態遷移と競合裁定を一つの state machine / mediator として一覧できない。局所 module が正しくても、複数領域にまたがる競合を設計レビューしにくい。
- vlmkit のような外部 gate がないため、「設計文書どおりか」と「利用者から見て responsive、keyboard、copy、visual が壊れていないか」が別々の検査になっている。
- UI の domain model は非常に緻密だが、初見利用者が一覧、Timeline、inbox、run、agent、terminal の関係を短時間で学べるかという情報設計の評価は、設計文書と unit/visual test だけでは答えられない。実利用 task の観測が必要である。

したがって、根幹設計は他者の古典的 GUI 原則と整合し、それ以上に agent 運用 domain を具体化している。一方、全体 state machine、操作体系の実装完了、外部からの UX gate では改善余地がある。

## 結論

vlmkit は ccmsg の代替にはならない。両者は対象が違う。vlmkit は frontend を検証する道具であり、session 間配送、transcript、永続 inbox、agent/run identity、passkey 認証を持たない。ccmsg を vlmkit に置き換えると、ccmsg の中心 domain がすべて失われる。

部品としては使える。最も適合するのは ccmsg-webui の開発・CI における外部検証層である。

1. 主要 route を対象に `check integrity` 相当の responsive・overflow・collision gate を走らせる。
2. session 一覧、Timeline、settings、duplicate run、inbox の keyboard operability と scripted flow を検証する。
3. visual baseline と semantic gate を既存の本物の daemon・passkey visual fixture の上に重ねる。
4. failure の machine-parsable fix list を coding agent の修正 loop へ返す。

採用時の境界は明確にする。ccmsg の protocol、domain model、action catalogue の正本を vlmkit に移さない。vlmkit は UI の外から観測する verifier であり、ccmsg 内部の state manager や mediator の代用品ではない。また、全面導入の前に小さな route matrix で false positive、実行時間、既存 visual test との重複を実測する必要がある。

評価は「代替ではない。webui の検証部品として PoC する価値が高く、設計そのものは参考にする」である。記事からは全体 state machine の可視化を、vlmkit からは決定的 gate と機械可読の修正 feedback loop を取り入れる余地がある。ccmsg の action scope tree、typed Timeline、session/run 分離、配送・認証モデルは維持すべき独自資産である。

## 一次資料

| 対象 | URL | この調査で確認した内容 |
|---|---|---|
| Zenn 記事 | <https://zenn.dev/nrs/articles/9ba91aea587bf5> | GUI 崩壊の事例、Passive View、Root/Presenter 木、event bubbling、Mediator、state machine の提案と留保 |
| vlmkit repository | <https://github.com/mizchi/vlmkit> | repository 全体、license、source、tests、docs |
| vlmkit README | <https://github.com/mizchi/vlmkit/blob/main/README.md> | 目的、gate、agent 接続、11 package、documentation、MIT |
| vlmkit commit history | <https://github.com/mizchi/vlmkit/commits/main/> | commit 数と最終更新の GitHub API 観測の対応先 |
| vlmkit MCP package | <https://github.com/mizchi/vlmkit/tree/main/packages/vlmkit-mcp> | stdio MCP の接続面 |
| vlmkit docs | <https://github.com/mizchi/vlmkit/tree/main/docs> | task routing、configuration、reference、report |
| ccmsg daemon design | <../DESIGN-ja.md> | transport/dispatch/domain、session/run、inbox、transcript、認証 |
| ccmsg daemon decisions | <../decisions/INDEX.md> | daemon DR の実装状態 |
| ccmsg protocol design | <https://github.com/kawaz/ccmsg-protocol/blob/main/docs/DESIGN-ja.md> | wire contract、op/topic、session/run、message/inbox、typed item、auth |
| ccmsg protocol decisions | <https://github.com/kawaz/ccmsg-protocol/blob/main/docs/decisions/INDEX.md> | protocol DR の実装状態 |
| ccmsg webui design | <https://github.com/kawaz/ccmsg-webui/blob/main/docs/DESIGN-ja.md> | UI の層、Timeline、action、session/run、inbox、passkey、visual test |
| webui DR-0001 | <https://github.com/kawaz/ccmsg-webui/blob/main/docs/decisions/DR-0001-colour-is-computed-from-a-few-inputs.md> | semantic colour model と accessibility test |
| webui DR-0002 | <https://github.com/kawaz/ccmsg-webui/blob/main/docs/decisions/DR-0002-settings-are-sections-tried-before-they-are-kept.md> | setting section、preview と persist の分離 |
| webui DR-0003 | <https://github.com/kawaz/ccmsg-webui/blob/main/docs/decisions/DR-0003-an-action-is-what-a-key-and-a-button-both-reach.md> | action scope tree、bubbling、button/key 統一、実装状態 |
