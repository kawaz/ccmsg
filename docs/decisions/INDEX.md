# Decisions

このリポの判断記録 (DR) の索引。リポ分離そのものの判断は
[claude-ccmsg の DR-0032](https://github.com/kawaz/claude-ccmsg/blob/main/docs/decisions/DR-0032-repo-split-protocol-first.md)。

Status は各 DR ファイルの `Status:` 行が正本。

| DR | Status | 要旨 |
|---|---|---|
| [DR-0001](DR-0001-passkey-auth-for-people.md) | Accepted | 人の認証は passkey、token は record に紐づく opaque 値、鍵は持たない (entry token の廃止、自分の endpoint は probe で確定) |
