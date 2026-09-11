# DR-0012: gateway の cache 窓は約束と実結果で引き直す

Status: Accepted (2026-09-11。v0.9.1 で実装、本番稼働中)
Date: 2026-09-11
Sponsor: llm-gateway 側の event 定義追加 (v0.45.0、2026-09-10) への追従
関連: 設計 §2.4 (上流の写し)、§4.2 (入力)、[DR-0009](DR-0009-daemon-derives-session-state.md)、issue archive `2026-09-10-gateway-cache-notice-and-expired`

## 1. 背景

ccmsg は gateway の prompt cache の残り時間をリングで表示している。当初これは **「見込み」** で描かれていた: keepalive の合図を見たら「これで cache は延びたはず」として窓を引き直す。しかし合図は約束であって結果ではなく、実際に cache が書かれたかは応答を見るまで分からない。見込みで描いた窓は、延びなかった時にずれたまま残る。

llm-gateway v0.45.0 が event に 3 つ足したので、約束と結果を区別できるようになった。

## 2. 決定

**窓は「約束」で仮に引き、「実結果」で引き直す。** 約束と結果を別の値として持ち、突き合わせる。

- `cache_keepalive` (request event) が運ぶ単回 id **`cache_notice`** を、`(sid, prefix)` ごとに保持する。`cache_expires_at` の約束はこの id 付きで発行される
- `cache_expired` event の `of` が、保持している `cache_notice` と**一致した時だけ**その窓を落とす。一致しない (= もっと新しい約束が既に来ている) なら何もしない
- response event の `cache` が `written` なら、**応答時刻を起点に新しい窓を引き直す**。これが実結果
- 保持中の request の `keepalive=applied` と応答の `written` を `request_ts` で突き合わせ、再構築として扱う (response event に `keepalive` の欄は無い)

### 2.1 なぜ id で突き合わせるか

約束は `(sid, prefix)` ごとに何度も出る。時刻だけで突き合わせると、古い約束の失効通知が新しい約束の窓を落とす。単回 id を鍵にすると、**その約束についての通知だけ**がその約束に効く。

### 2.2 上流の値は境界で写す

`cache_notice` / `cache_expired` / `cache` はどれも gateway の語彙で、domain に入る境界で ccmsg の型に写される (単位は Unix ms、名前は snake_case)。判定をやり直さず、gateway が言ったことを写すだけである。

## 3. 不採用

| 案 | 理由 |
|---|---|
| keepalive の合図だけで窓を引き直す (見込み) | 合図は約束であって結果ではない。延びなかった時に窓がずれたまま残る |
| 時刻だけで失効通知と約束を突き合わせる | 古い約束の失効通知が、新しい約束の窓を落とす |
| ccmsg 側で cache の残り時間を計算し直す | gateway が正本 (§8.6 の「上流の判定をやり直さない」) |

## 4. 影響

- 設計 §2.4 / §4.2。実装は `src/upstream/{events,gateway,requests}.ts`、v0.9.1
- 実 event での確認: unit 11301/11302 で request 70 本すべてに `cache_notice`、response に `cache` (partial 68 / written 1) を観測し、`written` の実物で窓の引き直しを確認。`cache_expired` と `applied`+`written` の組み合わせは実 event 未観測で、テストと gateway 側の期待 JSON で裏取り
