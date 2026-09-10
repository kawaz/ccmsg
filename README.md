# ccmsg

> 🇯🇵 [README-ja.md](./README-ja.md)

The daemon that serves one **instance** (= one config home) as an endpoint of the contract,
together with its CLI and the plugins it hands to agents.

- `daemon` — holds sessions, delivery, topics and the mesh, and answers the contract's ops over UDS / WS
- `cli` — the entry point a session calls its instance through (`ccmsg`)
- `plugin` — the plugin an agent receives (`ccmsg plugin install claude`). Claude Code is the only
  agent that has one; a codex plugin is not implemented, and what it would take is tracked in
  [`docs/issue/2026-09-09-codex-plugin-delivery-via-thread-queue.md`](./docs/issue/2026-09-09-codex-plugin-delivery-via-thread-queue.md)

The wire contract is [`@ccmsg/protocol`](https://github.com/kawaz/ccmsg-protocol), pinned to a
version here. Who may call what, and what comes back, is decided by the contract's attribute
table and schemas; the daemon reads them rather than carrying validation or authorization
branches of its own.

## What it does not do

- Serve the webui, or keep a conversation log of its own — the webui is its own static site, and transcript is the source of truth
- Separate privileges, or mesh with an instance of a different uid / config home — that boundary is the OS's uid and file permissions
- Re-derive an upstream judgment (the gateway's severity, Claude Code's permission decisions) or observe another config home
- Carry validation of its own, or serve v1 alongside — the contract's validator is called, and the new lineage stands as a separate instance

Authenticating a person is not on that list: the daemon answers "who came" itself, with a
passkey. [docs/DESIGN.md](./docs/DESIGN.md) §9 carries the reason each of these ties back to.

## Documentation

- [docs/DESIGN.md](./docs/DESIGN.md) — layers, delivery, the state model, the mesh, and how it is tested

## License

MIT License, Yoshiaki Kawazu (@kawaz)
