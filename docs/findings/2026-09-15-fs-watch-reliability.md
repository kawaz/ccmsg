# macOS / Bun の `fs.watch` は何を報告し、何を報告しないか

- Date: 2026-09-15
- 環境: Darwin 25.5.0 (arm64)、Bun 1.3.13、APFS、`$TMPDIR` 配下の temp dir のみ (`~/.claude*` と実 hyoui の socket dir には触れていない)

## 判明した事実

- **watch 中のディレクトリへの変化は落ちない**。同一プロセス / 別プロセス、負荷あり / なし、連打 / 単発のいずれでも取りこぼし 0 だった (下表)。遅延も最大 107ms で、ディレクトリ watch が「数十秒遅れる」という挙動は再現しなかった。
- **落ちるのは watch を張る瞬間と競合した変化だけ**。`watch()` の直後に変更する形を負荷下で 600 回試し、5 回 (0.8 %) 報告されなかった。これは event の消失であって watch の故障ではなく、その後の変化は報告された (競合を観測した 1 件は次の変化で復帰、恒久的に死んだ watch は 0 件)。
- **無いディレクトリには watch を張れない**。`watch()` が `ENOENT: no such file or directory, watch '<path>'` を throw する。
- **watch 中のディレクトリが消えたことは報告されない**。10 秒待っても event は 0 件だった。
- **ディレクトリの出現・消滅は親ディレクトリの watch が報告する** (`rename <name>`、11ms)。ただし親の watch は**子ディレクトリの中身**については何も言わない (子の中にファイルを作っても event 0 件)。
- **watch は inode ではなく path に付く**。watch 中のディレクトリを削除して同じ path に作り直すと、最初に張った watcher が新しいディレクトリの中身の変化を報告した (23ms)。

## 実測マトリクス

| 条件 | 操作数 | 取りこぼし | 遅延 (p50 / max) |
|---|---|---|---|
| 同一プロセスから create / rewrite / remove | 120 | 0 | 51ms / 53ms |
| 20 連打バーストの最終変化、CPU 占有 8 本 | 30 | 0 | 26ms / 38ms |
| 別プロセス (shell / unix socket の bind / unlink)、CPU 占有 24 本 | 75 | 0 | 52ms / 79ms |
| 同上、`bun test` フルスイート (1170 件 / 44 秒) と並走 | 270 | 0 | 51ms / 107ms |
| **watch を張った直後に変更**、スイート並走 | 600 | 5 (0.8 %) | 12ms / 54ms |
| 上で落ちた後に再度変更 (復帰するか) | 500 | 恒久 lost 0 | — |

## 判定の材料としての意味

- `terminals` は socket の出入りを watch で取り、周期 poll を持たない。**張った 500ms 後に 1 回だけ読み直す**のは、上表で唯一落ちる「張りと競合した変化」を拾うためであり、購読 1 回につき 1 回である。
- socket dir / `sessions/` は**すぐ上の実在ディレクトリにも watch を張る**。ディレクトリ自身の出現と消滅は、そのディレクトリに張った watch では取れないためである。
- `agents` (`sessions/`) の 5 秒確認 poll を残す判断はこの実測とは別で、ccmsg 以外の経路で起動した harness を確実に拾うため、および状態ファイルを残したまま死んだプロセスのように**ディレクトリが動かないまま答えが変わる**変化を拾うためである。

## 再現方法

各行は temp dir に watch を張り、1 操作ごとに「報告されたか / 何 ms かかったか」を記録する使い捨てスクリプトで測った。負荷は `while :; do :; done` の子プロセス N 本、または本リポの `bun test` を並走させて与えている。socket 行は `python3 -c "import socket;s=socket.socket(socket.AF_UNIX);s.bind('x.sock')"` を子プロセスとして起こし、unlink まで含めて 1 往復とした。

## path か inode か (2026-09-16 追加検証)

Darwin 25.5.0、Bun 1.3.13、APFS 上で、各 iteration に固有のディレクトリを使い、watch 開始後と複合操作の各段階の後に 120ms の観測窓を設けて各ケースを 30 回測った。表の「通知」は対象操作を行った観測窓で callback が 1 回以上呼ばれた回数であり、括弧内は `eventType filename` である。

