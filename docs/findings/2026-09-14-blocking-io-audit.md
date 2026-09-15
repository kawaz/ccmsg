# ccmsg v2 daemon 同期 IO 監査

対象: `src/` (test を除く)。列挙は `grep -rn -E '[a-zA-Z]+Sync\(' src | grep -v '\.test\.'` の全件 (CLI 含む)。

## 分類の定義

| 記号 | 契機 |
|---|---|
| (A) | CLI の単発コマンド内でのみ走る。プロセスは 1 コマンドで終わるので、イベントループを塞いでも待たされる相手がいない |
| (B) | instance / supervisor プロセスの起動時・停止時に 1 回だけ走る。接続を握る前 (または全部手放した後) なので同上 |
| (C) | 接続を握った後に、op ハンドラ・topic の snapshot / publish・fs watcher の callback・定期ポーリングから走る。走っている間はイベントループが止まり、instance 全体が待たされる |
| (D) | test 専用 |

「IO」はファイル / ネットワークに限らず、外部の完了を待つブロッキング待ち全般を指す (kawaz 2026-09-14)。同期 fs API を前半の表に、外部の完了待ちで他を止めている箇所を後半の「外部の完了待ち」の節に載せる。

**(C) が止めるのは、同一接続の他の op ではなく instance 全体である。** 受信側に接続ごとの直列化は無い: `src/transport/driver.ts:33` は `void handle(frame, conn).then(...)` と fire-and-forget で呼び、`src/transport/framing.ts:62` の `LineReader` は 1 チャンクに含まれる行を `while` ループで次々 `sink.line(text)` に渡す。だから先行フレームのハンドラが `await` している間に、同じ接続の後続フレームのハンドラが並行に走り始める。これは UDS・person 向け WS・mesh の peer 接続のいずれも同じ `createDriver` / `LineReader` を通るので全接続種別で共通である。直列化されているのは送信側だけで (`framing.ts:98-131` の `WriteQueue`)、これは書き込み順序の保証であって処理順序の保証ではない。

この構造の帰結として、(C) の同期 IO は待たせる範囲が狭いのではなく広い。ハンドラが `await` で譲る限り他のフレームは進めるが、同期 fs はイベントループそのものを止めるので、その間は同じ接続の他の op も、他の接続も、topic の flush も、watcher の callback も、mesh の heartbeat も一切進まない。v1 で `instance.ping` が 1.15 秒待ったのはこの形である。

## (A) CLI の単発コマンド内

| ファイル:行 | API | 呼び出し経路 | 処置 |
|---|---|---|---|
| cli.ts:751,755,756,858,864,866,867,869,870,883,889,890,899 | existsSync / mkdirSync / copyFileSync / readdirSync / statSync / readFileSync | plugin の install / status / 復元コマンド | 同期のまま |
| cli.ts:1244,1268 | readFileSync / writeFileSync | dump の書き出し・読み戻し | 同期のまま |
| daemon/log.ts:47,48,73,74 | existsSync / statSync | `daemon log` / `service log` の `tailOf()` と `--follow` の `pull()`。`daemon.log` という op / topic は存在せず、稼働中 instance を経由しない | 同期のまま |
| daemon/registry.ts:41,257,349,350,351,384,393,403,404,408,409,438 | existsSync / writeFileSync / mkdirSync / readFileSync / rmSync | `daemon add` / `daemon remove` の `configHome()` `harnessOf()` `add()` `remove()` `readEndpointRows()` `saveEndpoints()` `saveSupervisor()` | 同期のまま |
| service/program.ts:38,46,66,67,129,139 | readFileSync / statSync / realpathSync / existsSync | `service install` / `service status` の `supervisorProgram()` `leadsHere()` `registeredProgram()` | 同期のまま |
| service/service.ts:277,278,344,423,424,477,512,513,514 | existsSync / rmSync / mkdirSync / writeFileSync | `service install` / `uninstall` / `status` の launchd / systemd unit 操作 | 同期のまま |
| instance/config.ts:571,572 | mkdirSync / copyFileSync | `daemon add` → `registry.add()` → `writeConfigTypes()` | 同期のまま |
| instance/lock.ts:89 | readFileSync | `lockHolder(file)` を `daemon status` 系が呼ぶ経路 (同じ関数は起動時の `acquireLock` からも走る = (B)) | 同期のまま |
| greeting/meta.ts:21 | Bun.spawnSync | `statedMeta()` → `askGit()`。呼び出し元は cli.ts のみ (1172 / 1579 / 1687 行)。daemon 側の `hello.session` ハンドラからは呼ばれない | 同期のまま |
| daemon/registry.ts:679 | existsSync | `awaitSocket()`。`daemon run` / `daemon start` から呼ぶ経路が (A)、`Supervisor#startOne()` から呼ぶ経路が (B) | 同期のまま |

