# 署名済み launcher 分離設計の先行事例調査と実験計画

- Date: 2026-09-09
- 対象構想: launchd に登録するのを `ccmsg daemon supervise` (bun スクリプト) ではなく、
  それを起動するだけの 1 バイナリ `ccmsg-launcher` (別リポ、codesign + notarize 済み) にし、
  TCC 権限 (FDA 等) を launcher に付与する。本体更新時に launcher を再署名・再登録しないで済むことを狙う。
- **本文書は調査と計画のみ。実装・launchd 登録・TCC 設定変更は行っていない。**

## 判明した事実

確定事実のみ。推測は「未確認」と明記する。

1. **launchd 経由で起動した素のバイナリは、TCC の responsible process が「バイナリの実体パス」になる。**
   バージョン管理されたパス (Homebrew Cellar 等) にあると、upgrade のたびに許可が失われる。
   (`~/.local/share/repos/github.com/kawaz/authsock-warden/main/docs/decisions/DR-012-app-bundle-wrapper.md`)
2. **codesign 済みでもこの問題は解決しない。** LaunchAgent 経由ではパスベース識別から逃れられない。
   (同 DR-012、`~/.local/share/repos/github.com/kawaz/cache-warden/main/docs/findings/2026-06-12-macos-tcc-responsible-process.md`)
3. **`.app` バンドル + launchd plist の `AssociatedBundleIdentifiers` で、responsible process が
   Bundle ID ベースになり、パスが変わっても許可が永続する。** (同上)
4. **symlink でパスを安定化させる案は効かない。** macOS は TCC チェック時に symlink を実体パスへ
   解決する (authsock-warden v0.1.11 で実証済みの失敗、DR-012 の選択肢 B)。
5. **`.app` 化しても `kTCCServiceSystemPolicyAppData` (他アプリのデータ) は LaunchAgent 経由で
   永続化せず、毎回ダイアログが出る。** FDA (`kTCCServiceSystemPolicyAllFiles`) は AppData を
   包含するため、FDA を ON にすれば解決する。
   (`~/.local/share/repos/github.com/kawaz/authsock-warden/main/docs/decisions/DR-014-macos-fda-tcc.md`)
6. **署名済み `.app` に付与した FDA は、その `.app` が spawn した別実行ファイルの子プロセスにも
   及ぶ。** 実証: cache-warden の `.app` が子として起動する 1Password CLI (バンドル外・第三者署名の
   別バイナリ) による保護ディレクトリへのアクセスが、`.app` の FDA で通っている (DR-014)。
   **これが本構想の核心と同型の先例である。**
