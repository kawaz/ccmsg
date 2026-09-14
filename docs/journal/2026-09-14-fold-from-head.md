# transcript を頭から畳む — 購読開始の待ちと instance の応答性の計測

対象: issue `fold-from-head-with-versioned-cache` の受け入れ条件「大きい transcript (数十 MB) の購読開始で instance が固まらない」。

## 何を測ったか

1 セッションぶんの transcript (1 record ≒ 370 B、`{type:"user", uuid, cwd, timestamp, message}`) だけを置いた config home で instance を起動し、1 本の接続から

1. `topic.subscribe` (`transcript.items:<sid>`) を投げる
2. 50 ms 後、同じ接続で `instance.ping` を投げる
3. 2 つの応答が返った時刻を、それぞれの要求時刻からの差として記録する

を、cache が無い状態 (cold) と、直前の購読が残した cache がある状態 (warm) で 1 回ずつ行う。

計測スクリプトはリポジトリに残していない。同じ形の assert は `test/async-transcript.test.ts` の「and from the middle of the read a subscription opens with」が持つ (順序と比率だけを見て、絶対値には依らない)。

## 実行

```
bun run fold-measure.ts 200000
bun run fold-measure.ts 600000
```

`fold-measure.ts` は上の 1〜3 を行う使い捨てスクリプト (mkdtemp した config home、`CCMSG_CACHE_DIR` も同じ temp 配下)。

## 数字 (macOS 25.5.0 / Bun 1.3.13 / APFS)

| transcript | records | 状態 | subscribe の応答 | 同じ接続の ping の応答 |
|---|---|---|---|---|
| 70.4 MiB | 200,000 | cold | 444 ms | 0.9 ms |
| 70.4 MiB | 200,000 | warm | 52 ms | 0.7 ms |
| 211.5 MiB | 600,000 | cold | 1308 ms | 1.2 ms |
| 211.5 MiB | 600,000 | warm | 52 ms | 0.6 ms |

warm の 52 ms は ping を投げるまでの `Bun.sleep(50)` がそのまま出ているので、cache から再開した購読の実質は 2 ms 前後である。

## 読み取れること

- **購読者は待つが、instance は待たない。** 211 MiB を頭から畳んでいる最中でも、同じ接続の `instance.ping` は 1.2 ms で返る。読みを `READ_CHUNK_BYTES` (1 MiB) ごとに切り、合間に `breathe()` でイベントループを返しているため。
- **待つ量は file の大きさに比例する。** 70 MiB で 0.44 秒、211 MiB で 1.3 秒 (≒ 160 MiB/s)。これが CT-Q8 = a の代償で、購読者が最初の値を得るまでの待ちである。
- **2 度目からは比例しない。** cache が効くと file の大きさに関わらず 2 ms 程度になる。cache が説明するのは「前回読み終えた offset まで」なので、追記された分だけを読むことになる。