## (B) 起動時・停止時に 1 回

| ファイル:行 | API | 呼び出し経路 | 処置 |
|---|---|---|---|
| instance/instance.ts:182 | mkdirSync | `start()` 冒頭の state ディレクトリ作成 | 同期のまま |
| instance/instance.ts:703 | writeFileSync | `listen()` の pid ファイル書き出し | 同期のまま |
| instance/instance.ts:1106 | unlinkSync | `stop()` → `remove(pidFile)` | 同期のまま |
| instance/identity.ts:39,40,47 | mkdirSync / writeFileSync / readFileSync | `instanceIdentity(file)` (起動時、instance id ファイルは数十バイト) | 同期のまま |
| instance/lock.ts:38,41,43,49,59 | mkdirSync / writeFileSync / linkSync / unlinkSync | `start()` → `acquireLock()` | 同期のまま |
| instance/lock.ts:74 | unlinkSync | `stop()` → `release()` | 同期のまま |
| instance/log.ts:18 | mkdirSync | `new Log(paths.logFile)` (構築時に 1 回) | 同期のまま |
| instance/socket.ts:19,20,36,53,58 | symlinkSync / renameSync / readdirSync / mkdirSync / unlinkSync | `listen()` → `prepareSocketDir()` / `sweepOrphanSockets()` / `publishSocket()` | 同期のまま |
| instance/config.ts:343,435,437,489,510,512,513,515,552,588 | existsSync / readFileSync / mkdirSync / copyFileSync / writeFileSync / statSync | `start()` → `configFor()` → `settle()` → `evaluate()` / `apply()` / `applied()`。同じ関数群を cli.ts が単発で呼ぶ経路もあり、そちらは (A) | 同期のまま |
| transport/uds.ts:79 | chmodSync | `listen()` → `listenUds()` の bind 直後 | 同期のまま |
| translate/helper.ts:33 | accessSync | `start()` → `translateSetup()` の実行可否チェック | 同期のまま |
| upstream/gateway.ts:264 | readFileSync | `start()` → `gatewaySetup()` → `token(path)` (webhook token、小さい固定ファイル) | 同期のまま |
| messaging/inbox.ts:72,198,205,206,207 | readFileSync / unlinkSync / mkdirSync / writeFileSync / renameSync | `Instance` 構築 → `inbox.load()` → `#compact()`。`load()` は起動時の 1 回のみ | 同期のまま |
| messaging/direct.ts:154 | unlinkSync | `stop()` → `ClaudeCodeSocketRoute.close()` → 各 `StatusInbox.close()` | 同期のまま |
| sessions/last-live.ts:77 | readFileSync + JSON.parse | `Sessions` コンストラクタ → `lastLive.load()` (起動時 1 回) | 同期のまま |
| daemon/supervise.ts:190,192,235 | mkdirSync / unlinkSync / chmodSync | supervisor の `run()` → `#serve()` → `#listen()` | 同期のまま |
| daemon/registry.ts:668 | mkdirSync | `Supervisor#keep()` → `prepareFor()` (子 instance 起動の都度) | 同期のまま |

## (C) 接続を握った後に走る

比例の欄は「1 回の呼び出しで読み書きする量が何に比例するか」。

### transcript を丸ごと触るもの (最優先)

| ファイル:行 | API | 契機 | 何に比例 | 処置 | 根拠 |
|---|---|---|---|---|---|
| sessions/search.ts:180 | readFileSync | op `session.search` → `search()` → `read()` | 候補 transcript の合計サイズ (`SCAN_BUDGET_BYTES` 64 MB まで) | async 化 | 1 回の検索で最大 64 MB を同期に読み、その間 dispatch が止まる |
| sessions/fork.ts:97 | readFileSync | op `session.fork.origin.read` → `forkOrigin()` → `recordIds()` を `files.all()` の全候補に対して | 同ディレクトリの候補数 × 各 transcript 全体 (`SWEEP_MAX_BYTES` 64 MB) | async 化 | 兄弟 transcript を総なめする。capability が任意な理由もこのコストにある |
| sessions/fork.ts:96,122 | statSync | 同上 (`recordIds()` 前のサイズ確認、`bornAt()`) | 候補ファイル数 | async 化 | 上と同じループの中なので一緒に非同期化する |
| sessions/dump.ts:66 | readFileSync | op `session.dump.write` → `dumpWrite()` | transcript 全体 | async 化 | 出力対象の選択前に全文を読む |
| sessions/dump.ts:114,117 | mkdirSync / writeFileSync | 同上 (出力先の作成と本文の書き出し) | 選択された items の量 | async 化 | 同じハンドラの中なので一緒に |
| sessions/items.ts:66 | readFileSync | op `transcript.items.read` → `itemsRead()` | transcript 全体 | async 化 | ページングの要求ごとに全文を読み直す |
| transcript/tail.ts | openSync / readSync / closeSync | topic `transcript:<sid>` / `transcript.items:<sid>` / `session.status:<sid>` の購読開始 → `Transcripts.hold()` → `TranscriptTail.start()` | transcript 全体 (頭から畳む) | 済 | `FileHandle#read()` の非同期読みを `READ_CHUNK_BYTES` (1 MiB) ごとに回し、合間に `breathe()` で譲る。購読の開始応答は畳み終えてから返す (CT-Q8) |
| transcript/tail.ts | statSync | `sizeNow(path)`。`TranscriptTail` の構築 (= `hold()` の都度) | 小さい (サイズ取得のみ) | 済 | `stat` に置き換え。size は構築時でなく読みの中で決まる |

