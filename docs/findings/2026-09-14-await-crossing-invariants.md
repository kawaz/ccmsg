# await をまたいだ前提の総点検

対象: `jj diff --from 8eb787636fcb --to main -- src` (v0.13.0 → 現 main) で async 化された 39 ファイルの全 `await`。観点は DR-0015 §2.5 の 4 項目 — (a) まだ望まれているか、(b) この entry はまだ生きているか、(c) 自分が最後に始めた読みか、(d) await が返した値の形を検査したか。

各 `await` について「その前に読んだ状態 / 取った参照 / 立てた登録」と「await 明けにそれが有効である根拠」を照合した。根拠が無いものは既存の 4 つの型 (前提の取り直し / 世代番号 / Promise を map に置く / 取り消しの検出) で直し、それぞれに欠落を戻すと落ちる test を足した。

## 件数

| 群 | ファイル | await | 根拠あり | 根拠なし | 要確認 |
|---|---|---|---|---|---|
| 1 | files / launcher / sessions の op 系 10 ファイル | 99 | 93 | 6 | 0 |
| 2 | auth / kv / instance / supervise 8 ファイル | 90 | 75 | 11 | 4 |
| 3 | messaging / sessions の registry・status 系 9 ファイル | 77 | 67 | 1 | 9 |
| 4 | transcript / topics 10 ファイル | 57 | 45 | 9 | 3 |
| | **計** | **323** | **280** | **27** | **16** |

根拠なし 27 行は同根でまとめると **12 件**。全件を直したので、処置後の「根拠なし」は **0 件**。要確認 16 件のうち 11 件を直し、5 件は根拠を添えて据え置いた (末尾の「据え置き」節)。

`src/transcript/fold.ts`、`src/transcript/items/classify.ts`、`src/sessions/harness.ts`、`src/instance/paths.ts` は `await` を含まない (`src/transcript/fold.ts:445` の `async` は変数名)。

## 直した 12 件

行番号は修正前のもの。

| # | 場所 | またいだ前提 | 症状 | 処置の型 |
|---|---|---|---|---|
| 1 | `src/files/files.ts:128-137` | `existing()` の mtime / size を `bytesOf` の await 明けに検査し `replace` まで再検証しない | 同じ token の `file.edit` 2 件が両方通り、後着が先着を黙って上書きする (`file_conflict` が一度も出ない) | path ごとの書き込み鎖 (kv / auth の `#persist()` と同型) の内側で stat を取り直してから検査する |
| 2 | `src/files/files.ts:266-275` | `temporary` が自分だけの名前であること | 同一プロセス・同一 ms の並行 `replace` が同じ temp に書き、NUL 混じりの内容がディスクに残って以後その file が編集不能になる | `randomUUID()` の suffix |
| 3 | `src/auth/auth.ts:446,500,693` | peer の応答が `AuthResolveResult` / `AuthRotateResult` の形であること | 形の違う応答 1 つで `credential/undefined/…` が永続化され、以後 `knownOrigins()` が毎回 throw する | 契約の `validationErrors()` で検査し、通らなければ断って永続化しない |
| 4 | `src/auth/auth.ts:457,482,667` | `removed(sub)` が偽であり続けること | await 中に tombstone が立つと `write` は `false` を返すが捨てられ、永続化されていない credential / token を成功として返す | 戻り値を検査し、refused なら `forbidden` で断る (取り消しの検出) |
| 5 | `src/auth/auth.ts:576,592` | `record` snapshot がまだ最新であること | 並行 assert で `sign_count` が巻き戻り、clone 検知の窓が 1 段緩む | await 明けに `credential()` を引き直し、counter 規則を再適用する |
| 6 | `src/instance/instance.ts:797,1031` | `#stopping` が偽であること / flush 時点の chain が全部であること | 停止中の in-flight な write が lock 解放後に `records.json` を rename し、後継 instance の書き込みと取り合う | `route()` にも `#stopping` ガードを置き、通した op を `#inFlight` に載せて flush の前に待つ |
| 7 | `src/daemon/supervise.ts:420` | `#keep` が spawn して `took()` を呼ぶこと | `#leaving` 中の `startOne` が永遠に settle せず、client は「起動失敗」と「切断」を区別できない | loop の終わりで待ち手を解く (取り消しの検出) |
| 8 | `src/sessions/registry.ts:272` | `#greetable` が通した「この接続は未 greet」 | 1 チャンクに 2 つの greeting を並べると両方が通り、identity が後勝ちで上書きされる | 判定と同じ同期区間で claim を取り、await 明けに自分が予約者かを確かめる |
| 9 | `src/sessions/status.ts:48,52,69` | `facts` の要素が読み始めの世代のままであること | 1 つの payload の中で `api_error` は読み始め、`background[i].status` は読み終わりという世代混在 | `facts` を返す側 (`src/transcript/fold.ts`) で要素を末端まで複製して凍結する |
| 10 | `src/transcript/cache.ts:68` | cache の形が restore 後に walk される深さを満たすこと | 形違い entry 1 個で daemon が exit 1 の crash loop に入るか、そのセッションが手で cache を消すまで開けなくなる | 検査を walk の深さに合わせ、`#open` の失敗時に `cache.drop()` して次の 1 読みで自癒させる |
| 11 | `src/transcript/transcripts.ts:168` | entry を消しても holders が居ないこと | holders が残ったまま entry を消すので、後の `release` が別 entry の holds を減らして生きた tail を止める。greet が transcript 出現より先に来るセッションの fold が永久に始まらない | entry を消さず path 未定のまま残し、tail と同じ間隔で `pathOf` を聞き直す |
| 12 | `src/transcript/tail.ts:124-158` | この tail がまだ望まれていること | 停止済みの tail が読み切りまで publish / `onFacts` / `onTruncated`→`cache.drop` を続け、再 hold した entry の cache を消す | 世代番号 `#run` を `stop()` で進め、各 await 明けで確かめて return する |

1 と 2 は既存 4 型の範囲外として kawaz の承認を得た (path ごとの鎖 + 衝突しない temp 名)。3 は契約が既に `validationErrors()` と両 schema を export していたので契約は変えていない。

