# テストの稀な timeout は `$TMPDIR` の肥大が原因だった

## 症状

full suite で `test/llm-read.test.ts` の最初のテストが稀に 5 秒 timeout し、二次エラーとして `expect(answer.generated_at).toBe(NOW)` が `Received: undefined` で出る。単独実行では再現しない。

## 原因

テストの root を `$TMPDIR` 配下に `mkdtemp` で作り、多くのテストが消していなかったので、`$TMPDIR` が 248,356 エントリ (ccmsg-mesh 79k / ccmsg-instance 32k / …) に膨らんでいた。Bun はモジュール解決で祖先ディレクトリを読むため、プロセス内で最初の設定ファイル `import()` (`src/instance/config.ts` の `called`) が巨大な readdir を払う。無負荷で初回 `start()` 約 1.1 秒 (2 回目以降は数十 ms)、負荷が乗ると 5 秒を超える。full suite で 2 番目に走るこのファイルの最初の `start()` がプロセス全体の初回コストを負担するので、落ちるのがいつもこのテストになる。

bun は timeout してもテスト本体を止めず `afterEach` を走らせるので、fake gateway が止まった後に本体の fetch が "Unable to connect" → `{ok:false}` になり、それを無検査で cast していた assert が `undefined` を報告していた。

## 対処

- `just test` は `/tmp` 配下に作った小さな専用ディレクトリを `TMPDIR` にして走らせ、終了時に消す (`$TMPDIR` の中に作ると祖先に巨大な T が残るので効かない)
- root を作るテストは `afterEach` で `rmSync` する (`plugin.test.ts` の `dirs` 方式)。`auth.test.ts` は await していない link の merge があるので、削除の前に `settleLinks` で待つ
- 成功を期待する呼び出しは cast の前に `expect(answer).toMatchObject({ ok: true })` で確かめ、失敗時に `error.code` / `msg` が差分に出るようにした
- 既存の残骸は `find "$TMPDIR" -maxdepth 1 -name 'ccmsg-*' -mtime +1 -exec rm -rf {} +` で掃除した (248k → 21k)

## 覚えておくこと

最初の `import()` のコストは祖先ディレクトリの大きさに比例する。本番の config は XDG 配下で祖先が小さいので実害は薄いが、`$TMPDIR` 直下のような大きなディレクトリに `.ts` を置いて import する経路を足す時は同じ罠を踏む。