### transcript 以外の file / ディレクトリを触るもの

| ファイル:行 | API | 契機 | 何に比例 | 処置 | 根拠 |
|---|---|---|---|---|---|
| files/files.ts:220,223,226 | openSync / readSync / closeSync | op `file.read` / `file.edit` → `bytesOf()` | 読み取り上限 (`READ_LIMIT` 512 KiB、sniff は 8 KiB) | async 化 | 1 回 512 KiB の同期読み。file 系 op は人が連打する経路 |
| files/files.ts:238 | writeFileSync | op `file.write` / `file.create` → `create()` | 書き込む content のバイト数 | async 化 | 同上、上限は要求側が決める |
| files/files.ts:252,254,256 | writeFileSync / renameSync / unlinkSync | op `file.edit` → `replace()` (一時ファイル経由の置換) | content のバイト数 | async 化 | 同上 |
| files/files.ts:104 | mkdirSync | op `file.write` → 親ディレクトリの作成 | パス階層の深さ | async 化 | 同じハンドラの中 |
| files/files.ts:262 | readdirSync | op `dir.list` → `entriesOf()` | ディレクトリのエントリ数 | async 化 | 大きいディレクトリで syscall が伸びる |
| files/files.ts:325 | readdirSync | op `file.find` → `find()` → `walk()` | 探索した木全体のエントリ数 (`FIND_VISITS` で頭打ち) | async 化 | 木を歩く間ずっと塞ぐ。(C) の中でここと search が最も長い |
| files/files.ts:398 | readFileSync | op `file.find` → `walk()` → `Ignores#descend()` → `readIgnoreFile()` | `.gitignore` のサイズ × 訪れたディレクトリ数 | async 化 | 上のループの中 |
| files/files.ts:132,149,182,190,198,206 | statSync / lstatSync | op `file.edit` / `file.delete` / `file.stat` / `file.create` / `dir.list` の存在確認 | 小さい | async 化 | 1 回は速いが同じハンドラを async 化する以上あわせて直す |
| files/containment.ts | realpathSync | file / dir / sandbox 系 op のすべてが通る `Containment` の `canonical()` | パス階層の深さ | 済 | `canonicalSync` は無い。`RootsSource.roots()` も Promise を返す |
| launcher/tree.ts:69 | readdirSync | op `dir.tree` → `dirTree()` → `walk()` → `read()` | 木全体のエントリ数 (深さ 5 で頭打ち) | async 化 | 木を歩く間塞ぐ |
| launcher/roots.ts:28 | statSync | op `dir.tree` / `launcher.run` → `insideRoots()` | 小さい | async 化 | 同じ経路 |
| transcript/files.ts | readdir / stat | `TranscriptFiles.all()` (op `session.search` / `session.fork.origin.read`) | config home 配下の transcript 数 | async 化済み | セッション数に比例。`all()` はループ全体で繰り返す |
| transcript/files.ts | readdirSync / statSync | `TranscriptFiles.path()` / `find()` (`transcript.read` 等の announced パスが無い場合のフォールバック、および topic `transcript:<sid>` / `transcript.items:<sid>` / `session.status:<sid>` の購読開始 → `Transcripts.hold()` が tail を立てる経路) | config home 配下の transcript 数 | 済 | `all()` と同じ `walked` / `listed` / `stated` に一本化。購読の開始応答は読み終えてから返すので await が入ってよい (CT-Q8) |
| transcript/files.ts:157 | readFileSync | `subjectOf(file)` → agent の `.meta.json` (op `transcript.items.read` / `session.dump.write`) | 小さい JSON 1 個 | async 化 | 呼び出し元を async 化する流れで一緒に |
| transcript/files.ts:174,182 | readdirSync / readFileSync + JSON.parse | `locate()` の `teammate` 指定時 → `teammate()` が subagents の meta を総なめ | セッション配下の agent 数 | async 化 | 同上 |
| transcript/read.ts:31,74,77,80 | statSync / openSync / readSync / closeSync | op `transcript.read` → `readSlice()` → `slice()` | 読み取り範囲 (最大 512 KB、`max_bytes`) | async 化 | 人がスクロールするたびに走る経路。`fs.promises.open` + `read` に置き換える |
| sessions/workspace.ts:38 | readdirSync | topic `session.status:<sid>` / `session.errors` の snapshot / refresh → `sessionStatusOf()` → `workspaceFolders()` → `workspaceFiles()` | cwd 直下のエントリ数 | 済 | status の値を作るたびに走る |
| sessions/workspace.ts:53 | readFileSync | 同上 → `specs(file)` (`.code-workspace` の読み) | ファイル 1 個 (小) | 済 | 同上 |
| sessions/workspace.ts:118,119 | realpathSync / statSync | 同上 → `directory(spec.path)` を folders の各要素に対して | folders の要素数 | 済 | 同上 |
| sessions/status.ts | realpathSync (`canonicalSync` 経由) | topic `session.status:<sid>` の snapshot / refresh → `sessionStatusOf()` の root と `named_files` の正規化 | named_files の数 | 済 | `canonicalSync` を廃し `canonical` に一本化。`sessionStatusOf()` は Promise を返す |
| sessions/harness.ts | readFileSync + JSON.parse | `DirectoryWatch` の fs.watch callback または 5 秒ポーリング → 状態ファイルの読み | `sessions/` の状態ファイル数 × 小さい JSON | 済 | `readFile` をファイルごとに await し、読めた行をメモリに持つ。判定側はそのメモリを同期に読む |
| sessions/harness.ts | readdirSync | 同上 → `DirectoryWatch.names()` | ディレクトリのエントリ数 | 済 | `readdir` に置き換え。構築時の初回読みだけ同期 (B 分類) |
| sessions/registry.ts | realpath / stat | op `hello.session` → `register()` → `metaOf()` → `ownTranscript()` / `resolveAsFarAsItGoes()` | 小さい (パス解決) | 済 | `register()` は読みを終えてから `#connected` を読み直すので、並行する挨拶どうしが数え落とさない |