7. **Apple はこの継承を「継承」と明言しておらず、"The system has various heuristics to determine
   this" と書く。** さらに **"it's possible to break this link ... such as trying to daemonise
   itself"** と、子が daemonise しようとするとリンクが壊れうると明記している。
   ([Apple DevForums 678819](https://developer.apple.com/forums/thread/678819), Quinn / Apple DTS)
8. **Apple は「スクリプトを main executable にすると TCC 問題を起こしやすい」と明記している。**
   *"TCC expects its bundled clients ... to use a native main executable. If your product uses a
   script as its main executable, you're likely to encounter TCC problems."* および
   *"the system can't distinguish file system operations done by the interpreter from those done by
   the script."* (同 678819)
9. **TCC の許可は code signing の designated requirement (DR) にひもづく。** Apple:
   *"This relies on your code having a stable code signing identity. If your code is unsigned, or
   signed ad hoc ... the system can't tell that version N+1 of your code is the same as version N,
   and thus you'll encounter excessive prompts."* (同 678819)。通常の Developer ID 署名の DR は
   `identifier "<bundle-id>" and certificate leaf[subject.OU] = "<TEAMID>"` の形であるため、
   再ビルドで cdhash が変わっても許可は維持される。
10. **TCC の Bundle ID ベース識別は codesign の有無に関わらず動作する。** codesign が必須なのは
    notarization / Gatekeeper 側の要件である。
    (`~/.local/share/repos/github.com/kawaz/cache-warden/main/docs/findings/2026-06-14-macos-tcc-fda.md`)
11. **`man launchd.plist` の `AssociatedBundleIdentifiers` の説明は「System Settings の Login Items
    UI 上の表示」だけで、TCC 帰属への効果は書かれていない。** TCC に効くという主張の出典は
    DevForums の Quinn の投稿と、上記リポの実証のみである。
12. **`responsibility_spawnattrs_setdisclaim` (`/usr/lib/system/libquarantine.dylib`) が
    responsibility チェーンを切る private API である。** `posix_spawnattr_setdisclaim_np` という
    名前の関数は存在せず、`POSIX_SPAWN_SETDISCLAIM` 定数も xnu の `spawn.h` に無い (実機の dlsym /
    ヘッダ確認)。Apple の公開文書には一切記載がない。
13. **launchd 配下から起動した 1Password CLI は、biometric プロンプトが GUI セッションに届かず
    無限にブロックし、daemon の起動シーケンス全体を止めた実インシデントがある。** 対処は子プロセスへの
    wall-clock cap (30 秒) でハングをエラーとして表面化させること。
    (`~/.local/share/repos/github.com/kawaz/cache-warden/main/crates/cache-warden-authsock/src/op.rs`,
    同リポ `docs/journal/2026-06-17-cw-discovery-block-incident.md`)
14. **`.app` を `open` で起動すると macOS がその `.app` を FDA リストに自動追加する。** ユーザは
    「+」ボタンでの手動追加が不要になり、トグルを ON にするだけでよい (DR-014)。
15. **`.app` を含むプロダクトは Homebrew Formula で配布できない。** Formula の tarball stripping が
    単一トップレベルディレクトリを展開先ルートへ strip して `.app` を壊す (実証済み)。Cask 一本にし、
    tarball には `.app` と bare binary の両方を入れてトップレベルを 2 エントリにする。
16. **現行 ccmsg の launchd plist は `[bun の実体パス, エントリスクリプト, "daemon", "supervise"]` を
    `ProgramArguments` に焼き込んでいる** (`src/service/service.ts` の `supervisorCommand`)。
    これは事実 1・8 の両方に該当する構造である。

### 未確認 (推測の域を出ない点)

- 子が未署名 / ad-hoc 署名の実行ファイルでも帰属が保たれるか。先例の子は正規署名バイナリだった。
- `exec` で launcher 自身が別バイナリに置き換わった後も `AssociatedBundleIdentifiers` の関連付けと
  Bundle ID 帰属が保たれるか。
- `unregister` → `register` (plist の削除・再作成) で TCC 許可が保たれるか。TCC の記録は plist と
  独立しているため残ると見込むが、裏付けはない。
- hardened runtime / library validation が responsible process の判定そのものに関与するか。
  これらは dylib ロード可否のレイヤであり別物と読めるが、一次資料は見つからなかった。

## 実用的な示唆

1. **分離設計は成立する見込みが高い。** 事実 6 が構想と同型の実証であり、事実 8 は「スクリプトを
   main executable にするな」という Apple 側からの積極的な後押しになっている。
2. **launcher は bare な署名済みバイナリではなく `.app` バンドルでなければならない。** 事実 2 より、
   署名だけではパスベース帰属から逃げられない。配布物は `Ccmsg.app/Contents/MacOS/ccmsg-launcher`
   であって、単体バイナリではない。
3. **本体更新で launcher を触らずに済む条件は満たせる。** TCC 許可は launcher の `.app` の DR に
   ひもづく (事実 9) ので、子の bun / 本体スクリプトは署名不要・再 notarize 不要。Gatekeeper は別軸
   だが、パッケージマネージャ経由で入るファイルは通常 quarantine 属性を持たないため、本体を
   ダウンロード zip で配らない限り問題にならない。
4. **副次的な改善として plist の更新も不要になる。** `ProgramArguments` が launcher 固定になるため、
   bun の実体パスがバージョン管理ツールで変わっても plist を書き換える必要がなくなる。現行の
   `process.execPath` 焼き込み (事実 16) より堅い。
5. **`exec` 型ではなく spawn 監督型を第一候補にする。** 先例 (事実 6) と同型なのは spawn 型であり、
   `exec` 型の帰属保持は未確認。ただし `exec` 型が動くなら launcher は最小で済むので、実験で潰す
   価値はある。KeepAlive による再起動は launchd 側が担うので、launcher の責務は「子の終了コードで
   自分も終わる」「シグナルを子へ転送する」程度に留め、二重スーパーバイズを作らない。
6. **設計に入る前に「そもそも何の TCC 権限が要るのか」を確定させる。** Claude Code の transcript が
   置かれる dot ディレクトリは TCC 保護対象外であり、保護に当たるのは 1Password CLI 経由の他アプリ
   データ、`~/Desktop` / `~/Documents` / `~/Downloads`、他アプリの Application Support である。
   要るのが 1Password 経路だけなら、launcher の目的はそこに絞られ設計判断が単純になる。
7. **launchd 配下から 1Password CLI を呼ぶなら、子プロセスに必ず timeout を被せる** (事実 13)。
   launcher を入れて TCC を通しても、biometric が GUI に届かないケースは別問題として残る。
8. **FDA 誘導 UX は先行事例のものがそのまま移植できる。** `open --wait-apps` での `.app` 起動 →
   FDA リスト自動追加 → 設定画面を URL スキームで開く → 低頻度ポーリングで ON を検出して自動続行、
   という流れが実装済みで、`LSBackgroundOnly` の `.app` は stderr にノイズを出すため捨てる、
   という注意点まで記録されている。
9. **TCC 変化を非公開通知で検知しようとしない。** 権限状態の正本は `.app` 再起動 probe の結果とし、
   通知は wake-up hint 止まりにして fallback timer を必ず残す
   (`~/.local/share/repos/github.com/kawaz/cache-warden/main/docs/findings/2026-08-12-tcc-change-event-feasibility.md`)。

## 検証の詳細

### 先行事例の知見表

| 項目 | 何が起きたか | どう解決したか | 出典 |
|---|---|---|---|
| LaunchAgent の TCC 帰属 | responsible process がバイナリの実体パスになり、upgrade でパスが変わるたび許可が失われる | `.app` + `AssociatedBundleIdentifiers` で Bundle ID ベースへ | authsock-warden `docs/decisions/DR-012-app-bundle-wrapper.md`、cache-warden `docs/findings/2026-06-12-macos-tcc-responsible-process.md` |
| codesign だけでは不足 | Developer ID 署名済みでもパスベース識別のまま | 同上 (`.app` 必須) | 同 findings 「判明した事実 2」 |
| symlink でのパス安定化 | 失敗。TCC が symlink を実体パスへ解決する | 案を破棄し `.app` へ | DR-012 選択肢 B |
| `.app` 化しても残る穴 | AppData カテゴリは LaunchAgent 経由で永続化せず毎回ダイアログ | FDA を ON にする (FDA は AppData を包含) | authsock-warden `docs/decisions/DR-014-macos-fda-tcc.md` |
| FDA 状態の判定法 | 専用 API がない | システムの TCC データベースの stat 可否で判定 (読むこと自体に FDA が要る)。OFF と未登録は区別不能 | DR-014、cache-warden `crates/cache-warden-cli/src/fda.rs` |
| FDA 登録の UX | ユーザに「+」で手動追加させるのは厳しい | `open --wait-apps` で `.app` 起動 → 自動追加。設定画面を URL スキームで開き、低頻度ポーリングで ON 検出 → 自動続行 | DR-014 |
| CLI 直実行だと誤判定 | CLI を直接叩くとターミナルの FDA を見てしまう | 必ず `open` で `.app` として起動してチェックする | DR-014 |
| `LSBackgroundOnly` のノイズ | `open --wait-apps` が stderr に "Unable to find a bundle ... to block on." を出す (動作は正常) | stderr を捨てる | DR-014 |
| codesign の順序 | `--deep` はネストバンドルの署名順序を保証せず Apple も非推奨 | bottom-up (内側バイナリ → 内側 `.app` → 外側バイナリ → 外側 `.app`) の 4 段 | cache-warden `.github/workflows/release.yml` の署名ステップ |
| notarize / staple | — | 一時 keychain 作成 → p12 import → codesign → `notarytool store-credentials` → `submit --wait` → `stapler staple` → keychain を `always()` でクリーンアップ | 同 release.yml、cache-warden `docs/runbooks/apple-signing-secrets-setup.md` |
| notarize の 403 | ライセンス条項の再同意が要ると 403 | runbook に即断診断表 | cache-warden `docs/runbooks/release-notarization-403.md` |
| Homebrew 配布 | Formula の tarball stripping が `.app` を壊す。Formula + Cask 同名共存も不可 | Cask 一本。tarball に `.app` と bare binary の両方を入れる | 同 release.yml の package / cask ステップ |
| バイナリパスの焼き込み | `current_exe()` を直に焼くと開発時パスやバージョン付きパスが入り壊れる | 安定パスへ解決するライブラリを通し、`.app` 配下ならその `.app` を指す | cache-warden `docs/decisions/DR-0019-daemon-service-registration.md` §2.5 |
| launchd 配下の 1Password CLI | biometric が GUI セッションに届かず無限ブロック、daemon 起動を止めた | 子に 30 秒の wall-clock cap を被せてエラー化 | cache-warden `crates/cache-warden-authsock/src/op.rs`、`docs/journal/2026-06-17-cw-discovery-block-incident.md` |
| 1Password CLI の生体認証要求範囲 | `--version` / `--help` 以外は session 確立で生体認証を要求する。調査時に「在席不要」と誤分類した | findings 冒頭に訂正注記 | cache-warden `docs/findings/2026-06-14-op-cli-failure-categorization.md` |
| TCC 変化のイベント購読 | 通知名は実在するが非公開。payload を運べず、データベースの WAL 監視も不完全 | 正本は `.app` 再起動 probe。通知は hint 止まり + fallback timer | cache-warden `docs/findings/2026-08-12-tcc-change-event-feasibility.md` |
| 本体をリロードせず更新 (隣接事例) | 走行中の子を殺さず新バイナリへ切り替えたい | 同一 PID のまま `execve` する self-exec + fd の CLOEXEC 解除で引き継ぎ | hyoui `docs/decisions/DR-0028-daemon-graceful-upgrade-self-exec.md` |

hyoui 側に署名・notarize・TCC の実績は無い (`codesign` の grep が DR-0028 の 1 件のみ)。署名系の知見は
cache-warden と authsock-warden に集中している。

### TCC 帰属の整理

#### 起動経路 → responsible process

| 起動経路 | responsible process | 永続性 |
|---|---|---|
| ターミナル → shell → バイナリ | ターミナルアプリの Bundle ID | 永続 |
| launchd → 素バイナリ (署名有無を問わず) | バイナリの実体パス | パスが変わると消失 |
| launchd → `*.app/Contents/MacOS/` 内バイナリ + plist の `AssociatedBundleIdentifiers` | `.app` の Bundle ID | パス変化に耐えて永続 |
| `open X.app` | `.app` の Bundle ID | 永続 + FDA リストへ自動追加 |

#### 子プロセスへの帰属

| 条件 | 帰属先 | 根拠 |
|---|---|---|
| 親が `.app` の main executable、子が spawn した別の実行ファイル (バンドル外) | 親の `.app` の Bundle ID | 実証。上記事実 6 (authsock-warden DR-014) |
| 一般論としての機構 | 親の responsible code を継承 | Apple は "heuristics" とのみ記述。カーネル側は `proc_t::p_responsible_pid` ([DevForums 678819](https://developer.apple.com/forums/thread/678819)、[Qt: The Curious Case of the Responsible Process](https://www.qt.io/blog/the-curious-case-of-the-responsible-process)) |
| 子が daemonise しようとする等の動作をする | リンクが壊れうる | 同 678819 |
| 明示的に切る場合 | 子が自分自身の responsible になる | `responsibility_spawnattrs_setdisclaim` (private API、Apple 文書なし) |
| スクリプトを main executable にした場合 | 破綻しやすい | 同 678819 (事実 8) |
| 未署名 / ad-hoc 署名の子 | **未確認** | 先例の子は正規署名バイナリだった |

#### 許可エントリのキー

TCC データベースの `access` テーブルは `service` / `client` / `client_type` (0 = Bundle ID、
1 = 絶対パス) / `csreq` / `auth_value` を持つ。出典は Apple 公式ではなく解析記事
([Huntress: Full Transparency — Controlling Apple's TCC, Part 2](https://www.huntress.com/blog/full-transparency-controlling-apples-tcc-part-ii))。
`csreq` は designated requirement の blob で、同一 DR を満たすかで同一性が判定される。
ad-hoc 署名の DR が cdhash ベースになる (= ビルドごとに別プログラム扱い) という点は二次資料ベースで、
Apple の技術ノート本文は未取得。

### 分離設計の評価

#### 現行構造の問題点

`src/service/service.ts` の `supervisorCommand()` は `ProgramArguments` に
`[bun の実体パス, エントリスクリプト, "daemon", "supervise"]` を焼き込む。上の整理に照らすと:

- responsible process が bun の実体パスになる。bun をバージョン管理ツールで上げるたびに TCC 許可が
  消える (事実 1)。
- main executable が実質スクリプトであり、事実 8 に該当する。
- Bundle ID のアンカーが無いため、`.app` 化しない限りこの構造からは出られない。

#### `exec` 型 vs spawn 監督型

| | `exec` 型 (launcher が bun に置き換わる) | spawn 監督型 (launcher が親として残る) |
|---|---|---|
| 先行事例との同型性 | なし | あり (事実 6 と同じ形) |
| `.app` の main executable | プロセスイメージが置換される。帰属が保たれるか未確認 | 常に生きている |
| `AssociatedBundleIdentifiers` の関連付け | 置換後も残るか未確認 | 変化なし |
| PID | 保存される | launcher と子で 2 つ |
| 複雑さ | 最小 | 子の終了伝播・シグナル転送が要る |

#### 本体更新時に launcher を変えずに済む条件

| 軸 | 判定 |
|---|---|
| TCC | 満たせる。許可は launcher の `.app` の DR にひもづき、子は署名不要 |
| Gatekeeper / notarize | 本体更新は再 notarize 不要 (条件付き)。quarantine 属性が付く配布経路 (ダウンロード zip 等) を使う場合のみ別途必要 |
| plist | 更新不要になる。`ProgramArguments` が launcher 固定になるため |
| launcher が知るべき可変情報 | bun の場所と本体エントリの場所。ハードコードすると分離の意味が薄れるため、設定ファイルか `.app` 隣の固定パスから読む設計が要る (実装判断は当事者へ) |

#### 許可が失われる条件

| 操作 | 許可は残るか |
|---|---|
| 本体 (bun / 本体スクリプト) の更新 | 残る (帰属先が launcher なので無関係) |
| launcher を同じ Developer ID + 同じ bundle id で再署名・再リリース | 残る (DR が一致するため。cdhash 変化は無関係) |
| bundle id の変更 / Team ID の変更 / Developer ID から ad-hoc への変更 | 失われる |
| `.app` の設置パスが変わる | 残る (Bundle ID 帰属の本来の目的) |
| `unregister` → `register` | 残ると見込む (**未確認**)。`.app` 自体を消して入れ直すと FDA リストからの消失があり得る |
| ad-hoc 署名で開発を回す間 | ビルドごとに再プロンプト |

#### launcher リポの最小構成案

実装の断定はしない。形の候補として:

```
ccmsg-launcher/
  src/main.(swift|go|rs)            # ネイティブ Mach-O。責務は「子を起動して看取る」だけ
  Info.plist                        # CFBundleIdentifier = com.github.kawaz.ccmsg
                                    # CFBundleExecutable = ccmsg-launcher
                                    # CFBundlePackageType = APPL
                                    # LSBackgroundOnly = true
  .github/workflows/release.yml     # cache-warden の署名・notarize ステップを移植
  justfile
  docs/decisions/DR-0001-...        # 分離の設計判断
```

plist 側:

```xml
<key>ProgramArguments</key>
<array><string>/Applications/Ccmsg.app/Contents/MacOS/ccmsg-launcher</string></array>
<key>AssociatedBundleIdentifiers</key>
<array><string>com.github.kawaz.ccmsg</string></array>
```

言語は、ネイティブ Mach-O でありさえすれば署名要件上はどれでも同じ。bundle id は現行の
`LAUNCHD_LABEL` (`src/service/service.ts`) と揃えるのが自然。

未解決の設計論点 (当事者が決めるべき):

1. 本体の `service register` が launcher を検出して plist を書き分けるのか、launcher 側が
   register を持つのか。先行事例は前者で、`.app` 検出と `AssociatedBundleIdentifiers` 付与の
   実装が cache-warden `crates/cache-warden-cli/src/commands/daemon_cmd.rs` にある。
2. FDA 誘導 UX を移植するか。
3. そもそも FDA が要るのか (下記の実験 0)。

### 実験計画

いずれもまだ実行していない。

#### 実験 0 — 必要な権限の特定 (最優先、承認不要・破壊なし)

本体が本当に TCC 保護リソースに触るのかを先に確定する。Claude Code の transcript が置かれる
dot ディレクトリは保護対象外であり、保護に当たるのは 1Password CLI 経由の他アプリデータ、
`~/Desktop` / `~/Documents` / `~/Downloads`、他アプリの Application Support である。1Password 経路
だけなら launcher の目的はそこに絞られる。現行 daemon のコードとログを読めば答えが出るので、
実験 1 の前に実施する。

#### 実験 1 — 子への TCC 帰属の継承 (核心)

仮説: ad-hoc 署名の `.app` を LaunchAgent 経由で起動し、その子として bun を spawn すると、
bun からシステムの TCC データベースを読める (= `.app` に付けた FDA が子に及ぶ)。
事実 10 より、Bundle ID 帰属の検証に正規署名は不要で ad-hoc で足りる。

1. 一時ディレクトリに使い捨ての `TccProbe.app` を作る。main executable は数十行のネイティブ
   プログラムで、子として `bun probe.ts` を spawn し、その終了コードを結果ファイルへ書く。
   `Info.plist` は `CFBundleIdentifier = com.github.kawaz.tcc-probe`, `LSBackgroundOnly = true`。
2. `codesign -s - --force` で ad-hoc 署名。
3. `probe.ts` はシステムの TCC データベースの stat を試み、可否を結果ファイルへ書く。
4. `~/Library/LaunchAgents/com.github.kawaz.tcc-probe.plist` を書き、`ProgramArguments` を
   `.app` 内バイナリに、`AssociatedBundleIdentifiers` を上記 bundle id にして bootstrap する。
5. FDA OFF のまま実行し、「読めない」を確認する (ネガティブコントロール)。
6. `open --wait-apps` で `.app` を起動して FDA リストへ自動登録させ、System Settings で
   `TccProbe` のトグルのみ ON にする。
7. `launchctl kickstart -k` で再実行し、子 (bun) が TCC データベースを読めるかを確認する。

判定基準: 手順 7 で子が読めれば分離設計は成立。読めなければ TCC は exec ホップを越えないことになり、
launcher 案は根本から再検討 (bun 自体を `.app` 内に同梱する等) となる。

補助観測: `sudo launchctl procinfo <子の pid>` の responsible 行を直接確認できれば判定が一発で付く。

片付け (実験後に必ず): LaunchAgent の bootout、plist 削除、System Settings の FDA リストから
`TccProbe` を削除、一時ディレクトリの `.app` 削除。

#### 実験 2 — `exec` 型 vs spawn 監督型 (実験 1 が成功した場合のみ)

同じ probe の main を `execv` に差し替えて手順 7 を再実行する。読めれば `exec` 型も可 (launcher が
最小で済む)。読めなければ spawn 監督型で確定。

#### 実験 3 — 本体更新の耐性

実験 1 の状態で `probe.ts` を書き換え、bun のパスも別バージョンに差し替えて再 kickstart する。
許可が残っていれば「本体更新で launcher 不変」が実証される。

#### kawaz の承認が要る操作

- `launchctl bootstrap` / `bootout` による LaunchAgent の登録・解除 (使い捨てラベル
  `com.github.kawaz.tcc-probe` のみ。既存の ccmsg のサービスには一切触れない)
- `~/Library/LaunchAgents/` への新規ファイル書き込み
- System Settings > Privacy & Security > Full Disk Access での `TccProbe` のトグル ON、および
  実験後のリストからの削除 (既存の許可には触れない)
- `sudo launchctl procinfo` (root 権限)

`tccutil reset` や TCC データベースの直接編集は行わない (既存の許可を巻き添えにするため)。

## 出典一覧

ローカルの一次資料 (いずれも `~/.local/share/repos/github.com/kawaz/` 配下):

- `authsock-warden/main/docs/decisions/DR-012-app-bundle-wrapper.md`
- `authsock-warden/main/docs/decisions/DR-014-macos-fda-tcc.md`
- `authsock-warden/main/docs/macos-tcc-fda.md`
- `cache-warden/main/docs/findings/2026-06-12-macos-tcc-responsible-process.md`
- `cache-warden/main/docs/findings/2026-06-14-macos-tcc-fda.md`
- `cache-warden/main/docs/findings/2026-06-14-op-cli-failure-categorization.md`
- `cache-warden/main/docs/findings/2026-08-12-tcc-change-event-feasibility.md`
- `cache-warden/main/docs/decisions/DR-0019-daemon-service-registration.md` (§2.5 が `.app` レイヤ)
- `cache-warden/main/docs/decisions/DR-0020-macos-signing-and-app-bundle.md`
- `cache-warden/main/docs/runbooks/apple-signing-secrets-setup.md`
- `cache-warden/main/docs/runbooks/release-notarization-403.md`
- `cache-warden/main/.github/workflows/release.yml` (`.app` 生成・署名・notarize・package・cask)
- `cache-warden/main/crates/cache-warden-cli/src/commands/daemon_cmd.rs` (`.app` 検出と `AssociatedBundleIdentifiers`)
- `cache-warden/main/crates/cache-warden-authsock/src/op.rs` (launchd 下でのハング対策)
- `hyoui/main/docs/decisions/DR-0028-daemon-graceful-upgrade-self-exec.md`

本リポ: `src/service/service.ts` (現行の launchd plist 生成)

手順書: `rules-personal` の `macos-signing-notarization` skill (`tcc-app-bundle.md` /
`ci-release-pipeline.md` / `setup-certificates.md` / `troubleshooting.md`)

外部:

- [Apple DevForums 678819 — On File System Permissions](https://developer.apple.com/forums/thread/678819) (Quinn)
- [Apple DevForums 731504 — What is a responsible process?](https://developer.apple.com/forums/thread/731504) (Quinn)
- [Apple TN3127 — Inside Code Signing: Requirements](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements) (本文未取得)
- [Qt — The Curious Case of the Responsible Process](https://www.qt.io/blog/the-curious-case-of-the-responsible-process)
- [ghostty-org/ghostty issue #9263](https://github.com/ghostty-org/ghostty/issues/9263)
- [apple-oss-distributions/xnu — bsd/sys/spawn.h](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/spawn.h)
- [Huntress — Full Transparency: Controlling Apple's TCC (Part 2)](https://www.huntress.com/blog/full-transparency-controlling-apples-tcc-part-ii)
- ローカルの `man launchd.plist`