| watch 対象 | 操作 | 非再帰 | 再帰 | 通知が指す path |
|---|---|---:|---:|---|
| 親 dir | 子 dir を作成 | 30/30 (`rename child`) | 30/30 (`rename child`) | 親から見た `child` |
| 親 dir | 子 dir を削除 | 30/30 (`rename child`) | 30/30 (`rename child`) | 親から見た `child` |
| 親 dir | `child` を `child2` に rename | 30/30 (`rename child`, `rename child2`) | 30/30 (`rename child`, `rename child2`) | 親から見た旧名と新名 |
| 親 dir | `child/x` を作成 | 0/30 | 30/30 (`rename child/x`) | 再帰 watch だけが親から見た `child/x` を報告 |
| 親 dir | `child` を親の外へ `mv` | 30/30 (`rename child`) | 30/30 (`rename child`) | 元の親から見た `child` |
| 親 dir | 外の `child` を親へ戻す | 30/30 (`rename child`) | 30/30 (`rename child`) | 戻り先の親から見た `child` |
| dir | watch 中の `dir` を `dir2` へ `mv` | 0/30 | 0/30 | watch 対象自身の移動は報告しない |
| dir | `dir2` へ `mv` 後、`dir2/x` を編集・`dir2/y` を作成 | 0/30 | 0/30 | 移動先 inode の変更は報告しない |
| dir | `dir2` へ `mv` 後、元の `dir` を新規作成 | 0/30 | 0/30 | 元 path の dir 自身の再作成は対象 watch には報告しない |
| dir | 元の `dir` を新規作成後、`dir/new` を作成 | 30/30 (`rename new`) | 30/30 (`rename new`) | watch 開始時と同じ元 path の新しい dir |
| symlink `link → real` | `real/x` を作成 | 30/30 (`rename x`) | 30/30 (`rename x`) | watch 開始時に解決した `real` 内の `x` |
| symlink `link → real1` | link を `real2` へ差し替え | 0/30 | 0/30 | link 自身の差し替えは報告しない |
| symlink `link → real1` | link の差し替え後、`real1/old` を作成 | 30/30 (`rename old`) | 30/30 (`rename old`) | 差し替え前に解決した `real1` 内の `old` |
| symlink `link → real1` | link の差し替え後、`real2/new` を作成 | 0/30 | 0/30 | 新しい link の向け先は報告しない |
| symlink `link → real` | `real` を削除 | 0/30 | 0/30 | watch 対象として解決済みの実体 dir 自身の削除は報告しない |
| symlink `link → real` | `real` を同じ path に作り直す | 0/30 | 0/30 | 実体 dir 自身の再作成は報告しない |
| symlink `link → real` | 作り直した `real/new` を作成 | 30/30 (`rename new`) | 30/30 (`rename new`) | watch 開始時に解決した実体 path の新しい dir |
| real dir | symlink 経由で `real/x` を作成 | 30/30 (`rename x`) | 30/30 (`rename x`) | watch 対象の実体 dir 内の `x` |
| file | watch 中の file を `file2` へ `mv` | 30/30 (`rename file`) | — | watch 開始時の basename `file` |
| file | `file2` へ `mv` 後、移動先 file を編集 | 1/30 (`change file`) | — | 29/30 は通知なし。継続的な inode 追従として利用できない |
| file | `file2` へ `mv` 後、元 path に新 file を作成・編集 | 0/30 | — | 元 path の新 file も報告しない |

### 結論

- `fs.watch(dir)` は非再帰・再帰とも、watch 中の dir が `mv` された後は移動先 inode の変更を報告せず、元 path に置かれた新しい dir の変更を報告した。この条件では dir watch は inode でなく path に追従する。
- `fs.watch(link)` は link 自体でなく、watch 開始時に解決した実体 dir の path に追従する。link の差し替えでは新しい向け先へ移らず、元の実体 path を削除・再作成した場合はその新しい dir を報告する。
- `fs.watch(file)` は `mv` を `rename file` として報告した後、移動先 inode にも元 path の新 file にも安定して追従しない。ファイル単体 watch には dir watch の path 追従を一般化できない。

`DirectoryWatch` が対象 dir と上位 dir の 2 本を監視する前提は、この実測範囲で成り立つ。対象 dir の中身は対象 watch が報告し、対象 dir の作成・削除・rename・親外への出入りは上位 watch が報告する。対象 dir が別 path へ移された後の変更は追う必要がなく、元 path に新しい dir が置かれた後の変更は既存の対象 watch が報告するため、同一 path の置換だけを理由に対象 watch を張り直す必要はない。symlink path を対象 dir として許す場合だけは別で、link の向け先変更を追うには link の親を監視して link の差し替え時に対象 watch を閉じて張り直す必要がある。

Bun の `process.versions` は `uv: 1.48.0` を含む一方、Bun 実行ファイルの動的リンク一覧に FSEvents framework は現れなかった。しかし `watch.toString()` は native code とだけ表示され、この観測から Bun 1.3.13 の Darwin backend が kqueue と FSEvents のどちらかは確定できない。実装方式は未確認であり、ここで確認したのは Node 互換 API の実挙動である。

### 再現方法

プローブは `/tmp/fswatch-probe2/probe-isolated.js`、全イベントを含む結果は `/tmp/fswatch-probe2/results-isolated.json` に置いた。`cd /tmp/fswatch-probe2 && bun probe-isolated.js > results-isolated.json` で再実行できる。プローブは `/tmp/fswatch-probe2/isolated/` だけを操作し、各 iteration に固有の path を使う。