### 永続化 (小さい固定サイズ)

| ファイル:行 | API | 契機 | 何に比例 | 処置 | 根拠 |
|---|---|---|---|---|---|
| kv/store.ts:119 | readFileSync | op `kv.read` / `kv.write` / `kv.delete`、topic `kv:<ns>` の snapshot → `#load(ns)` (初回のみ、以後メモリ) | 1 namespace のファイル全体 | 起動時 1 回の同期読みに寄せる | 初回の読みが購読の開始ターンに乗る。ただし `#load()` は同期契約の `KvStore.snapshot()` からも呼ばれるので、読みを Promise にすると topic の「値を述べる」入口が Promise を返すことになり CT-Q8 の領域に入る。構築時に kv ディレクトリを readdir して全 namespace を読めば (C) の読みが消え、snapshot の契約も変わらない |
| kv/store.ts:152,157,159,161 | mkdirSync / writeFileSync / renameSync / unlinkSync | op `kv.write` / `kv.delete` → `#persist()` | namespace の全キーの合計 | async 化 | 書き込みごとに namespace 全体を書き直す |
| auth/records.ts:338 | readFileSync | `#load()` の初回。op `auth.extend` / `auth.resolve` / `auth.rotate`、HTTP route の `auth.challenge` / `register` / `assert` / `token.refresh`、mesh の element 受信 → `Auth.merge()`、topic `auth.records` の snapshot | records.json 全体 | 起動時 1 回の同期読みに寄せる | 認証の最初の 1 回が接続処理の中に乗る。ただし `#load()` は同期契約の `AuthTopic.snapshot()` → `all()` からも呼ばれるので kv と同じ理由で読みは Promise にできない。構築時に読めば (C) の読みが消え、snapshot の契約も変わらない |
| auth/records.ts:361,367,369,371 | mkdirSync / writeFileSync / renameSync / unlinkSync | 同上の書き込み系 (`write` / `merge` / `remove` / `fail`) → `#persist()` | records.json 全体 | async 化 | 認証のたびにファイル全体を書き直す |
| messaging/inbox.ts:187,188 | mkdirSync / appendFileSync | op `message.send` → `Delivery.send()` → `#hold()` → `inbox.hold()`、および `#offer()` → `inbox.delivered()` | 追記 1 行 (メッセージ本文) | async 化 | メッセージのたびに走る。追記なので量は小さいが経路はホットパス |
| messaging/direct.ts:128 | chmodSync | op `message.send` → `ClaudeCodeSocketRoute.send()` → `#inbox()` → `new StatusInbox(dir).address()` (相手ごと初回のみ) | 固定 | async 化 | 同じハンドラの中 |
| sessions/last-live.ts | mkdir / writeFile / rename | `LastLiveStore.#save()` ← `record()` (セッションの live 遷移を `Sessions.changed()` が拾った時) / `remove()` (op `hello.session` / `session.forget`) | 保持エントリ数 (通常小) | 済 | 書きを 1 本の鎖に連ね、`flush()` が着地を待つ |

