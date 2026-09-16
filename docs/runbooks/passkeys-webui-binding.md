# 古い passkey を消して登録し直す (webui 束縛)

credential と token family は「入ってよい endpoint」と「使ってよい webui」の 2 つを持つ (契約 DR-0029)。`webui` を持たない record は **名指す page が無いので無効**である。移行は持たない (URL から導く値を後から埋めると、人が実際に送られる page と食い違ったまま固定されうる)。人は登録し直す。

対象の instance ごとに、この手順を 1 回実行する。

## 1. 何が残っているか見る

```
ccmsg daemon passkey list <unit>
```

credential record が JSON で並ぶ (無効な record も出す。消す行を人が見分けられないと困るため)。`webui` フィールドが無い record が対象。

## 2. その人を消す

```
ccmsg daemon passkey remove <sub> <unit>
```

sub 単位で tombstone を打ち、その人の credential・token family・開いている WS を全部落とす。tombstone は mesh 全体に複製されるので、他の instance でも同じ sub が使えなくなる。**同じ sub では登録し直せない** (tombstone がその key 配下への以後の書き込みを拒む) ので、次で新しい sub を発行する。

## 3. 登録用 URL を出し直す

```
ccmsg daemon passkey add <unit> [endpoint] [--webui <URL>] [--name <ラベル>]
```

- webui を endpoint 自身が配っているなら `--webui` は要らない
- webui を別の場所 (別 host・別 site) に置いているなら、**その base URL を末尾スラッシュ込みで** `--webui` に渡す。人を送る先はこの URL になり、credential はその origin の page でしか使えなくなる
- 出力の `url` と 6 桁のコードを、**別々の経路で**本人に渡す (URL は browser へ、コードは口頭・別チャネルで)。URL だけでは登録できない

登録は **URL を発行した instance に届いた時だけ成立する**。LB の裏で別 instance に落ちた場合、その instance はまだその origin を知らないので CORS で断る。発行した instance に直接届く経路で開いてもらう。

## 4. 確認

```
ccmsg daemon passkey list <unit>
```

新しい record に `webui` が入っていること。本人が web UI を開き直して、接続 (WS) が張れることまで見る。

## 設定の endpoint も見直す

config の `endpoints.json` の endpoint は契約の綴りに正規化して読む (小文字の host、scheme 既定の port は書かない、国際化ドメインは punycode、末尾スラッシュ必須)。正規化できない綴り — route を含む URL、query・fragment・userinfo 付き、`wss://` — は **起動時に refuse** される。起動しなくなった instance があれば `endpoints.json` の当該行を直す。
