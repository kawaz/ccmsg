# sessions topic storm

## 観測

2026-09-10 15:35 JST の本番 WebSocket では、接続から切断までの 0.92 秒間に 882 frame を受信した。内訳は `agents` 471、`peers` 400、`session_errors` 4 で、主に一つの remote instance が発生元だった。同じ instance の `peers` は空配列と複数の session 集合をミリ秒間隔で往復し、`agents` も同じ sid の状態を交互に異なる値として送っていた。

## 原因

`src/sessions/harness.ts` の `HarnessSessions.scan()` は state file の read、JSON parse、必須 field の検証が一時的に失敗した時、その file の row を欠損として扱っていた。Claude Code は `sessions/<pid>.json` を in-place で書き換えるため、truncate 後から完全な JSON が書かれるまでの中間状態を daemon が読める。`fs.watch` は truncate と後続 write の両方を通知し、それぞれが `Sessions.changed()` を発火させる。このため一つの session が `[]` と完全 row の間を往復した。

`src/topics/topics.ts` の M5 抑制は topic と発生元 instance ごとに直前の serialized payload を比較しており、同値の連続 publish を正しく抑制していた。しかし `[]` と完全 row は異なる値なので、交互の frame は抑制対象ではない。`src/mesh/relay.ts` は frame の発生元 instance を保持して中継し、local `Topics` の同じ発生元単位の抑制を通る。mesh は storm を購読先 instance へ運ぶが、値の往復を生成する原因ではない。

`TerminalCache` の fill callback は pid ごとに最初の非同期 read が完了した時だけ再計算を発火する。継続的なミリ秒間隔の往復源ではない。確認 poll は watch と同じ再計算経路を通るが 5 秒間隔であり、観測した頻度を生成しない。

## 再現

OS temp directory に `HarnessSessions` と `Topics` を置き、実在する test process の pid を名乗る state file 一つを使った。完全な JSON と空 file を 500 回ずつ交互に書き、各状態を `agents` に publish した。

| 実装 | 更新 | 異値 frame | 所要時間 | frame/s |
|---|---:|---:|---:|---:|
| 修正前 | 1,000 | 1,000 | 82 ms | 12,197 |
| 修正後 | 1,000 | 0 | 78 ms | 0 |

この再現は送出帯域や描画速度ではなく、daemon が同じ入力 file の中間状態を現在値として publish する機構を直接測る。

## 修正

`HarnessSessions` は state filename ごとに最後に完全に読めた row を保持する。file が現在も directory に存在し、read、parse、または必須 field の検証が不完全な時だけその row を代用する。完全な文書が死んだ process を名乗る時と file が directory から消えた時は直ちに保持値を削除する。

watch と確認 poll は引き続き変化を知らせる資源であり、現在値の取得経路ではない。各 scan は directory と file を読み直す。保持値は一時的な中間表現を session 消滅へ昇格させないためだけに使う。

回帰テストは、空 file と必須 field が欠けた JSON で直前の row を維持すること、次の完全な row を採用すること、file 削除を隠さないことを固定する。
