# ccmsg

> 🇯🇵 [README-ja.md](./README-ja.md)

The daemon that serves one **instance** (= one config home) as an endpoint of the contract,
together with its CLI and the plugins it hands to agents.

- `daemon` — holds sessions, delivery, topics and the mesh, and answers the contract's ops over UDS / WS
- `cli` — the entry point a session calls its instance through (`ccmsg`)
- `plugins/claude` / `plugins/codex` — the plugins agents receive (`ccmsg plugin install`)

The wire contract is [`@ccmsg/protocol`](https://github.com/kawaz/ccmsg-protocol), pinned to a
version here. Who may call what, and what comes back, is decided by the contract's attribute
table and schemas; the daemon reads them rather than carrying validation or authorization
branches of its own.

## Documentation

- [docs/DESIGN.md](./docs/DESIGN.md) — layers, delivery, the state model, the mesh, and how it is tested

## License

MIT License, Yoshiaki Kawazu (@kawaz)
