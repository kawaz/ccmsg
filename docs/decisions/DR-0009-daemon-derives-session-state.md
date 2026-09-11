# DR-0009: セッションの分類は daemon が導出し、busy は gateway が正本

Status: Accepted (2026-09-08。統括裁定 DV-Q5 / DV-Q6 / DV-Q7)
Date: 2026-09-08
Sponsor: 統括裁定 (2026-09-08)
関連: 設計 §4 (セッションの状態モデル)、§2.3 (domain)、§1.1 (M3 / M5 / M6)、[DR-0011](DR-0011-peers-is-a-topic-of-rows.md)、[DR-0012](DR-0012-gateway-cache-window.md)

## 1. 背景

一覧の分類 (Pinned / Waiting / alive / unmanaged / Paused / Disappeared) を誰が決めるかが定まっていなかった。webui が生の値を組み合わせて分類すると、instance ごとに解釈がずれる。

旧 daemon には 3 つの負債があった。`claude agents` を 5 秒ごとに子プロセスとして起こしていたこと、`sessions/<pid>.json` の生 status から Busy / Idle を決めていたこと、同じ transcript の行を status / errors / user-input の 3 系統が独立に fold していたことである。

## 2. 決定

### 2.1 分類は daemon が導出する

一覧の分類は daemon が出す。webui は受け取った分類を描く。

### 2.2 busy の正本は gateway、生 status の用途は 2 つに絞る

`sessions/<pid>.json` の status は **「このセッションが存在すること」と `waiting` (ダイアログが開いている) の判定にだけ**使い、**Busy / Idle の判定には使わない**。推論が実際に走ったかを知っているのは gateway の request / response イベントだけである。

Busy と Idle を節として分けないので、**busy は分類ではなく行の属性として出す**。分類側が busy を見ないため、gateway を設定していない instance でも節の構造は成立する (行の属性が 1 つ欠けるだけ)。

**gateway のイベントは、こちらが知っている sid の分だけ数える。** gateway は全 config home の上に立ち、イベントは sid しか名指さないので、「gateway が見た」だけではこの instance のセッションについての証拠にならない。挨拶したことがある (接続中か `last_live` にある)、または自 config home の `sessions/` が名指している sid だけが liveness の入力になる。イベント自体は捨てず、`llm.requests` topic に流す — こちらは instance のセッションではなく gateway が見ているものの眺めである。

### 2.3 `claude agents` の subprocess は持たない

自 config home の `sessions/` を監視すれば同じ集合が得られるので、5 秒ごとの子プロセス起動は丸ごと消える (M3)。ファイル監視は取りこぼしうるので **低頻度の確認 poll を併走させる**が、その間隔の根拠は「監視が落とした変化を利用者が気づく前に拾う」であって、一次の取得経路ではない。

書き換え途中の `sessions/<pid>.json` は一時的に空や不完全になりうる。**ファイルが在る限り、そのファイルから完全に読めた最後の行を保持し、不完全な読み取りをセッションの消失として publish しない。** 消すのは、完全な document が「居ないプロセス」を名指した時か、ファイル自体が消えた時。監視は変化がありうることを告げる資源であって、途中の表現は新しい現在値の証拠ではない。

### 2.4 transcript の fold は 1 本

tail 1 本 → fold 1 本 → そこから各 topic の値を導く (M5)。「全 peer には軽い fold、購読中の sid には重い fold」の 2 段構えは持たない。負荷が問題になったら、fold の中身を軽くするのが答えであって、fold を増やすのが答えではない。

### 2.5 `peers` は接続の有無で分けない

挨拶するのは `SessionStart` hook だけなので、instance が再起動すると **既に走っているセッションは二度と挨拶しない**。接続を持つものだけを載せると、走っているセッションで一杯のホストが「何も生きていない」と読める。`sessions/` が名指すセッションは、挨拶したことがあるかに関わらず 1 行であり、今どうなっているかは行の `state` が言う (DR-0011)。

### 2.6 分類の入力は購読に従属しない

`sessions/` を**読むこと**と**監視すること**は別で、購読に従属するのは後者だけ。どのセッションが在るかは instance 自身についての事実なので、判断が要る所でディレクトリを読む。混同すると、誰も購読していない間は生きているセッションが `session_not_found` になり、走っているセッションが `last_live` に「居なくなった」と書かれる。

### 2.7 他の config home は見ない (M6)

disk を走査して自分以外の config home を見つけない。

## 3. 不採用

| 案 | 理由 | 見直す条件 |
|---|---|---|
| 生 status から Busy / Idle を決める | 推論が実際に走ったかを知っているのは gateway だけ | gateway を通らないセッション — 推論を外からしか見られない別の harness |
| `claude agents` の subprocess を残す | `sessions/` の監視で同じ集合が得られる。5 秒ごとの子プロセス起動は M3 | harness が `sessions/` の外に持つ状態が必要になり、ファイル監視では同じ集合が得られなくなったとき |
| fold を軽 / 重の 2 段にする | M5。同じ技法の実装が 2 つになる | 1 つの topic が他より桁違いの流量を持ち、共有の fold が追いつかなくなったとき |
| webui が生の値を組み合わせて分類する | 解釈が instance ごとにずれる | — |
| `~/.claude*` を走査して config home を見つける | M6。instance の境界が実行環境で揺れる | 人が config home を述べる手段を持たない環境 (誰かが用意した環境) |
| 接続の有無で `peers` を 2 つの一覧に分ける | 再起動後、走っているセッションが「何も生きていない」と読める | — |

## 4. 影響

- 設計 §4、§2.3 (fold は 1 本)、§9.3 (M3 / M5 / M6 の検査)