### 同期のまま置くもの ((C) だが IO でない / 設計上の理由がある)

| ファイル:行 | API | 契機 | 処置 | 根拠 |
|---|---|---|---|---|
| mesh/keys.ts:61 | generateKeyPairSync | mesh の `#dial()` / 被 dial で `new EphemeralKey()` | 同期のまま | fs IO ではなく CPU。ed25519 の鍵生成は固定コストで、接続の確立ごとに 1 回しか走らない |
| instance/log.ts:25 | appendFileSync | `Log.write()`。起動 / 停止のほか、mesh・sessions・auth の各コールバックから任意のイベント処理中にも走る | kawaz の裁定が要る | 原則に従えば async 化対象だが、ログを非同期にすると行の順序とクラッシュ直前の取りこぼしの扱いが変わる。1 行の追記で量は固定。判断を仰ぐ |

## (D) test 専用

| ファイル:行 | API | 状態 |
|---|---|---|
| auth/records.ts:388 | mkdirSync (`ensureDir`) | export されているが `src/` にも `test/` にも呼び出し元がない。dead export |

## 同期 fs API 以外のイベントループ阻害

| 場所 | 内容 | 契機 | 何に比例 | 処置 |
|---|---|---|---|---|
| sessions/search.ts:75-91, 191 | `files.all()` のループ内で各候補を `readFileSync` して `text.split("\n")` で全行走査 | op `session.search` | 候補 transcript の合計サイズ (最大 64 MB) | async 化 (読みを非同期にし、行の走査も候補ごとに譲る) |
| sessions/search.ts:144-163 | ユーザ指定の正規表現を `matcher.test(text)` で各レコードに適用。`CLAUSE_BUDGET_MS` (2000ms) の予算は `test()` の呼び出しの合間にしか効かず、1 回の `test()` は最後まで塞ぐ。コード中のコメントに `[a-z]+ing` で 86 秒かかった実測がある | op `session.search` の `regex: true` | 1 レコードの長さ × パターンの複雑度 (最悪は指数) | 別件。async 化では解けない (JS の RegExp に打ち切りが無い)。worker / 子プロセスに追い出すか、パターンを制限するかの設計判断が要る。issue を分けて起こす |
| sessions/fork.ts:48-62 | 候補ごとに `recordIds()` (全文読み + `split("\n")` + 行ごとの `readRecord`) と `run()` の線形走査 | op `session.fork.origin.read` | 候補数 × 各ファイル (最大 64 MB) | async 化 |
| sessions/dump.ts:82-85 / sessions/items.ts:71 | `classify(located(text), …)` が transcript 全文をパースして全レコードを `readRecord` (内部で `JSON.parse`) | op `session.dump.write` / `transcript.items.read` | transcript 全体の行数 | async 化 (読みと合わせて、行のパースを分割して譲る) |
| sessions/items.ts:130 | `paged()` のループで item ごとに `JSON.stringify(item).length` を計算 (サイズ計測のために再シリアライズ) | op `transcript.items.read` | 返す items 数 × 各 item のサイズ | 同期のまま (返却分だけに限られる)。計測のための二重シリアライズは別途の簡素化候補 |
| sessions/dump.ts:103 | `JSON.stringify(document, undefined, 2)` | op `session.dump.write` | 選択された items の量 | 同期のまま (書き出しを async 化すれば塞ぐのはこの 1 回分のみ) |
| transcript/transcripts.ts | `#appended` の `foldAll(fold, appended.lines)` と `#keep` の `readAll(…)` | `TranscriptTail.onAppended` / `onExisting` (watcher callback / ポーリング / 初回の読み)、購読中は常時 | 1 回の読みぶん (`READ_CHUNK_BYTES` で頭打ち) | 同期のまま。読みが 1 MiB ごとに切られ、その合間に譲るので、1 回の `foldAll` が回る量は file の大きさに比例しない |
| greeting/meta.ts:21 | `Bun.spawnSync(["git", …])` | cli.ts のみ (`statedMeta()`) | 子プロセス 1 回 | 同期のまま ((A) なので daemon のイベントループに乗らない) |

