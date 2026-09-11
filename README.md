# ccmsg

> 🇯🇵 [README-ja.md](./README-ja.md)

The daemon that serves one **instance** (= one config home) as an endpoint of the contract, together with its CLI and the plugins it hands to agents.

- `daemon` — holds sessions, delivery, topics and the mesh, and answers the contract's ops over UDS / WS
- `cli` — the entry point a session calls its instance through (`ccmsg`)
- `plugin` — the plugin an agent receives (`ccmsg plugin install claude`). Claude Code is the only agent that has one; a codex plugin is not implemented, and what it would take is tracked in [`docs/issue/2026-09-09-codex-plugin-delivery-via-thread-queue.md`](./docs/issue/2026-09-09-codex-plugin-delivery-via-thread-queue.md)

The wire contract is [`@ccmsg/protocol`](https://github.com/kawaz/ccmsg-protocol), pinned to a version here. Who may call what, and what comes back, is decided by the contract's attribute table and schemas; the daemon reads them rather than carrying validation or authorization branches of its own.

## What it does not do

- Serve the webui, or keep a conversation log of its own — the webui is its own static site, and transcript is the source of truth
- Separate privileges, or mesh with an instance of a different uid / config home — that boundary is the OS's uid and file permissions
- Re-derive an upstream judgment (the gateway's severity, Claude Code's permission decisions) or observe another config home
- Carry validation of its own, or serve v1 alongside — the contract's validator is called, and the new lineage stands as a separate instance

Authenticating a person is not on that list: the daemon answers "who came" itself, with a passkey. [docs/DESIGN.md](./docs/DESIGN.md) §8.6 carries the reason each of these ties back to.

## Documentation

- [docs/DESIGN.md](./docs/DESIGN.md) — **what it is now**: the purpose and what is not grown, the contract and the layers, authentication, the state model, transcripts and dumps, topics and delivery, the mesh, operation, and how it is tested
- [docs/decisions/](./docs/decisions/INDEX.md) — **the record of the judgments (DR)**: why something was decided that way, and what was set aside
- [docs/ROADMAP.md](./docs/ROADMAP.md) — the bundles of work in the order they are taken, pointing at the issues across the three repos
- [docs/design/](./docs/design/README.md) — the design details that stand on their own (authentication between instances, the item types of a dump)

## License

MIT License, Yoshiaki Kawazu (@kawaz)
