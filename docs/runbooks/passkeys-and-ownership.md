# 古い passkey を捨てて人を作り直す

identity は人で、instance はその人の持ち物である (契約 DR-0030)。credential は `origin` 1 つに縛られ、どの instance に入れるかは所有 record が答える。

**それ以前の形で書かれた record は無効**で、移行は持たない。instance は起動時と複製の受け取り時に record を契約の形に照らし、合わないものは取らないので、無効な record は黙って落ちる。人は登録し直す。

mesh の instance 全部に、この手順を 1 回ずつ通す。

## 1. 何が残っているか見る

```
ccmsg user list
```

人が、その passkey と所有 instance と一緒に並ぶ。ここに何も出なければ、この instance が持っている record は無効な物だけだったということで、次に進む。

一部の人だけを作り直すなら、その人の所有をここで外す。

```
ccmsg user remove <user-id> --all --yes
```

`--all` はこの instance が知っている peers 全部の所有を外す。外した瞬間にその人の WS が切れる。所有は後から足し直せる (granting ごとに id が新しいので、tombstone は足し直しを拒まない)。

passkey を 1 本だけ捨てるなら:

```
ccmsg user passkey remove <credential-id> --yes
```

## 2. 人を作る URL を出す

```
ccmsg user create --origin https://ccmsg2.<host> --all --name <ラベル> --format text
```

- `--origin` は人を送る page の origin。**末尾スラッシュを付けない**。省くとこの instance の endpoint の origin になる
- `--all` は、作られる人に**この instance が今知っている peers 全部の所有**を書く。省くとこの instance だけ
- 出力の `URL` と `code` を、**別々の経路で**本人に渡す (URL は browser へ、コードは口頭・別チャネルで)。URL だけでは登録できない

URL は `https://<origin>/#enroll=<jwt>` で、origin の直下に人を送る。

## 3. 本人が登録する

本人が browser で URL を開き、6 桁を打って passkey を作る。成立した瞬間に user record・credential record・所有 record が書かれ、そのまま入れる。

**LB の裏でどの instance に着弾しても成立する。** 受けた instance が自分で WebAuthn を検査し、URL を出した instance には 6 桁と token の判定だけを問い合わせる。発行した instance が browser から見えている必要は無い。

## 4. 確認

```
ccmsg user list
```

- その人の `credentials` に、今作った origin の行があること
- その人の `instances` に、持たせたかった instance が並んでいること
- 本人が web UI を開き直して、接続 (WS) が張れること

## 2 台目以降の端末・2 つ目の origin

**同じ人に passkey を足す** (別の端末、または別 origin の web UI):

```
ccmsg user passkey add <user-id> --origin https://<別の origin> --format text
```

同じ user handle に対して作るので、増えるのは credential だけで人は増えない。

**まだその人を知らない instance に持たせる**:

```
ccmsg user add <user-id> --enroll --origin https://<origin> --format text
```

URL と 6 桁が出る。本人が既存の passkey で assert すると所有が 1 つ増える。新しい passkey は作らない。

mesh の複製で既にその人を知っている instance なら、URL も browser も要らない:

```
ccmsg user add <user-id>
```

## 設定の endpoint も見直す

config の `endpoints.json` の endpoint は契約の綴りに正規化して読む (小文字の host、scheme 既定の port は書かない、国際化ドメインは punycode、末尾スラッシュ必須)。正規化できない綴り — route を含む URL、query・fragment・userinfo 付き、`wss://` — は **起動時に refuse** される。起動しなくなった instance があれば `endpoints.json` の当該行を直す。

**mesh のピアが使う endpoint は、instance に 1 対 1 で届く住所でなければならない。** LB の FQDN を `endpoints.json` に書くと、ピアが特定のピアへ届けられなくなる。人が繋ぐ住所としての LB の FQDN は、それとは別に持つ (契約に現れるのは `--origin` の側だけで、設定項目は無い)。