`execSync` / `child_process` の同期版は `src/` に存在しない。`Bun.spawnSync` は `greeting/meta.ts:21` の 1 件のみで、呼び出し元は cli.ts だけなので daemon のイベントループには乗らない。daemon 側の子プロセス起動 (`launcher/spawn.ts` / `sessions/processes.ts` / `translate/helper.ts` / `daemon/registry.ts` / `messaging/direct.ts` / `plugin/*`) はすべて非同期の `Bun.spawn` である。

## 外部の完了待ちで他を止めている箇所

ここでの「止まる」は、イベントループが塞がることではなく、直列化のガードや待ち行列によって後続の処理が進めなくなることを指す。

| 場所 | 何を待つ | 何が止まるか | deadline | 処置 | 根拠 |
|---|---|---|---|---|---|
| translate/translate.ts:35,46-51 | 常駐 translate helper の子プロセスとの 1 行 1 答のやりとり (`#exchange()`) | **instance 全体**。`#queue: Promise<unknown>` に全呼び出しを連ね、`run()` は前の `#exchange` の完了を待ってから次を走らせる。無関係なセッション・接続の `translate.run` が 1 本の待ち行列に並ぶ | あり (`deadlineMs(chars)` を `Promise.race`、超過で `stop()`。上限 `MAX_MS` は 120 秒) | 現状の直列化は維持し、待ち行列の長さに上限を置くか、要求元に待ち時間を答える方法を kawaz に諮る | 直列化そのものは設計上必然 (コメント: "One batch is in flight at a time — the helper answers one line per line it is given, and two batches sharing that channel could not tell the answers apart")。ただし「1 バッチ待ち」の代償が instance 全体に及び、最悪 120 秒 × 待ち行列長になる点は設計の含意として明示されていない |
| daemon/supervise.ts:283-285 | `#over()` の `for (const unit of units) { answers.push(await op(unit)); }` — 各 config home の子 instance の起動 / 停止 | `--all` の実行中、先行する config home の起動 (`#serving` の待ち) が長引くと後続の config home が丸ごと足止めされる | この `#over()` 自体には無い | 並行化する (`Promise.allSettled`) | 各 unit は独立した子プロセスで、順序に意味があるとは書かれていない。その場のコメント ("Taken as a list first: … what `--all` answers about is the set as it stood when it was asked") が説明しているのは対象リストを先に固定する理由であって、逐次実行する理由ではない |
| messaging/direct.ts:292,321 | `#target()` / `#token()` が `readdir` の結果を `for` で回して 1 件ずつ `await readJson(...)` | 1 回の `message.send` の route (a) 判定が `sessions/` のファイル数に比例して伸びる。他の接続は止まらない | **無し**。呼び出し元の `DIRECT_ACK_MS` (2000ms) / `DIRECT_STATUS_MS` (250ms) はこの走査の後の書き込みに掛かる deadline で、走査自体は青天井 | 並行化する (`Promise.all` で読み、一致を選ぶ) | 各ファイルの読みは独立で、見ているのは `sessionId` の一致だけ。順序に意味があるという記述は無い |
| messaging/delivery.ts:250-253 | `retry()` の `for (const sid of inbox.sids()) { await this.#offer(sid); }` | 1 つの sid が deadline まで詰まると、後続の sid の再提示がその分遅れる (最大 2250ms × sid 数が累積しうる) | 各 `#offer` の中の `direct.send` には有り | 並行化する (sid ごとに `#offer` を起こす) | sid ごとの反復は独立で、`#offer` 自体が `#offering` / `#claimed` で sid 単位のガードを持つ。`retry()` のコメントは sid 間の順序に触れていない |
| messaging/delivery.ts:264-284 | `#offer()` が `#offering` の sid ガードを保持したまま `direct.send()` (相手セッションの受信確認ソケットの応答) を await | 同一 sid への他の提示のみ。他の sid は進む | あり (2000ms + 250ms) | 同期のまま | 1 通ずつ出すのは意図された順序保証 (コメント: "Out of the inbox one at a time rather than in one batch at the end: an offer interrupted partway through has still delivered what it delivered, and a daemon killed here must not offer those again")。deadline も揃っている |
| mesh/mesh.ts:472-494 | `ask()` / `forward()` が peer の応答を待つ | 何も止めない。要求ごとに `carried = mesh-fwd-<id>` の一意な待ちオブジェクトを作るので、同じ peer・同じリンクへの他の要求は独立に進む | あり (`forwardTimeoutMs ?? FORWARD_TIMEOUT_MS`) | 同期のまま | 直列化のガードが無く、相関 id で並行に待つ形が既にできている |
| sessions/processes.ts:125-141 | `kill()` が SIGTERM / SIGKILL の後、`sleep(LIVENESS_POLL_MS)` で消滅をポーリング | 呼び出した 1 要求のみ。グローバルなガードは無い | あり (`GRACE_MS` 3000ms) | 同期のまま | 直列化のガードが無いので他を止めていない。ポーリングである点は残るが、プロセスの消滅を通知する primitive がこの経路に無い |
| instance/lock.ts | ファイルロックの取得 / 解放 | 該当なし | — | 同期のまま | lock を保持したまま外部の完了を await する箇所は無い。`acquireLock()` は起動時、`release()` は停止時にそれぞれ完結する |
| files/sandbox.ts:71-97 | — | 該当なし | — | 該当なし | `sandbox.grant` は人の承認を待つ設計ではない。`SandboxGrants.mint()` は同期に完結し、呼ばれた時点でトークンを発行する (コメント: "A grant widens nothing. The same containment check the matching read performs runs when the URL is minted")。承認の完了待ちでハンドラが止まる箇所は `src/` に無い |