## `FOLD_CACHE_VERSION` を 2 から 3 に上げた

`src/transcript/cache.ts` の形の検査を walk の深さに合わせ、`save()` が状態を末端まで複製し、停止済み tail が書かなくなった。旧 build が書いた entry は version が同じまま「offset より先の fold」を含みうる — これは現 build が同じ file から導かない答えなので、version を上げて読み捨てる。`test/transcript.test.ts` の digest もそれに合わせて貼り直した。costs は upgrade 後の 1 セッションあたり 1 回の全読み。

## 群 1: files / launcher / sessions の op 系 (99)

`roots` は呼び出しごとに `src/instance/instance.ts:670-681` が作る snapshot で、`containment.ts` 内に書き手が無い。fs の解決結果を await の後で使う箇所は、プロセス内で session root 配下の dir / symlink を動かす経路が無い (symlink 作成は `src/instance/socket.ts:19` の socket のみ、rename / unlink は state / plugin 配下と `files.ts` の `replace` のみ)。外部プロセスによる差し替えは同期実装でも同じ 2 syscall の窓で、非同期化で生まれた窓ではない。

| ファイル:行 | await の対象 | またぐ前提 | 根拠 | 処置 |
|---|---|---|---|---|
| containment.ts:73 | `rootsFor(args.sid, viewer)` | なし | ローカルのみ | — |
| containment.ts:74 | `absolute(args, roots)` | `roots` | 呼び出しごとの snapshot | — |
| containment.ts:75 | `canonical(named)` | `roots` / `named` | 同上、`named` は const | — |
| containment.ts:76 | `admit(args.kind, real, roots)` | `roots` / `real` / `named` | `admit` 内で root を再 canonical するので root 移動は refuse に倒れる | — |
| containment.ts:87 | `rootsFor(sid, viewer)` | なし | ローカルのみ | — |
| containment.ts:93 | `canonical(named)` | `roots` | snapshot | — |
| containment.ts:96 | `admit(kind, real, roots)` (最大 3 回) | `roots` / `real` / `named` | 同上 | — |
| containment.ts:110 | `rootsFor(sid, viewer)` | なし | ローカルのみ | — |
| containment.ts:115 | `canonical(cwd)` | `roots.cwd` | snapshot | — |
| containment.ts:117 | `canonical(named)` | `base` / `named` | `inbox` は `base` から作り `real` と比較、両方この呼び出しの値 | — |
| containment.ts:137 | `source.roots(sid)` | なし | ローカルのみ。戻り値の undefined を検査 (138) | — |
| containment.ts:151 | `canonical(root)` | `root` | snapshot | — |
| containment.ts:168 | `canonical(roots.root)` | `real` / `roots` | snapshot + fs 解決 | — |
| containment.ts:175 | `Promise.all(workspace_folders.map(canonical))` | `real` / `roots` | 同上 | — |
| containment.ts:186 | `Promise.all(external_files.map(canonical))` | `real` / `roots` | 同上 | — |
| containment.ts:246 | `realpath(absolute)` | なし | ローカルのみ | — |
| containment.ts:251 | `realpath(parent)` | `absolute` / `parent` | const | — |
| files.ts:71 | `paths.root(args, viewer)` | なし | ローカルのみ | — |
| files.ts:72 | `existing(at)` | `at` | fs 解決 | — |
| files.ts:77 | `entriesOf(at.real)` | `at` / dir 判定 | 外部削除は同期でも同じ窓 | — |
| files.ts:83 | `paths.locate(args, viewer)` | なし | ローカルのみ | — |
| files.ts:84 | `existing(at)` | `at` | fs 解決 | — |
| files.ts:90 | `bytesOf(at.real, READ_LIMIT)` | `at` / `stat` | 食い違いは安全側 (token が古くなり次の edit が `file_conflict`) | — |
| files.ts:105 | `paths.inbox(...)` | なし | ローカルのみ | — |
| files.ts:109 | `mkdir(dirname(at.real))` | `at` | fs 解決 | — |
| files.ts:110 | `create(at.real, content)` | `at` | `wx` が atomic で check-then-act が無い | — |
| files.ts:116 | `paths.locate(args, viewer)` | なし | ローカルのみ | — |
| files.ts:118 | `isDirectory(parent)` | `at` / `parent` | fs 解決 | — |
| files.ts:121 | `create(at.real, content)` | `at` / 親が dir | `wx` が atomic | — |
| files.ts:127 | `paths.locate(args, viewer)` | なし | ローカルのみ | — |
| files.ts:128 | `existing(at)` | `at` | fs 解決 | — |
| **files.ts:130** | `bytesOf(at.real, SNIFF)` | **`before` の mtime / size** | **なし。133 の検査が 128 時点の snapshot を見る** | **直した (#1)** |
| **files.ts:136** | `replace(at.real, content)` | **133 の token 検査の結果** | **なし。128→136 の間に再検証も atomic な手段も無い** | **直した (#1)** |
| **files.ts:137** | `stat(at.real)` | **136 で自分が書いた内容が着地していること** | **なし。並行 edit の rename が挟まると相手の内容を述べる** | **直した (#1)** |
| files.ts:148 | `paths.locate(args, viewer)` | なし | ローカルのみ | — |
| files.ts:154 | `lstatOf(at.named)` | `at` | fs 解決 | — |
| files.ts:159 | `unlink(at.named)` | `at` / `isFile()` | named が symlink に差し替わっても unlink は link 自体を消す | — |
| files.ts:165 | `paths.root(...)` | なし | ローカルのみ | — |
| files.ts:177 | `find(at, terms, ...)` | `at` / `terms` | ローカルのみ | — |
| files.ts:183 | `Promise.all(paths.map(...))` | なし | ローカルのみ | — |
| files.ts:185 | `paths.identify(...)` | なし | ローカルのみ | — |
| files.ts:186 | `isFile(at.real)` | `at` | fs 解決 | — |
| files.ts:198 | `stat(at.real)` | `at` | ローカルのみ | — |
| files.ts:206 | `lstat(path)` | なし | ローカルのみ | — |
| files.ts:214 | `stat(path)` | なし | ローカルのみ | — |
| files.ts:222 | `stat(path)` | なし | ローカルのみ | — |
| files.ts:236 | `open(path, "r")` | なし | ローカルのみ | — |
| files.ts:239 | `handle.read(...)` | `handle` / `buffer` | この関数だけが持つ | — |
| files.ts:242 | `handle.close()` | `handle` | finally で必ず閉じる | — |
| files.ts:254 | `writeFile(path, content, {flag:"wx"})` | なし | EEXIST の形を検査 (256) | — |
| **files.ts:268** | `writeFile(temporary, content)` | **`temporary` が自分だけの名前であること** | **なし。pid + ms は同一プロセス内の並行性を区別できない** | **直した (#2)** |
| **files.ts:270** | `rename(temporary, path)` | **`temporary` が自分の内容を持つこと** | **なし。衝突時は ENOENT が raw error で上がる** | **直した (#2)** |
| **files.ts:272** | `unlink(temporary)` | **`temporary` が自分のものであること** | **なし。相手の temp を消しうる** | **直した (#2)** |
| files.ts:278 | `readdir(dir, {withFileTypes:true})` | なし | ローカルのみ | — |
| files.ts:280 | `Promise.all(entries.map(...))` | `entries` | ローカルのみ | — |
| files.ts:292 | `lstatOf(join(dir, entry.name))` | `entry` / `type` | 消えていれば undefined を許容 | — |
| files.ts:341 | `ignored.descend(dir)` | `truncated` / `visits` / `hits` | walk は再帰で直列に await するので並行の書き手が無い | — |
| files.ts:344 | `readdir(dir, ...)` | `here` | ローカルのみ | — |
| files.ts:371 | `walk(full, here)` | `truncated` / `entries` / `here` | 戻った直後に `truncated` を読み直す (372) | — |
| files.ts:377 | `walk(at.real, EMPTY_IGNORES)` | `at` | 接続断後も FIND_VISITS で有界、持ち越す資源が無い | — |
| files.ts:408 | `readIgnoreFile(...)` | `patterns` | クロージャの readonly 配列 | — |
| files.ts:417 | `readFile(file, "utf8")` | なし | 行単位で lenient に parse、失敗は `[]` | — |
| sandbox.ts:76 | `paths.locate(args, viewer)` | `now` | 数値で不変。古さは期限を早める安全側にしか効かない。Map の読み書きは await 後の同期区間 | — |
| launcher.ts:83 | `insideRoots(config, args.cwd)` | `config` / `#env` | 構築時に固定された readonly。config の reload は instance を作り直す | — |
| roots.ts:21 | `canonical(path)` | なし | ローカルのみ | — |
| roots.ts:22 | `isDirectory(real)` | `real` | fs 解決 | — |
| roots.ts:24 | `canonical(root)` | `real` / `config.root_dirs` | fs 解決 + readonly config | — |
| roots.ts:31 | `stat(path)` | なし | ローカルのみ | — |
| tree.ts:28 | `insideRoots(config, root)` | `entries` / `depth` / `filter` | ローカル + readonly config | — |
| tree.ts:30 | `walk(...)` | `entries` / `real` | 接続断後も MAX_DEPTH=5 で有界 | — |
| tree.ts:43 | `read(at)` | なし | ローカルのみ | — |
| tree.ts:52 | `insideRoots(config, path)` | `dirent` / `path` / `entries` | ローカル + fs 解決 | — |
| tree.ts:55 | `walk(...)` | `path` / `entries` | 同上 | — |
| tree.ts:72 | `readdir(dir, ...)` | なし | 失敗は `[]` | — |
| dump.ts:62 | `files.locate(...)` | `preset` | config 由来の readonly | — |
| dump.ts:68 | `readFile(file, "utf8")` | `file` | ローカルのみ | — |
| dump.ts:85 | `files.subjectOf(file)` | `text` / `keep` / `file` | meta.json は null-guard 付きで読む | — |
| dump.ts:85 | `classified(text, subject)` | `text` / `keep` / `args` | `sourceLines` も同じ `text` を使うので offset が整合する | — |
| dump.ts:116 | `mkdir(dir)` | `body` / `written_at` / `items` | ローカルのみ | — |
| dump.ts:119 | `writeFile(path, body)` | `path` / `body` | ローカルのみ | — |
| fork.ts:44 | `files.session(sid)` | なし | ローカルのみ | — |
| fork.ts:45 | `recordIds(file)` | `file` | ローカルのみ | — |
| fork.ts:52 | `files.all()` | `file` / `ours` / `head` / `mine` / `dir` | `all()` は毎回新規配列 | — |
| fork.ts:54 | `recordIds(candidate.file)` | `ours` / `mine` / `head` / `best` | seam は prefix で決まるので自 transcript の追記で覆らない | — |
| fork.ts:62 | `older(candidate.file, file)` | `copied` / `back` / `best` | ローカルのみ | — |
| fork.ts:89 | `bornAt(candidate)` | なし | ローカルのみ | — |
| fork.ts:90 | `bornAt(file)` | `theirs` | ローカルのみ | — |
| fork.ts:100 | `stat(file)` | なし | ローカルのみ | — |
| fork.ts:101 | `readFile(file, "utf8")` | 100 の size 判定 | 伸びても上限の近似が緩むだけ。transcript を書くのはプロセス外 | — |
| fork.ts:112 | `breathe()` | `ids` / `read` / `text` | 全てローカル | — |
| fork.ts:129 | `stat(file)` | なし | `birthtimeMs` の 0 を「無い」に正規化 | — |
| items.ts:59 | `files.locate(...)` | なし | ローカルのみ | — |
| items.ts:65 | `readFile(file, "utf8")` | `file` | ローカルのみ | — |
| items.ts:71 | `files.subjectOf(file)` | `text` / `keep` | null-guard 付き | — |
| items.ts:71 | `classified(text, subject)` | `text` / `keep` / `args` | ローカルのみ | — |
| search.ts:79 | `files.all()` | `clauses` / `budgets` / `since` / `hits` ほか | `since` は呼び出し時点基準で意味が正しい | — |
| search.ts:91 | `read(candidate, ...)` | 上記 + `candidate` | listing 時の size との食い違いは予算の近似が緩むだけ | — |
| search.ts:184 | `readFile(candidate.file, "utf8")` | `candidate` | 消えていれば undefined | — |
| search.ts:201 | `breathe()` | `matches` / `read` / `text` / `clauses` | `Budget` は compile ごとに新規で、計測は同期区間のみ | — |

## 群 2: auth / kv / instance / supervise (90)

永続化の 3 ファイル (`auth/records.ts`、`kv/store.ts`、`instance/log.ts`) は、body / line を await の前に同期で snapshot し、前の Promise に連ねている。失敗した write は chain を切らずに次へ渡す。temp 名は pid + ms だが chain が直列なので同一プロセス内で取り合う窓が無い。壊れていたのは chain ではなく、flush が「呼び出し時点まで」しか待たない点を instance 側が閉じていなかったこと (#6)。

| ファイル:行 | await の対象 | またぐ前提 | 根拠 | 処置 |
|---|---|---|---|---|
| admin.ts:83 | `auth.remove(sub)` | なし | ローカルのみ | — |
| auth.ts:320 | `records.remove(sub)` | なし | `disconnect` は await 後に `#authorized` を fresh に走査。tombstone は await 前に同期 accept 済み | — |
| auth.ts:344 | `records.merge(records)` | なし | 同上 | — |
| auth.ts:375 | `#atIssuer(...)` | なし | 結果を捨てる | — |
| auth.ts:394 | `#spendAnywhere(stated)` | なし | ローカルのみ | — |
| auth.ts:439 | `refusableAsync(checkPublicKey)` | `stated` / `challenge` / `verified` | 全て `args` 由来の const | — |
| **auth.ts:446** | `#claimsOf(args)` | **`claims` の形** | **なし。`sub` / `rp_id` / `user_id` / `endpoint` を検査せず record に書く** | **直した (#3)** |
| **auth.ts:457** | `#spendStated(...)` | **450 の `removed(sub) === false`** | **なし。await 中の remove で 482 が refused になるが検査しない** | **直した (#4)** |
| **auth.ts:482** | `records.write(credentialKey(...))` | **450 の removed 判定 / 458 の重複判定** | **なし。`false` を捨てて mint する** | **直した (#4)** |
| **auth.ts:500** | `#atIssuer(iss, "auth.resolve", ...)` | **応答の形** | **なし。`kind` だけ検査、`claims` は未検査。`Mesh.ask` は schema 検証をしない** | **直した (#3)** |
| **auth.ts:576** | `refusableAsync(verifyAssertion)` | **553 の `record` snapshot** | **なし。await 後に引き直さず古い record を書き戻す** | **直した (#5)** |
| auth.ts:590 | `#spendAnywhere(args.challenge)` | `record` snapshot | #5 に含む (この await 自体は値を使わない) | 直した (#5) |
| **auth.ts:592** | `records.write(credentialKey(record.sub, ...))` | **`record` snapshot / 戻り値** | **なし。`sign_count` が巻き戻る** | **直した (#5)** |
| **auth.ts:667** | `records.write(familyKey(...))` | **なし** | **なし。`false` でも永続化されていない token を返す** | **直した (#4)** |
| auth.ts:683 | `#refuseReuse(value)` | なし | 直後に throw | — |
| **auth.ts:693** | `#atIssuer(iss, "auth.rotate", ...)` | **応答の形** | **なし。`sub` / `access` / `refresh` を一切検査しない** | **直した (#3)** |
| auth.ts:701 | `rotate(value, from)` | なし | 734 で `byRefresh` を引き直す | — |
| auth.ts:717 | `#failReused(value)` | なし | ローカルのみ | — |
| auth.ts:721 | `#atIssuer(..., "auth.rotate", ...)` | なし | 結果を catch で捨てる | — |
| auth.ts:736 | `#failReused(value)` | なし | ローカルのみ | — |
| auth.ts:780 | `records.write(held.key, rotated, at)` | `held` / `rotated` | 734-780 に await が無く accept は同期 | — |
| auth.ts:808 | `records.fail(held.key)` | `held` / `held.body.sub` | `fail` は record を引き直し kind を検査。`sub` は不変値 | — |
| auth.ts:968 | `run()` | なし | ローカルのみ | — |
| records.ts:153 | `#persist()` (write) | accept 済みの `record` | accept → enqueue が同期なので accept 順 = chain 順 = publish 順 | — |
| records.ts:177 | `#persist()` (merge) | なし | ローカルのみ | — |
| records.ts:201 | `#persist()` (remove) | `marks` | accept 済み const | — |
| records.ts:288 | `write(key, tombstone)` (fail) | `held` | 285-288 に await が無い | — |
| records.ts:340 | `#writing` (flush) | なし | 「呼び出し時点までの chain を待つ」が契約。その後に載る write は #6 で扱う | 直した (#6) |
| records.ts:383 | `mkdir(dir)` | `body` / `deps.dir` | await 前に同期取得、chain で直列 | — |
| records.ts:389 | `writeFile(temporary, body)` | `file` / `temporary` | chain 直列で temp を取り合わない | — |
| records.ts:391 | `rename(temporary, file)` | 同上 | 同上 | — |
| records.ts:393 | `unlink(temporary)` | 同上 | 同上 | — |
| kv/store.ts:94 | `#persist(ns, entries)` (write) | publish する `args` / `updatedAt` | 判定と enqueue が同期、同 ns は chain 直列 | — |
| kv/store.ts:111 | `#persist(ns, entries)` (delete) | `before` | publish 要否の判定にしか使わず await 後の状態を主張しない | — |
| kv/store.ts:141 | `Promise.allSettled(#writing.values())` | なし | 呼び出し時点の chain を待つ契約 | 直した (#6) |
| kv/store.ts:166 | `mkdir(dir)` | `file` / `body` | 同期取得、per-ns chain で直列 | — |
| kv/store.ts:168 | `writeFile(temporary, ...)` | 同上 | 別 ns は別 file 名 | — |
| kv/store.ts:170 | `rename(temporary, file)` | 同上 | 同上 | — |
| kv/store.ts:172 | `unlink(temporary)` | 同上 | 同上 | — |
| log.ts:35 | `appendFile(file, line)` | `line` | 同期に作った const、単一 chain で順序保持 | — |
| log.ts:44 | `#written` (flush) | なし | 呼び出し時点の chain を待つ契約 | — |
| instance.ts:195 | `configFor(...)` | `lock` / `paths` / `log` | pid file ベースで他プロセスは保持できず、同一プロセスで `start` を 2 度呼ぶ経路が無い | — |
| instance.ts:218 | `bindForMesh(config, mesh)` | `config` / `mesh` / `id` | const | — |
| instance.ts:233 | `instance.listen()` | 218 で起こした ws listener と mesh | throw 時に止めていなかった | 直した (据え置き→処置、後述) |
| instance.ts:264 | `settle(configDir, stateRoot)` | なし | ローカルのみ | — |
| instance.ts:329 | `mesh.route(request)` | closure の `instance` | 2 つ目の await は 1 つ目の後に closure を読む | — |
| instance.ts:674 | `#transcripts.ready(sid)` | 672 の `where` snapshot | await 後に fresh な `facts` と混ぜていた | 直した (後述) |
| instance.ts:675 | `sessionStatusOf(...)` | なし | 返り値をそのまま返す | — |
| instance.ts:778 | `Promise.resolve()` | pid file / transport への add | microtask 1 つなので macrotask が割り込めない | — |
| **instance.ts:797** | `handleAuth(request, ...)` | **`#stopping === false` / flush 未実行** | **なし。`route` に `#stopping` ガードが無い** | **直した (#6)** |
| instance.ts:803 | `#gateway.route(request)` | なし | ローカルのみ | — |
| instance.ts:954 | `dispatch(frame, caller, deps)` | 903 の `#stopping === false` | persist する op は 903 通過と同じ同期区間で chain に載る。await 後の forward は mesh.stop 後に `instance_unreachable` を返す | — |
| instance.ts:970 | `#mesh.forward(...)` | `decided` / `stated` / `identity` | ローカルのみ | — |
| **instance.ts:1031** | `Promise.allSettled([flush...])` | **chain に載っているものが全部であること** | **なし。in-flight の route と admin 経路が flush 後に載る** | **直した (#6)** |
| instance.ts:1040 | `#transport.close()` | なし | ローカルのみ | — |
| instance.ts:1054 | `log.flush()` | pid 削除済み / lock 保持中 | lock は自プロセスが保持し他に書き手が無い | — |
| supervise.ts:138 | `reload(env)` | `#units` が空 | `#adopt` は run から 1 度だけ、`#listen` より前 | — |
| supervise.ts:165 | `#adopt()` | なし | ローカルのみ | — |
| supervise.ts:166 | `#listen()` | adopt 済みの `#units` | await 後は fresh に走査 | — |
| supervise.ts:171 | `new Promise(...)` | なし | await 後は fresh に走査 | — |
| supervise.ts:174 | `Promise.all(units.map(...))` | `#leaving = true` | ローカルのみ | — |
| supervise.ts:237 | `Promise.resolve()` | listener 作成済み | microtask のみ | — |
| supervise.ts:245,247,249,251,253 | `#over(...)` / `addOne(...)` | なし | ローカルのみ | — |
| supervise.ts:276 | `op(unit)` | `unit` | `op` 側が `#units.get(dir)` を引き直す | — |
| supervise.ts:287 | `Promise.allSettled(units.map(op))` | 281 の snapshot | 対象集合を先に固定するのが `--all` の仕様 (コードが明記) | — |
| **supervise.ts:320** | `#serving(unit)` | **312 の `child === undefined` / 318 の `wanted`** | **確かめ直していない。誤報告になる** | **直した (後述)** |
| supervise.ts:321 | `statusOf(unit.target)` | なし | `target` は readonly | — |
| supervise.ts:340 | `#stopChild(unit, child)` | `child` / `wanted = false` | loop 側の継続が先に走る microtask 連鎖で、socket data は割り込めない | — |
| supervise.ts:341 | `unit.loop` | 停止した child の loop であること | 同上 | — |
| supervise.ts:349,350,352 | `stopOne` / `awaitGone` / `startOne` | `unit` | await 後は readonly の `target` のみ。`startOne` は引き直す | — |
| supervise.ts:362 | `harnessFor(env, dir)` | — | `#units.has` を **await 後** に判定 (363)、`set` まで同期 | — |
| supervise.ts:367 | `startOne(home)` | なし | ローカルのみ | — |
| supervise.ts:396 | `child.exited` | 394 の `unit.child === child` | loop は `unit.loop.then` で直列。398 で `wanted` / `#leaving` を確かめ直す | — |
| supervise.ts:406 | `#pause(wait)` | `wanted` / `#leaving` | 390 の while 条件で確かめ直す。cancel 可能 | — |
| **supervise.ts:420** | `unit.next()` | **`#keep` が spawn して `took()` を呼ぶこと** | **なし。`#leaving` 中は呼ばれず永久に待つ** | **直した (#7)** |
| supervise.ts:424 | `Promise.race([awaitSocket, gone])` | `child` / `unit.target` | await 後は fresh に読む。負けた watcher は deadline で自壊 | 据え置き (後述) |
| supervise.ts:458 | `Promise.race([work, deadline])` | `timer` | finally で clearTimeout、放置される work は conn を close する | — |
| supervise.ts:486,492,498 | `within(...)` / `child.exited` | `child` | ローカルのみ | — |
| supervise.ts:506 | `Promise.all(units.map(stopChild))` | `#leaving = true` / snapshot | await 後は自フィールドのみ | — |
| supervise.ts:510 | `#stopChild(unit, child)` | `child` | ローカルのみ | — |
| supervise.ts:516 | `#ran` | なし | ローカルのみ | — |
| supervise.ts:543 | `handle(frame)` | `queue` | socket が閉じていれば write が捨てる | — |

## 群 3: messaging / sessions の registry・status 系 (77)

`src/messaging/inbox.ts` の `hold()` (await 明けに `standing` を取り直す)、`src/messaging/direct.ts` の `#inboxes` (opening Promise を map に置き、await 明けに同一性を確かめる)、`src/sessions/status.ts:178` の世代番号、`src/sessions/registry.ts:621-628` の取り直しは、いずれも本観点で既に直っている見本。

| ファイル:行 | await の対象 | またぐ前提 | 根拠 | 処置 |
|---|---|---|---|---|
| delivery.ts:129 | `#elsewhere(to, input)` | 127 の `state === undefined` | await 明けは `elsewhere` の値だけで分岐する | — |
| delivery.ts:135 | `direct.send(to, message)` | 127 の `state` を 168 の `#reason(state)` で使う | 確かめ直していない (告知だけの古さ) | 据え置き (後述) |
| delivery.ts:140 | `#offer(to)` | なし | ローカルのみ | — |
| delivery.ts:146,163 | `#hold(to, message)` | なし | 固定 reason を返す | — |
| delivery.ts:167 | `#hold(to, message)` | `state` | 135 と同じ | 据え置き (後述) |
| delivery.ts:178 | `inbox.hold(to, message)` | なし | 戻り値を素通し | — |
| delivery.ts:226 | `reach.forward(...)` | `owner` | const。応答 body の形は未検査 | 据え置き (後述) |
| delivery.ts:261 | `Promise.all(offers)` | なし | ローカルのみ | — |
| delivery.ts:279 | `direct.send(to, message)` | 273 の `held` snapshot / `#claimed` の Set | Set は `#offer` だけが書き同 sid は排他。inbox 側の expire / eviction は claimed を見ない | 据え置き (後述) |
| delivery.ts:285 | `inbox.delivered(to, [mid])` | 同上 | 同上 | 据え置き (後述) |
| direct.ts:138 | `chmod(#path, 0o600)` | `#server` が bind 済み | 呼び出し側の opening が await 明けに `#closed` を確かめる | — |
| direct.ts:153 | `settled.promise` | `#waiting` の entry が自分のもの | 同一 message の並行送信が無く (per-sid 排他 + mid が毎回新規)、deadline で必ず settle | — |
| direct.ts:279 | `#target(sid)` | なし | 形検査済み (pid / socketPath / peerProtocol) | — |
| direct.ts:281 | `#token(target.pid)` | `target` | const。書き換わっても失敗は `unavailable`、pid 再利用は `session_id` 照合で弾く | — |
| direct.ts:283 | `#inbox(target.socketPath)` | 返る inbox が close されていないこと | `#inbox` 内の opening は `#closed` を確かめるが 283-284 側に確認が無い | 据え置き (後述) |
| direct.ts:284 | `inbox?.address()` | 同上 | 同上 | 据え置き (後述) |
| direct.ts:286 | `write(socketPath, frames, ackMs)` | 285 で登録した `watching` | `status()` は deadline 内に必ず resolve | — |
| direct.ts:288 | `watching` | なし | ローカルのみ | — |
| direct.ts:308 | `held` | なし | 値を素通し | — |
| direct.ts:311 | `inbox.address()` | route が close されていないこと | 直後に `#closed` を確かめ直す (見本) | — |
| direct.ts:320 | `opening` | `#inboxes.get(dir)` が自分の opening | 324 で同一性を確かめ直す (見本) | — |
| direct.ts:333 | `#rows(...)` | なし | 各 row を `readJson` + 型検査 | — |
| direct.ts:355 | `#rows(...)` | なし | `peerToken` を string 検査 | — |
| direct.ts:379 | `readdir(#sessionsDir)` | なし | ローカルのみ | — |
| direct.ts:387 | `Promise.race([Promise.all(readJson), late])` | なし | timeout 後の結果は捨てる | — |
| direct.ts:458 | `Promise.race([spawned.exited, late])` | `spawned` | late なら kill | — |
| direct.ts:502 | `#run(...)` | なし | ローカルのみ | — |
| direct.ts:572 | `Bun.connect({...})` | `settled` / `flushed` / `written` | closure 変数で整合 | — |
| direct.ts:598 | `settled.promise` | `socket` | deadline で必ず settle、finally で end | — |
| direct.ts:607 | `readFile(path, "utf8")` | なし | parse を try で包み object 検査 | — |
| inbox.ts:120 | `#append({v:"add"})` | 115 の `held` | 使わず `standing` を取り直す (126) — 見本 | — |
| inbox.ts:130 | `#append({v:"dropped"})` | `oldest` | ローカル const、128 で同期に外し済み | — |
| inbox.ts:150 | `Promise.all(written)` | なし | ローカルのみ | — |
| inbox.ts:155 | `#written` | なし | ローカルのみ | — |
| inbox.ts:243,244 | `mkdir` / `appendFile` | `file` / `record` | readonly + closure 捕捉 | — |
| handlers.ts:82,88,98,129 | `processes.*` / `forkOrigin` | なし | ローカルのみ | — |
| handlers.ts:92 | `processes.type(terminal, ...)` | 88 の `terminal` | ローカル const。消えていれば失敗が返る | — |
| handlers.ts:149 | `files.locate(args, viewer)` | 142 の `sees(...)` | settle 後は再 greeting が拒まれ、settle 前は `hello_required` で到達しないので role は接続内で不変 | — |
| handlers.ts:150 | `readSlice(...)` | 149 の `file` | ローカル const | — |
| handlers.ts:163 | `itemsRead(args, ...)` | 160 の `sees` | 149 と同じ | — |
| last-live.ts:124 | `#written` | なし | ローカルのみ | — |
| last-live.ts:150,151,152 | `mkdir` / `writeFile` / `rename` | `document` / `temporary` | await 前に同期捕捉、chain が直列化 | — |
| registry.ts:251 | `#lastLive.flush()` | なし | ローカルのみ | — |
| **registry.ts:272** | `register(args.sid, args)` | **`#greetable` が通した「未 greet」** | **なし。同一チャンクの 2 つ目の greeting も通る** | **直した (#8)** |
| registry.ts:621 | `metaOf(deps, args, ...)` | `#connected` / `#stated` | await 後に取り直す (626-628、コメントが明記) — 見本 | — |
| registry.ts:862 | `ownTranscript(value, deps)` | `meta` | ローカルのみ | — |
| registry.ts:902,903,907 | `realpath` / `resolveAsFarAsItGoes` | `home` / `tree` | ローカルのみ | — |
| registry.ts:911 | `stated(settled)` | `settled` | `isFile()` を検査 | — |
| registry.ts:919 | `stat(path)` | なし | ローカルのみ | — |
| registry.ts:942 | `realpath(at)` | `unwritten` / `at` | ループローカル | — |
| **status.ts:48** | `canonical(where.root)` | **`facts` の要素 object** | **なし。fold が in-place 更新する同一 object** | **直した (#9)** |
| **status.ts:52** | `Promise.all(named_files.map(...))` | 同上 | 同上 | **直した (#9)** |
| status.ts:55 | `canonical(file.path)` | `file` | ローカルのみ | — |
| **status.ts:69** | `workspaceFolders(where.cwd)` | 同上 | 同上 | **直した (#9)** |
| status.ts:148 | `value(topic)` | 購読がまだ在ること | 呼び出し側が await 明けに `opening.delete(conn)` で確かめ、去った接続には送らない | — |
| status.ts:176 | `value(topic)` | この pass が最新であること | 世代番号 `mine !== #stating` (178) — 見本 | — |
| status.ts:207 | `Promise.all(sessions().map(ready))` | 一覧が変わらないこと | await 中に増えた session を待っていなかった | 直した (後述) |
| status.ts:212 | `deps.ready(sid)` | `#followed` の entry が同じもの | entry の差し替えは release→hold のみで、購読が残る限り release されない | — |
| status.ts:213 | `sessionStatusOf(...)` | なし | ローカルのみ | — |
| workspace.ts:21,22,24,25 | `workspaceFiles` / `specs` / `directory` / `overbroad` | ループローカル | 外部 JSON は形検査あり | — |
| workspace.ts:38,53 | `readdir` / `readFile` | なし | parse は try、形検査あり | — |
| workspace.ts:118,119,132 | `realpath` / `stat` / `directory` | `real` | ローカルのみ | — |

## 群 4: transcript / topics (57)

`src/topics/topics.ts:229` の `#opening` (await 前に取った Set object に対して同一性で `delete` する)、`src/transcript/transcripts.ts:84,169,178,208` の `#holds` 確認は、本観点で既に直っている見本。

| ファイル:行 | await の対象 | またぐ前提 | 根拠 | 処置 |
|---|---|---|---|---|
| **cache.ts:68** | `Bun.file(...).text()` | **cache の形が restore 後に walk される深さを満たすこと** | **なし。検査は pair の 1 段目まで、walk は `call.input` / `status.name` / `blocked_by` / `draft.id` まで届く** | **直した (#10)** |
| cache.ts:81 | `stat(path)` | `entry` | dev / ino / size の比較にだけ使う | — |
| cache.ts:107 | `#writing.then(() => #write(...))` | `offset` と fold / reading / items の内容 | 浅い snapshot で、ネストした object は live 参照だった | 直した (後述) |
| cache.ts:114-115 | `#writing.then(...)` / `unlink` | `path` | ローカルのみ | — |
| cache.ts:129 | `stat(path)` (`#write` 内) | offset を数えた file の identity | identity を書き込み時に読んでいた | 直した (後述) |
| cache.ts:146,147,148,150 | `mkdir` / `writeFile` / `rename` / `unlink` | ローカル | chain 直列で temp を取り合わない | — |
| files.ts:100 | `stated(announced)` | `announced` | `deps` は readonly、モジュール状態は全て const | — |
| files.ts:101,107,119 | `find` / `path` / `session` | `names` | ローカルのみ | — |
| files.ts:131,135,191 | `existing` / `teammate` | ローカル | ローカルのみ | — |
| files.ts:160 | `readFile(meta.json)` | なし | `?.taskKind` の等値比較のみで、primitive / null でも throw しない | — |
| files.ts:177 | `readdir(under)` | ローカル | ローカルのみ | — |
| files.ts:185 | `readFile(each)` | `names` | `?.name` の等値比較のみ | — |
| files.ts:204,243 | `walked(...)` | `layout` | const 表 | — |
| files.ts:205,254,278 | `listed(dir)` | ローカル | ローカルのみ | — |
| files.ts:209,249,257,322 | `stated(file)` | ローカル | listing 後に消えた file は undefined で skip | — |
| files.ts:330,338 | `readdir` / `stat` | ローカル | ローカルのみ | — |
| read.ts:31 | `stat(file)` | なし | `size` は `until` の上限にだけ使い、結果も同じ `size` を返すので自己整合 | — |
| read.ts:48 | `slice(file, probe, until)` | `size` / `until` / `from` | 縮んだ場合は short read で `bytesRead` に従う | — |
| read.ts:74,77,80 | `open` / `read` / `close` | `handle` | finally で close | — |
| scan.ts:46 | `breathe()` | `reading` / `items` / `offset` | 全てローカル | — |
| tail.ts:93 | `#catchUp(from)` | この tail がまだ望まれていること | watcher は呼び出し側が回収するが読み自体は継続していた | 直した (#12) |
| tail.ts:115 | `#reading.then(() => #read())` | 読みの直列性 | chain で直列、overlap 無し | — |
| **tail.ts:124,125** | `#stat(from)` / `#consume(size, onExisting)` | **停止していないこと** | **なし。stop 後も末尾まで読み切る** | **直した (#12)** |
| **tail.ts:129,138** | `#stat(#offset)` / `#consume(size, onAppended)` | **停止していないこと** | **なし。停止済み tail が publish / onFacts を続ける** | **直した (#12)** |
| **tail.ts:149,152,158** | `#slice(...)` / `breathe()` | **停止していないこと** | **なし。chunk ごとに停止を確かめない** | **直した (#12)** |
| tail.ts:164,181,185,188 | `stat` / `open` / `read` / `close` | `handle` | finally で close | — |
| transcripts.ts:84 | `ready(sid)` | `sid` の entry | await 後に `#followed.get(sid)` で引き直す。entry の入れ替えは holds→0 か `stopAll` のみ | — |
| **transcripts.ts:168** | `deps.pathOf(sid)` | **entry がまだ `#followed` のものであること** | **同一性の確認自体は正しいが、path 不在で holders を残したまま entry を消していた** | **直した (#11)** |
| transcripts.ts:177 | `cache.read(path)` | entry の同一性 / cache の形 | 178 で `#holds` を確認。形の検査は #10 で深くした | — |
| transcripts.ts:207 | `tail.start(offset)` | entry の同一性 | 208-212 で `#holds` + `tail.stop()` | — |
| transcripts.ts:214 | `#remember(followed)` | entry の同一性 | `onFacts` は冪等で、dead entry の値は `facts(sid)` が現 entry から読むので述べられない | — |
| transcripts.ts:239 | `cache.save(...)` | なし | 引数は同期に評価され、await 後は何もしない | — |
| topics.ts:229 | `upstream.snapshot(topic, conn)` | `opening` Set と `conn` の所属 | await 前に取った Set object に対して同一性で delete する (見本)。旧 Set への delete は false になり二重 stop が起きない | — |
| handlers.ts:12 | `topics.subscribe(conn, topic)` | `topic` | ローカルのみ | — |

## 直した「要確認」11 件

| 場所 | 何が起きていたか | 処置 |
|---|---|---|
| `instance.ts:233` | `listen()` が throw した時、bind 済みの ws listener と mesh を止めずに lock だけ返していた | catch で `instance.stop()` (無ければ `mesh?.stop()` + `wiring?.ws.close()`)。mesh 用の ws は constructor で transport に載せ、uds の段で落ちても stop が届くようにした |
| `instance.ts:674` | `Containment.roots` が await 前の `where` と await 後の `facts` を混ぜ、1 回の file op が「新しい fold + 古い greet の root/cwd」で判定された | `ready(sid)` の後に `where(sid)` を引き直す |
| `supervise.ts:320` | `startOne` 中の `stopOne` / `removeOne` で「起動に失敗しました (exit N)」と誤報告した | race の後に `#overtaken(unit)` を先に見て、停止・解除を名指しで答える |
| `status.ts:207` | `session.errors` の snapshot 経路で、await 中に増えた session を `ready` を待たずに述べた | 「待った集合に無い sid が現れる限り待ち直す」ループにした |
| `cache.ts:107` | `save()` の snapshot が配列 1 段だけで、ネストした object は live 参照。chain 待ちの間に tail が進むと offset より先の状態が entry に入った | `save()` 内で `structuredClone` して末端まで切り離す |
| `cache.ts:129` | file の identity を書き込み時に stat していたので、同名別 file に差し替わると「新 dev/ino + 旧 offset」が書かれ、次回の identity 検査を通過した | `save()` で stat を発行し、その Promise を `#write` が待つ |
| `delivery.ts:135,167` | `send()` の reason が await 前の分類で決まり、数秒前の状態を告げた | — (据え置き、後述) |
| `registry.ts` の 3 つの greeting | `hello.user` 同士の並びにも同じ窓があった | #8 の claim を 3 経路すべてに通し、失敗時は claim を返す |
| `fold.ts` の `held` | `facts` と同じ共有可変 object を cache にも渡していた (`save` が stat の後に stringify するので同じ世代ずれが起きる) | `facts` と同じ複製を `held` にも適用 |
| `transcripts.ts:218` | `#open` が失敗しても cache を drop しないので、2 回目の hold も同じ壊れた cache を読んだ | catch で `cache.drop(path)` し、fold / reading / recent / tail を空に戻す |
| `supervise.ts` の `removeOne` | backoff 中に `removeOne` が来ると待ち手が最大 30 秒待たされた | `stopOne` と同じ形で `#waits` を cancel する |

## 据え置き

| 場所 | 内容 | 据え置く理由 |
|---|---|---|
| `supervise.ts:424` | `gone` が勝った時、負けた `awaitSocket` の fs watcher が deadline まで残る | cancel の口は `src/daemon/registry.ts` の `awaitEntry` 側にあり、今回の範囲外。watcher は `startTimeoutMs` (既定 10 秒) で自ら閉じ、reject は `Promise.race` が購読済みなので unhandled にならない。`#leaving` の経路は #7 で `next()` が先に reject するので到達しなくなった。通すなら AbortSignal を `awaitEntry` に渡すのが筋 |
| `delivery.ts:135,167` | `send()` の reason が await 前の分類で決まる | message 自体は inbox に保持され `retry` で救われるので損失が無く、ずれるのは告知だけ。分類を取り直すと「reason は既にある状態の名前」という DESIGN §6.6 の意味が変わるので、直すなら設計側の判断が要る |
| `delivery.ts:279,285` | `#offer` の `held` snapshot が送信中に inbox 側の expire / eviction で落とされ、`dropped` の後に `delivered` が publish されうる | session は message を受け取っているので実害は告知の矛盾のみ。直すには「held に無い mid は述べない」か「送信後に残っているか確かめる」かの選択が要り、inbox と delivery の責務境界に触れる |
| `delivery.ts:226` | mesh 転送の応答 body を形検査せず `MessageSendResult` として返す | 状態が残らず 1 リクエスト分の誤答に留まる。peer は認証済み instance で信頼境界の内側。#3 と同じ形にするかは契約 validator の適用範囲の判断 |
| `direct.ts:283,284` | `StatusInbox` が close 後に `address()` で再 bind しうる (closed 状態を持たない) | 現状の呼び出し経路では発火しない — `close()` は macrotask 起点、283 は settled promise の microtask hop のみ。ただしそれを保証する不変条件がコードに書かれていないので、`StatusInbox` に closed 状態を持たせるのが筋 |

`src/auth/auth.ts` の `register` が issuer の返した `claims.endpoint` を `stated.endpoint` (WebAuthn origin 検証に使った値) と突き合わせていない点も #3 の検査中に見つかったが、形の検査とは別の論点 (`rp_id` と同じ扱いにするかの判断) なので触っていない。
