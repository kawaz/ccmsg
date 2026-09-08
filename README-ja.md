# ccmsg

> 🇬🇧 [README.md](./README.md)

1 つの **instance** (= 1 つの config home) を、契約の endpoint として提供する daemon と、その
CLI、エージェント側の plugin を同梱するリポジトリ。

- `daemon` — セッション・配送・topic・mesh を持ち、UDS / WS で契約の op に答える
- `cli` — セッションの中から instance を呼ぶ入口 (`ccmsg`)
- `plugins/claude` / `plugins/codex` — エージェントへ配る plugin (`ccmsg plugin install`)

wire の契約は [`@ccmsg/protocol`](https://github.com/kawaz/ccmsg-protocol) が正本で、このリポは
版を固定して依存する。誰が何を呼べて何が返るかは契約側の属性表と schema が決め、daemon は
それを引くだけで自前の検証や認可分岐を持たない。

## ドキュメント

- [docs/DESIGN-ja.md](./docs/DESIGN-ja.md) — 層と責務、配送、状態モデル、mesh、テスト方針

## ライセンス

MIT License, Yoshiaki Kawazu (@kawaz)