## 件数

| 分類 | 件数 |
|---|---|
| (A) | 46 |
| (B) | 52 |
| (C) | 71 |
| (D) | 1 |

外部の完了待ちは 9 件を検分し、直すのが 3 件 (`daemon/supervise.ts` の `#over()`、`messaging/direct.ts` のセッション走査、`messaging/delivery.ts` の `retry()`)、判断を仰ぐのが 1 件 (`translate/translate.ts` の instance 単位の待ち行列)、設計どおりで同期のままが 5 件である。

## async 化する対象

(C) の 71 件のうち、`mesh/keys.ts:61` は fs IO でないため同期のまま、`instance/log.ts:25` は判断を仰ぐ。fold の seed に属する 6 件 (`transcript/tail.ts`) と群 3 の 2 件 (`transcript/files.ts` の `path()` / `find()`、`sessions/status.ts` の `canonicalSync`) は issue `fold-from-head-with-versioned-cache` で済。残る **63 件が async 化の対象**である。直し方の方向を、連鎖する範囲ごとにまとめる。**群 3 (topic の値を作る経路) は全件済み**で、同期のまま残したのは `sessions/last-live.ts` の `load()` だけで、これは `Sessions` の構築時に 1 回走る (B) である。

**1. file / dir / sandbox 系 op (`files/files.ts` 17 件 + `files/containment.ts` 2 件 + `launcher/tree.ts` `launcher/roots.ts` 2 件、計 21 件)**
`node:fs` の同期版を `node:fs/promises` (`readFile` / `writeFile` / `mkdir` / `stat` / `lstat` / `readdir` / `realpath` / `rename` / `unlink`) に、`openSync` + `readSync` + `closeSync` は `fs.promises.open()` が返す `FileHandle#read()` に置き換える。連鎖するのは `Containment` の `canonical()` を通る全メソッド (`locate` / `root` / `inbox` / `identify`) で、これが async になると file 系・dir 系・sandbox 系のハンドラがすべて async になる。ハンドラの戻り値は dispatch が `await` する形になっているので、呼び出し側の契約は変わらない。`find()` / `walk()` / `dirTree()` の再帰は async の再帰に変え、ディレクトリ 1 段ごとにイベントループへ譲る形になる。

**2. transcript を読む op (`sessions/search.ts` `sessions/fork.ts` `sessions/dump.ts` `sessions/items.ts` `transcript/read.ts` `transcript/files.ts`、計 24 件)**
`readFileSync(file, "utf8")` を `await readFile(file, "utf8")` に、`readSlice()` の `openSync` / `readSync` を `FileHandle#read()` に置き換える。連鎖するのは `sessionHandlers()` の `transcript.read` / `transcript.items.read` / `session.fork.origin.read` (現在は同期のハンドラ) が async になることと、`TranscriptFiles` の `all()` / `locate()` / `subjectOf()` が async になることである。`path()` / `find()` は `Transcripts.hold()` が tail を立てる経路でもあるので群 3 に回す (上の表)。64 MB を一息に読む `search()` / `forkOrigin()` は、読みを非同期にするだけでは行の走査が同期に残るので、候補ファイル 1 つごとに (必要なら数千行ごとに) `await` を挟んで譲る形にする。

