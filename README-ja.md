# ccmsg

> 🇬🇧 [README.md](./README.md)

1 つの **instance** (= 1 つの config home) を、契約の endpoint として提供する daemon と、その
CLI、エージェント側の plugin を同梱するリポジトリ。

- `daemon` — セッション・配送・topic・mesh を持ち、UDS / WS で契約の op に答える
- `cli` — セッションの中から instance を呼ぶ入口 (`ccmsg`)
- `plugin` — エージェントへ配る plugin (`ccmsg plugin install claude`)。今あるのは Claude Code の分
  だけで、codex 向けは未実装。何が要るかは
  [`docs/issue/2026-09-09-codex-plugin-delivery-via-thread-queue.md`](./docs/issue/2026-09-09-codex-plugin-delivery-via-thread-queue.md)
  が追跡している

wire の契約は [`@ccmsg/protocol`](https://github.com/kawaz/ccmsg-protocol) が正本で、このリポは
版を固定して依存する。誰が何を呼べて何が返るかは契約側の属性表と schema が決め、daemon は
それを引くだけで自前の検証や認可分岐を持たない。

## 何をしないか

- webui の配信も、自前の会話ログの保存もしない。webui は自前の静的サイトで、会話の正本は transcript
- 権限分離を持たず、別 uid / 別 config home の instance とも mesh を張らない。その境界は OS の uid とファイル権限
- 上流の判定 (gateway の severity、Claude Code の permission 判定) をやり直さず、他 config home も観測しない
- 契約の検証ロジックを自前で持たず (protocol リポの検証器を呼ぶ)、v1 と両受けもしない (新系は別 instance として横に立つ)
- 人の認証はここに入らない。「誰が来たか」には daemon 自身が passkey で答える

それぞれが目的のどこに紐づくかは [docs/DESIGN-ja.md](./docs/DESIGN-ja.md) §9 にある。

## ドキュメント

- [docs/DESIGN-ja.md](./docs/DESIGN-ja.md) — 層と責務、配送、状態モデル、mesh、テスト方針

## ライセンス

MIT License, Yoshiaki Kawazu (@kawaz)
