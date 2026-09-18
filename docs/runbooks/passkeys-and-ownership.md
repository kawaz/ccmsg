# 人を作って instance を渡す

identity は人で、instance はその人の持ち物である (契約 DR-0030)。credential は `origin` 1 つに縛られ、どの instance に入れるかは所有 record が答える。

**それ以前の形で書かれた record は無効**で、移行は持たない。instance は起動時と複製の受け取り時に record を契約の形に照らし、合わないものは取らないので、無効な record は黙って落ちる (ファイルからも次の書き込みで消える)。人は登録し直す。

## どの instance に話すか

CLI は **config home 1 つ**に話す。既定は `CLAUDE_CONFIG_DIR`、無ければ `~/.claude`。別の instance に話すならその config home を渡す。

```
CLAUDE_CONFIG_DIR=<config home> ccmsg user list
```

以下、`§1` と `§5` は **instance ごと**に、`§2`〜`§4` は **どれか 1 つの instance で 1 回だけ**通す。1 回で全部の instance の所有が書かれるので、instance ごとに `user create` を繰り返すと人が数だけ増える。

## 1. 新しい版で起動し直して、何が残っているか見る

```
CLAUDE_CONFIG_DIR=<config home> ccmsg user list
```

人が、その passkey と所有 instance と一緒に並ぶ。何も出なければ、この instance が持っていた record は無効な物だけだったということ。

一部の人だけを作り直すなら、その人の所有をここで外す。

```
ccmsg user remove <user-id> --all --yes
```

`--all` はこの instance が知っている peers 全部の所有を外す。外した瞬間にその人の接続が切れる。所有は後から足し直せる (granting ごとに id が新しいので、tombstone は足し直しを拒まない)。

passkey を 1 本だけ捨てるなら `ccmsg user passkey remove <credential-id> --yes`。**token family は失効しない**ので、そのセッションは refresh の期限 (7 日) まで生きる。今すぐ閉じたいなら所有を外す。

## 2. 人を作る URL を出す (1 回だけ)

```
ccmsg user create --origin https://<page の origin> --all --name <名前> --label <メモ> --format text
```

- `--origin` は人を送る page の origin。**末尾スラッシュを付けない**。省くとこの instance の endpoint の origin になる
- `--all` は、作られる人に**この instance が今知っている peers 全部の所有**を書く。所有 record は URL が使われた時に書かれるので、使われなかった URL は何も残さない
- `--name` は認証器と登録画面に出るアカウント名の初期値。**本人が登録画面で書き換えられる**。passkey manager はこの名前を保存して一覧に出すので、省くと短い既定の語が出る
- `--label` は「誰に渡した URL か」の管理メモ。**本人には見えず**、passkey の `issued_label` に残る
- `--endpoint` は page が POST する base URL。LB があるならその住所を渡す。省くとこの instance の endpoint
- 出力の `URL` と `code` を、**別々の経路で**本人に渡す (URL は browser へ、コードは口頭・別チャネルで)。URL だけでは登録できない

URL は `<origin>/#enroll=<jwt>` で、origin の直下に人を送る。

## 3. 本人が登録する

本人が browser で URL を開き、名前を確かめ、6 桁を打って passkey を作る。成立した瞬間に user record・credential record・所有 record が書かれ、そのまま入れる。

**LB の裏でどの instance に着弾しても成立する。** 受けた instance が自分で WebAuthn を検査し、URL を出した instance には 6 桁と token の判定だけを問い合わせる。発行した instance が browser から見えている必要は無い。

## 4. 確認

```
ccmsg user list
```

- その人の `credentials` に、今作った origin の行があること
- その人の `instances` に、`--all` が渡したはずの instance が全部並んでいること
- 本人が web UI を開き直して、接続 (WS) が張れること

## 5. origin ごとに passkey を 1 本ずつ

credential は origin 1 つに縛られるので、**LB を置かず instance ごとに別の host で web UI を配っている構成では、origin の数だけ passkey が要る** (人は 1 人のまま、増えるのは credential だけ)。

```
ccmsg user passkey add <user-id> --origin https://<2 つ目の origin> --format text
```

アカウント名はその人が今読んでいる名前がそのまま渡るので、passkey manager の中でも同じアカウントに並ぶ。名前を変えるのは `ccmsg user rename <user-id> <名前>`。

LB を 1 つ置いて全部の instance をその裏に入れるなら、origin は 1 つで済み、passkey も 1 本でよい。

## 後から instance を渡す

その人が既にこの mesh に居る (= 複製で credential が届いている) なら、URL も browser も要らない。

```
ccmsg user add <user-id> [--all]
```

知らない id は `not_found` で断る。複製がまだ届いていないなら待つ。

本人の意思をその場で確かめたいなら URL 経由にする。

```
ccmsg user add <user-id> --enroll --origin https://<その人が passkey を持つ origin> --format text
```

本人が既存の passkey で assert すると所有が 1 つ増える。新しい passkey は作らない。**`--origin` はその人が既に passkey を持っている origin**でなければならない (ceremony は送られた page で走り、検証は credential の origin に照らす)。また **assert の検証には公開鍵が要る**ので、着弾する instance がその人を複製で知っていることが前提になる。mesh の外の instance は別の mesh なので、そこで人が入るには `user create` から。

## 設定の endpoint も見直す

config の `endpoints.json` の endpoint は契約の綴りに正規化して読む (小文字の host、scheme 既定の port は書かない、国際化ドメインは punycode、末尾スラッシュ必須)。正規化できない綴り — route を含む URL、query・fragment・userinfo 付き、`wss://` — は **起動時に refuse** される。起動しなくなった instance があれば `endpoints.json` の当該行を直す。

**ここに書くのは、peer が 1 対 1 で届く住所**でなければならない。LB の FQDN を書くと、ピアが特定のピアへ届けられなくなる。人が繋ぐ住所としての LB の FQDN は `user create --endpoint` / `--origin` に渡す側で、設定項目は持たない。