**3. topic の値を作る経路 (`sessions/workspace.ts` 4 件 + `sessions/harness.ts` 2 件 + `sessions/registry.ts` 3 件 + `sessions/last-live.ts` 3 件、計 12 件)**
**済。** `sessionStatusOf()` は async 化済み。`UpstreamResource.snapshot` は `readonly TopicValue[] | Promise<readonly TopicValue[]>` を返す形になり、`Topics.subscribe` が await するので、購読の開始応答は値が揃ってから返る (CT-Q8)。`sessions/registry.ts` は `ownTranscript()` / `resolveAsFarAsItGoes()` が `fs/promises` の `realpath` / `stat` を await する形になり、連鎖は `metaOf()` から既に async な `register()` までで止まる。`sessions/last-live.ts` は `#save()` の書きを 1 本の鎖に連ねてあり、順序は保たれ、`flush()` が着地を待つ。`load()` の読みだけは `Sessions` の構築時に 1 回走るもので (B 分類)、接続を握る前なので同期のまま置く。

**`sessions/harness.ts` は読みと判定を分けて済んだ。** ディレクトリと状態ファイルは非同期に読み、読めた行 (pid 鍵) をメモリに持つ。`Sessions` の分類・行の組み立て・二重実行の判定はそのメモリを同期に読むので、`message.send` の配送判定・`last_live` の再計算・`peers` / `agents` の行組み立ては同期契約のまま残った。「今この瞬間のディレクトリ」に対して動くものは自分で読みを起こして待つ (`message.send` の宛先判定、`runsNow()` 経由でプロセスへ signal する op、`peers` / `agents` の開始フレーム = CT-Q8 で購読の開始応答が値を待てる形)。どちらも購読者の有無を問わないので、「セッションが存在する」は購読に依存しないまま (DESIGN §4.2)。

**0. 前提: 並行に走ることを当てにできる**
受信側に接続ごとの直列化が無い (`transport/driver.ts:33` の `void handle(...)`) ので、ハンドラを async にすれば、その await 中に同じ接続の他の op が実際に進む。つまり async 化の効果は「待ち時間が要求ごとに分かれる」ではなく「他の要求が本当に並行に答えられるようになる」である。逆に言えば、同期のまま残した 1 箇所が instance 全体を止め続けるので、経路のどこか 1 つに同期 fs が残ると、その経路を async 化した効果は消える。ハンドラ単位ではなく、入口から fs 呼び出しまでの経路を丸ごと直す必要がある。

**4. 永続化 (`kv/store.ts` 5 件 + `auth/records.ts` 5 件 + `messaging/inbox.ts` 2 件 + `messaging/direct.ts` 1 件、計 13 件)**
`#persist()` / `#append()` を `fs/promises` に置き換える。ここは書き込みの順序が意味を持つので、「前の書き込みの Promise に連ねる」直列化を入れる (同時に 2 つの書き込みが一時ファイルを取り合わないため)。

**読みと書きで行き先が違う。** 書きの連鎖は各 op ハンドラ (`kv.*` / `auth.*` / `message.send`) までで止まる — `auth` は `Auth` の `mint` / `rotate` / `remove` / `merge` を経て HTTP route と mesh の element 受信まで async になるが、いずれも既に async な経路の内側である。一方 **読みの `#load()` は op ハンドラでは止まらない**: `KvStore.snapshot()` と `AuthTopic.snapshot()` が呼んでおり、これらは同期契約の `UpstreamResource.snapshot` である。初回の Promise を保持して await する形にすると topic の「値を述べる」入口が Promise を返すことになり、群 3 と同じく CT-Q8 の裁定待ちになる。そこで読みは非同期化せず、**構築時に 1 回だけ同期で読む (B 分類) に寄せる** — `kv` は kv ディレクトリを readdir して全 namespace を、`auth` は `records.json` を読む。instance がこれらのファイルの唯一の書き手なので、遅延読みを前倒しても見えるものは変わらず、(C) の読みは消え、snapshot の契約も変わらない。起動後に生まれる namespace は、ファイルを持たない namespace としてメモリ上で空から始まる。

**5. 外部の完了待ち (3 件)**
`daemon/supervise.ts:283-285` の `#over()` は `answers.push(await op(unit))` を `Promise.allSettled(units.map(op))` に置き換える。対象リストを先に固定する現在の性質は保たれ、答えの並びも入力順のままになる。`messaging/direct.ts:292,321` の `#target()` / `#token()` は `readdir` の結果を `Promise.all` で読んでから一致を選ぶ形にする。`#target()` は現在 1 件目の一致で早期に返るので、全件読みに変えると読む量は増えるが、一致しない場合に全件読むのは今も同じで、掛かる時間は最も遅い 1 件ぶんになる。`messaging/delivery.ts:250-253` の `retry()` は sid ごとの `#offer` を並行に起こす。`#offer` が sid 単位のガード (`#offering` / `#claimed`) を既に持つので、1 通ずつ出すという sid 内の順序保証は保たれる。

これら 3 件はいずれもハンドラの内側で完結するので、呼び出し側への連鎖は無い。
