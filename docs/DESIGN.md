# ccmsg design

> 🇯🇵 [DESIGN-ja.md](./DESIGN-ja.md)

- Related: [DR-0032](https://github.com/kawaz/claude-ccmsg/blob/main/docs/decisions/DR-0032-repo-split-protocol-first.md) (repo split, contract-first),
  [`@ccmsg/protocol`](https://github.com/kawaz/ccmsg-protocol) (the source of truth for the contract),
  [mesh-peer-auth](https://github.com/kawaz/claude-ccmsg/blob/main/docs/design/mesh-peer-auth.md) / [mesh-self-identification](https://github.com/kawaz/claude-ccmsg/blob/main/docs/design/mesh-self-identification.md) (inter-instance authentication / self-identification),
  [issue multi-host-cluster](https://github.com/kawaz/claude-ccmsg/blob/main/docs/issue/2026-09-07-multi-host-cluster.md),
  [issue session-list-sections](https://github.com/kawaz/claude-ccmsg/blob/main/docs/issue/2026-09-06-session-list-sections.md)
- Primary sources: [daemon inventory](https://github.com/kawaz/claude-ccmsg/blob/main/docs/findings/2026-09-07-daemon-inventory.md),
  [messaging socket investigation](https://github.com/kawaz/claude-ccmsg/blob/main/docs/findings/2026-09-08-claude-code-messaging-socket.md)

---

## 1. Purpose

**Provide a single instance (= 1 config home) as an endpoint of the contract v2.**

An instance can only answer for the sessions that belong to its own config home and for
resources (processes, paths, terminal handles) on that host. Anything else must be asked
of a mesh peer.

### 1.1 What we do not want to manage (on par with the purpose)

"Do not want to manage" means: adding this element creates a distribution, update, storage,
recovery, or consistency procedure. All decisions in this design assume the following; when
in doubt, return here.

| # | What not to grow | Definition (what it refers to) | Example of a violating change |
|---|---|---|---|
| M1 | **Hand-written authorization per op** | Writing the judgment of role / hello requirement / capability / forwarding destination inside an op's handler | "I want this one op to be user-only" leads to adding a role comparison at the top of the handler |
| M2 | **A second route for the same information** | Exposing the same value through both a one-shot op and a push, or through two kinds of frames | "The CLI wants it in one round trip" leads to adding a fetch op alongside the topic |
| M3 | **Periodic timers without justification** | A `setInterval` / `sleep` loop whose interval value cannot be explained by measurement, upstream behavior, or spec | "We sometimes miss updates, so refetch every second" |
| M4 | **Persisting derived values** | Writing to disk a value that can be reconstructed from other state | Caching a previously computed status to a file |
| M5 | **A separate implementation of the same technique** | Writing the same kind of logic (e.g. "serialize the previous value and compare, skip the push if unchanged") in multiple places | Having a separate suppression cache per topic |
| M6 | **Scanning for `~/.claude*`** | Discovering config homes other than one's own via disk scanning | "It would be convenient to also see sessions from other profiles" leads to polling every config home |

M1 / M2 / M5 explicitly name the biases measured in the old daemon (95 spots of role
comparisons, 3 routes for the same information, 3 implementations of push-suppression
caches, 3 lineages of transcript-line folding), so as to prevent recurrence.
M3 responds to the fact that of 8 kinds of timers, only 2 had their rationale written down.

### 1.2 The shape derived from the purpose

- Authorization, capability, and forwarding are done in a single function that looks up the
  contract repo's `OP_ATTRIBUTES` / `TOPIC_ATTRIBUTES`. An op's implementation starts from a
  state where "the arguments are already validated, and the caller is already confirmed to be
  allowed to call" (M1)
- Anything observable is provided only through topics (M2)
- State changes are pushed by the layer that holds them. No route is built to periodically go
  look at everything (M3)

## 2. Assumptions

| # | Condition | If not satisfied |
|---|---|---|
| A1 | The wire contract (types, op attribute table, topic attribute table, validators) is owned by the protocol repo | The daemon writes its own validation and drifts out of sync with the webui's interpretation (the old daemon's state) |
| A2 | instance = 1 config home. The daemon process is 1:1 with the instance | It becomes undefined which config home's sessions are being answered for |
| A3 | The runtime is Bun. UDS, child processes, and file watching use Bun's APIs | The premise of startup and distribution (single binary) changes |
| A4 | daemon, sessions, and webui users are a single uid. No privilege separation | The UDS 0600 and the config home's 0600 key stop being the boundary, requiring authorization to be rebuilt |
| A5 | mesh peers are only instances that have passed the §7 authentication, and never cross the authentication boundary (uid / config home) | The basis for executing an op that came over mesh under one's own instance's privileges disappears |

A4 is not a declaration that we do not protect against others — it is a declaration that
**the boundary is delegated to the OS's uid and file permissions**. This is the basis for the
daemon not holding a privilege model internally (§9).

## 3. Layers and responsibilities

4 layers + persistence. An upper layer does not know about the layer below it.

```
transport   creates connections, turns lines into frames, and determines who the peer is
dispatch    maps frames to ops, authorizes via the attribute table, and hands off to the owning instance
domain      holds the facts the instance can answer for (sessions / inbox / topics / transcript / upstream)
mesh        establishes connections with other instances, forwards ops in envelopes, relays frames
persistence writes only what must not be lost across a crash and restart
```

### 3.1 transport

| Responsibility | Content |
|---|---|
| Accepting connections | UDS (same-host sessions / CLI), WS (webui / mesh) |
| Framing | newline-delimited JSON. Holds the per-line size limit and backpressure handling in one place |
| Entry-point permission | source IP allowlist, allowed Origin set, mesh peer TLS |
| Determining identity | binds a role and (for sessions) a sid to the connection as the result of `hello` |

We will not repeat the asymmetry in the old daemon where only the UDS listener was buried
inside the startup function. UDS and WS are **two implementations that return the same
`Conn`**, and layers above do not distinguish between them. The difference in backpressure
handling (UDS `write` may return a short count / WS retransmits) is absorbed at this layer.

**A mesh connection is also just one implementation of this layer** (§7). The only difference
is that its role is `instance`.

### 3.2 dispatch

For a single frame, in order:

0. Is the frame a JSON object with `op` and `request_id`? If not, `bad_request`
1. Does the `op` name exist in the contract? If not, `unknown_op`
2. schema validation (protocol's compiled validator). On failure, `invalid_args`
3. `needs_hello` versus the connection's identity. If undetermined, `hello_required`
4. `roles` versus the connection's role. If outside, `forbidden`
5. `capability` versus the instance's capability set. If absent, `capability_unavailable`
6. If `locality` is `instance-local` and the target belongs to another instance, forward via
   mesh (§7.3). If unreachable, `instance_unreachable`
7. Call the op's implementation

**Steps 1–6 are never written per op.** They are mechanically derived from the attribute
table, so adding an op is closed to "add one row to the attribute table and write the schema
and the implementation" (M1). Only ops that carry `scope: "role"` (`transcript_read` /
`dir_list` / `file_read`) change the visible range rather than the allow/deny decision, so the
role is passed into the implementation. **Passing the role to the implementation is the only
route, and it is limited to ops whose attribute table declares `scope`.**

### 3.3 domain

| Module | Holds | Source of truth |
|---|---|---|
| sessions | sessions that have said hello, their meta and connection, `last_live` | daemon (volatile) + a file for last-live |
| inbox | undelivered messages per sid (§4) | daemon (persistent, §4.3) |
| topics | the current value and subscribers per topic (§6) | the owner of each value (the two below, or upstream) |
| transcript | one tail per sid, and the fold built from it | file (written by Claude Code) |
| upstream | values copied from `sessions/<pid>.json` / llm-gateway | external (§3.5) |

**The transcript's fold is a single one.** The old daemon had status / errors / user-input
independently fold the same line through 3 lineages. v2 shapes it as tail 1 → fold 1 →
deriving each topic's value from that (M5). It does not have the two-tier setup of "a light
fold for every peer, a heavy fold for a subscribed sid" (DV-Q7). If load becomes a problem, the
answer is to lighten the fold's content, not to add more folds.

### 3.4 mesh

§7. It is placed next to domain because mesh is the layer that "shows another instance's
domain as if it were one's own domain."

### 3.5 Copies of upstream

The daemon-side rule corresponding to the contract §4's "declare the source of truth on the
type": **external JSON is converted to ccmsg's types at the boundary where it enters domain**
(units to Unix ms, names to snake_case). No unconverted value ever appears in a topic's
payload.

### 3.6 persistence

Write only 3 kinds of things.

| Target | Reason |
|---|---|
| `last_live` (previously running sessions) | Losing it on restart makes Paused / Disappeared rows vanish from the list |
| Logs | To read the cause after a crash. Keep a single writer that does not drop the line right before exit |
| inbox (undelivered messages) | **The only state that cannot be reconstructed from anywhere else** (§4.3) |

inbox is not an exception to M4 — it is outside M4's scope. What M4 forbids is persisting
**derived values**, and an undelivered message is not a derived value. The sender's
`message_send` has already returned its response and is done; the body that "has not yet
arrived" exists nowhere in transcript or upstream. If the daemon loses it, the body is gone
with it.

There is no room jsonl (per contract §2.1, the source of truth for conversation logs is
transcript). Sandbox grants, subscription state, in-progress fold results, and the list of
config dirs are all reconstructable, so none of them are written (M4). pid / socket / lock are
resource handles, not state.

## 4. Delivery

The contract's `message_send` promises only "deliver to the destination sid," returning a
reason if it fails to. The daemon-side implementation splits into those two things: the
delivery means, and determining the reason for non-delivery.

### 4.1 Two routes for the delivery means

| Route | Content | Prerequisites |
|---|---|---|
| (a) Directly to Claude Code's messaging socket | Connect to the `messagingSocketPath` in `sessions/<pid>.json`, authenticate with the config home's 0600 `peerToken` key, then write a user frame | Unofficial protocol. `peerProtocol` generation must match. **Not verified on real hardware** |
| (b) Push as a delta of the `inbox` topic | Delivered via the receiving session's subscription (a long-running process holding a subscribe) | The session must be subscribed |

**Prefer (a); fall back to (b) on failure** (DV-Q1). Two reasons.

- (a) **arrives even if the receiving side does not have a ccmsg long-running process**. The
  gap "messages don't reach a session that hasn't subscribed yet" (which the old daemon
  plugged with a 3-minute rewind window) disappears as a property of the route rather than
  being closed by a time window
- (b) is ccmsg's own protocol, so it works for peers where (a) is unusable (generation
  mismatch, no socket, cannot read the key). There are combinations that work with only one of
  the two but not the other

Route (a) applies **only when every condition is satisfied**. If even one is missing, it falls
back to (b) without further judgment.

0. **The feature flag is enabled** — since (a) has not been verified on real hardware, it is
   disabled by default until verification is complete. While the flag is disabled, delivery is
   accomplished by (b) alone (the fallback simply becomes the everyday route; the semantics of
   delivery do not change)
1. `sessions/<pid>.json` has `messagingSocketPath` and a known `peerProtocol`
2. The corresponding key file can be read by ourselves (= same uid, same config home,
   matching A2 / A4)
3. The send's ack returns within the deadline

`from` is fixed to a ccmsg-defined value (user input never passes through it).

### 4.2 Reasons for non-delivery and where they are determined

All non-delivery reasons in contract §2.1 are derived from the §5 state model and the outcome
of the routes. No separate information source is added per reason.

| `reason` | Judgment | Source |
|---|---|---|
| `preparing` | The destination is alive but cannot yet receive it (route (a) unavailable AND no subscription) | sessions + registry |
| `paused` | The destination is Paused | last_live's `stopped_at` |
| `disappeared` | The destination is Disappeared | last_live (no stopped marker) |
| `instance_unreachable` | The owning instance of the destination is unreachable over mesh | mesh's connection state |
| `inbox_full` | Over the limit, the oldest was dropped | inbox |
| `throttled` | Rejected by the receiving side's rate limiting on route (a) (§4.4) | (a)'s drop response |

`session_not_found` (the op itself failing) applies only when "no instance in the cluster
knows the sid." As long as it's possible that an unreachable instance owns it, the result is
`instance_unreachable`, not `session_not_found`. **This distinction depends solely on mesh's
connection state.**

For `paused` / `disappeared`, the sid attached to `candidates` is "a session currently running
with the same repo root." repo root is the value hello declared, or, if none was declared, the
value derived from cwd.

### 4.3 inbox

| Property | Value | Basis |
|---|---|---|
| Granularity | per sid | contract §2.1 |
| Enqueue condition | only when immediate delivery was not possible | do not accumulate what was already delivered |
| Dequeue condition | when the destination becomes able to receive it (route (a) becomes viable / `inbox` gets subscribed) | same as above |
| Removal condition | when delivered / when the destination disappears from the list / when the retention period expires | contract §2.1 |
| Limit | a per-sid count limit. Excess is dropped from the oldest, returning `inbox_full` | contract §2.1 |
| Retention period / count limit values | **reference the contract's values** (the daemon does not decide them independently) | contract §2.1 |

**Persisted** (DV-Q3, §3.6). The format is append-only jsonl, cleared out once delivered.
Because it's append-only, writes are closed to a single kind (appending to the end), so a
crash mid-write only corrupts the trailing line.

Whether to use a per-sid file or a single file is left to implementation discretion (either
way the meaning of clearing and retention period is unchanged).

### 4.4 When route (a) drops a message

The receiving side has rate limiting (token bucket / duplicate detection / queue limit) and
may decline and drop a message. **A dropped message is not marked as delivered** (DV-Q2). It
stays in inbox with a backoff before resending, and the sender receives
`delivered: false, reason: "throttled"`.

Reason: a drop means "the destination cannot receive it right now," neither "it arrived" nor
"the destination is absent." Marking it delivered would lose the body; marking it
`session_not_found` would say the destination is absent. Leaving it in inbox and resending
aligns it with the same treatment as the other non-delivery states in §4.2 (it goes out once
receivable again).

`throttled` is a reason defined by the contract, not something the daemon adds on its own. The
daemon only returns the contract's reasons and does not extend the set of reasons on its own
side. The backoff interval should be derived from "the recovery rate of the peer's token
bucket" (M3 — do not decide by guesswork).

## 5. Session state model

The list's classification (Pinned / Waiting / alive / unmanaged / Paused / Disappeared) is
**derived by the daemon**. If the webui combines raw values to classify, the interpretation
drifts per instance.

### 5.1 Inputs

| Input | What it tells us | How it's obtained |
|---|---|---|
| Connection | Whether it's talking to ccmsg, and when it last did | transport (events) |
| Each `sessions/<pid>.json` in `sessions/` | **The session's existence** and `waiting` (dialog), the messaging socket | Own config home only (M6). File watching |
| llm-gateway's request / response | **Whether inference is actually running** (= busyness) | webhook (push) |
| `last_live` + `stopped_at` | Previously running / intentionally stopped | a file we wrote ourselves |
| transcript's fold | Whether it's stopped on an API error, the last human input | tail |

**No subprocess for `claude agents`** (DV-Q6). Watching our own config home's `sessions/`
yields the same set, so the child-process launch every 5 seconds disappears entirely (M3).
Since file watching can miss events, a low-frequency confirmation poll **runs alongside it** —
this is the same shape the old daemon adopted for transcript tail based on measurement, and
the rationale for the interval is "catch changes that the watch dropped before the user
notices," not the primary acquisition route.

**Narrow the use of the raw status** (DV-Q5). The status in `sessions/<pid>.json` is used only
to determine "that this session exists" and `waiting` (a dialog is open), and is **never used
to determine Busy / Idle**. The source of truth for busyness is the gateway's request/response
events; only that side knows whether inference actually ran.

### 5.2 Derivation

```
Waiting        = raw status is waiting (dialog), or the fold judges it stopped on an API error
Pinned         = the user pinned it (the daemon only carries the marker, never uses it as a basis for classification)
alive          = has a connection / has a process in sessions/ / has recent gateway activity
alive (unmanaged) = alive but connected to neither ccmsg nor a terminal
Paused         = present in last_live and has a stopped_at
Disappeared    = present in last_live and has no stopped_at
```

Because "Busy and Idle are not split" (issue session-list-sections), **busyness within alive
is emitted as a row attribute, not a classification**. Busyness is derived from gateway events
(§5.1), and the sort order is the last activity time. Since the classification side does not
look at busyness, the section structure holds up even for an instance with no gateway
configured (only one row attribute is missing).

### 5.3 The two kinds of "last activity time"

The old daemon kept "the time updated on every ccmsg request" (the agent's busyness) and "the
time the human typed input" (the sort order) in two separate places. v2 **makes explicit at
the type level that these are two values for two different purposes**, and decides in one
place which one drives the sort order. They are never held under the same name.

## 6. Implementing topics

The contract defines only one shape: "immediately after `topic_subscribe`, a frame with
`snapshot: true` fires once, followed by deltas of the same shape." The daemon side
**holds this as a single mechanism, never written per topic**.

### 6.1 What a single topic holds

| Element | Content |
|---|---|
| Current value | Stated by its owner (§3.3). All topics hold is the wire form of the last frame sent |
| Subscribers | A set of connections |
| Update entry point | A single function that domain uses to hand in "a new value" |
| Suppression | Do not send if identical to the last value sent (**a single implementation shared by all topics**, M5) |

The old daemon had suppression on only 3 topic-equivalents, and each was a separate
implementation. v2 builds suppression into the topic mechanism itself, so "this topic has no
suppression" can never happen.

### 6.2 Delta granularity

| Granularity | topic |
|---|---|
| Full replacement per instance | `peers` / `agents` / `session_errors` |
| Full replacement | `session_status:<sid>` / `llm_status` |
| Element add / update | `inbox` / `llm_requests` / `kv:<ns>` |
| Append (byte offset) | `transcript:<sid>` |
| Event (no value held) | `notify` |

**Event** alone holds no current value. What matters is that it happened, so subscribing
produces no snapshot and a repeat is not suppressed ("do not send it if it equals the last one"
means something only where a value is held). Suppression stays one implementation, which reads
the granularity and lets these through.

**Full replacement per instance** is the key to mesh. A frame always carries its originating
`instance`, and subscribers replace "only that instance's portion." Other instances' portions
remain. This rule is what prevents multiple instances' full values from colliding under the
same topic name.

### 6.3 Managing subscriptions

- A subscription is subordinate to a connection. When the connection closes, the subscription
  disappears too (no separate teardown)
- **Upstream resources run only while there are subscribers.** When `transcript:<sid>`'s
  subscriber count reaches 0, stop the tail; when `agents`'s subscriber count reaches 0, stop
  watching `sessions/`. Subscriptions are the sole driver of a resource's lifecycle
- An instance whose cluster-wide topic has been subscribed to also subscribes to the same
  topic on each mesh peer, and streams the received frames straight through to its own
  subscribers (keeping the originating `instance` intact) (§7.4)

## 7. mesh

### 7.1 Self-identification

At startup, determine `self` (one's own endpoint URL). Follow the mesh-self-identification
procedure (send a token-carrying probe to every peer, then check which token comes back to
oneself). **Do not skip the probe addressed to oneself** (skipping it destroys the property of
"failing when there are 2 or more matches").

mesh-self-identification's premise Q3 (all peers are reachable at startup) is not steadily
satisfiable under ccmsg's operating conditions (one machine may be powered off or asleep). We
adopt the relaxation of **excluding unreached peers from the match count, and limiting startup
failure to a match count of 0 or 2+** (DV-Q11).

The same document's §4.2 safety property (that a malicious legitimate peer's impersonation
fails to hold at 2+ matches) depends only on "a probe addressed to oneself always reaches
oneself," so this relaxation does not break it. An unreached peer remains a dial target under
§7.2.

### 7.2 Dial and glare

- Every instance dials all peers symmetrically (dial responsibility is not assigned to one
  side)
- Authentication is mesh-peer-auth. A `hello` with `role: "instance"` is the starting point; C2
  exchanges the key and challenge, and C1 returns the proof. No message is sent until the ack
  is received
- On glare (both sides dialed), after verifying both, the side with the lexicographically
  smaller `iss` string keeps the connection it dialed
- The reconnect backoff may be loose. If the peer recovers, it will dial us
- A heartbeat is kept (to detect silent disconnects)

### 7.3 Forwarding ops

An op with `locality: instance-local` is forwarded if the owning instance of its target is not
oneself.

```
webui ──▶ instance A ──(envelope: to_instance=B, from_instance=A, hops=[A])──▶ instance B
                    ◀──────────── response ────────────────────────────────
```

- The envelope carries only the 3 fields of the contract's `RequestEnvelope`. There is no
  mesh-specific op
- A request whose `hops` already contains oneself is dropped (no looping)
- If the forwarding target has no established connection, or the response does not return
  within the deadline → `instance_unreachable`
- **A forwarded op is put through §3.2's steps 1–6 again at the forwarding destination.** We
  never treat "A already authorized it, so B trusts it" — because if A were compromised, that
  would make B's authorization disappear

How "the owning instance of the target" is decided: the sid-to-owning-instance mapping is held
by the `peers` topic. An unknown sid means "nowhere in the cluster" = `session_not_found`.
However, while an unreachable instance exists, the judgment is deferred (§4.2).

### 7.4 Event relay

For a subscriber connected to instance A to see the whole cluster, A subscribes to the same
topic on each peer, and streams the received frames through to its own subscribers while
keeping the `instance` field intact. A does not recompute the content (recomputing would
create the same judgment in two places — the origin and A).

### 7.5 Instance disconnection

- That instance's sessions are treated **as a kind of Disappeared** (issue multi-host-cluster
  7). They return on reconnection
- An `instance-local` op during a disconnection is `instance_unreachable`
- Disconnection appears in the `reachable` field of the `instances[]` returned in `hello`'s
  response, and in the `peers` topic
- **A disconnected instance's full value set is never dropped.** Dropping it would leave things
  empty until the full set comes back on reconnection. It is kept with an "unreachable" marker,
  **replaced on reconnection, and discarded after 7 days** (DV-Q12). 7 days matches the
  retention window of inbox / last_live, aligned because "if that instance hasn't come back in
  7 days, both its undelivered messages and its previously-running-session record are already
  gone." Keeping only one of the pair leaves it with nothing to refer to

## 8. Startup and shutdown

### 8.1 What is separated per instance

socket path / HTTP bind / state dir / data dir / logs. **All are derived from the config
home.** A CLI within a session looks up its own instance from `CLAUDE_CONFIG_DIR`.

### 8.2 config

| Item | Content |
|---|---|
| Own config home | The single config home this instance sees (M6) |
| peers | A list of mesh endpoint URLs. **The same list can be distributed to every instance** (do not write one's own URL, §7.1) |
| Entry-point permission | bind, source IP, Origin |
| upstream | gateway's URL and webhook source, terminal gateway, launcher templates, sandbox origin |

**config is read only once, at startup. There is no hot reload** (DV-Q8). Because
per-instance config is small and restart is cheap (most state is volatile; the only things
persisted are the 3 kinds in §3.6), there is no reason to hold mtime watching / reload /
rewiring so that "an edit takes effect on the next request." Restarting the instance is the
sole way to make a config change take effect.

### 8.3 Startup order

1. Path resolution and creation of the state dir
2. Acquire the single-instance lock. If someone else already holds it, exit without doing
   anything
3. Load config. **A broken config fails startup** (DV-Q9). Continuing to start with the
   feature disabled would carry the state of "a feature you thought you configured is silently
   not working" through to runtime. As with the self-identification failure in §7.1, a
   misconfiguration is failed at startup
4. Load `last_live`
5. Determine `self` (§7.1). If it cannot be determined, startup fails (for configurations that
   have mesh)
6. listen (UDS → HTTP/WS). Recording the pid happens before listen. What UDS actually binds
   is `daemon.<pid>.sock`; the stable path clients use, `daemon.sock`, is swapped in
   atomically once the listener is accepting, by creating the symlink under a temporary name
   and renaming it (§8.5). Before listen, real paths whose pid is already gone are swept (the
   same test the lock takeover uses)
7. Dial to peers (§7.2)

**Watching upstream (transcript tail / `sessions/` / gateway) does not begin at startup.**
Since subscriptions are the driver of a resource's lifecycle (§6.3), it begins with the first
subscription.

### 8.4 An instance is long-running

**Lazy startup (starting when a session in that config home first calls `ccmsg`) is not
adopted** (DV-Q10). The instance is long-running (resident), and `ccmsg plugin install`
registers it for startup.

The reason is that mesh cannot tell the difference. With lazy startup, an instance we cannot
dial could be either "just sleeping (wakes on a call)" or "down," and there is no way to tell
from outside. If both are treated as `instance_unreachable` without being able to tell them
apart, an op addressed to a sleeping instance fails forever (because nothing wakes it) — only a
session on the same host can wake it; a mesh peer cannot.

Being long-running (resident) means the daemon for an unused config home keeps running too,
but per §8.3, the resident cost is just "if there is no subscription, upstream is not watched
either," so it sits waiting for connections only.

### 8.5 Shutdown order

1. Stop accepting new requests (reentrancy guard)
2. Stop watching upstream and any child processes
3. Notify all connections that "it will restart" (**before tearing down transport**)
4. Finalize what must be persisted (§3.6)
5. Release resources. **Close UDS last** — clients observe "cannot connect to UDS" as
   completion of withdrawal, so release every resource that could contend with a successor
   (HTTP listener / pid / lock) before closing it. Closing removes only the
   `daemon.<pid>.sock` this process bound; the stable path's symlink is left alone (a
   successor may have already pointed it at itself, and a dangling symlink still pointing here
   is exactly the "cannot connect to UDS" that this clause means by completed withdrawal)

That the path a listener bound is unlinked when it stops is Bun's behaviour (measured on
1.3.13). Separating the real path from the stable one is what keeps a departing instance from
deleting the address its successor has taken over.

This order is already established as convention in the old daemon, so it carries over.

## 9. Out of scope

Each entry carries its reason and which part of the purpose it ties back to. If you want to
add something listed here, the right first question is to revisit §1.

| Target | Reason |
|---|---|
| Serving the webui | The webui is its own static site (DR-0032 §2.1). The daemon provides only the API |
| Privilege separation | A4 (single uid). The boundary is the OS's uid and file permissions, not inside the daemon |
| Peers crossing the authentication boundary | A5. We do not establish mesh with an instance of a different uid / different config home |
| Storing conversation logs | The source of truth is transcript (contract §2.1). ccmsg keeps no persistent log of its own |
| Re-deriving upstream judgments | Things like the gateway's severity or Claude Code's permission decisions have the originator as their source of truth. We only copy them (§3.5) |
| Observing other config homes | M6 |
| The contract's validation logic | A1. We call the protocol repo's validator |
| Compatibility with v1 | The new lineage stands as a separate instance alongside it (DR-0032 §2.2). We do not serve both at once |

## 10. Rejected

| Option | Reason for rejection |
|---|---|
| Check role / capability per op handler | This is M1 itself. It creates two representations — the attribute table and the branching — where only one might change |
| Keep a one-shot fetch op for observation (to cut the CLI's round trips) | M2. A second route for the same value is costlier than the increase from 1 to 3 round trips |
| Rescue non-delivery with a time-window rewind | This is closing a hole in delivery guarantees with time. inbox holds "whether it arrived" as state, so no window is needed |
| Delivery via (b) only | The gap before the receiving side subscribes remains, bringing back the time window |
| Delivery via (a) only | A generation change in the unofficial protocol wipes out delivery entirely |
| Mark something dropped by (a) as delivered | The body is lost. A drop means "cannot receive right now," not "arrived" (§4.4) |
| Make inbox volatile | The undelivered body cannot be reconstructed from anywhere. It would vanish on a daemon restart (§3.6) |
| Determine Busy / Idle from raw status | Only the gateway knows whether inference actually ran (§5.1) |
| Keep the `claude agents` subprocess | Watching `sessions/` yields the same set. Launching a child process every 5 seconds falls under M3 |
| Write push suppression per topic | M5. It would create topics with suppression and topics without |
| Introduce a new op for mesh forwarding | The 3-field envelope suffices. An op duplicated per surface would be a double definition |
| Trust a forwarded op under the forwarding origin's authorization | A compromised instance could invalidate the whole cluster's authorization (§7.3) |
| Start an instance lazily | Mesh cannot distinguish a sleeping instance from a down one, and a mesh peer has no way to wake it (§8.4) |
| Reflect config changes without a restart | It adds watching / reload / rewiring for the reflection. Restarting is cheap (§8.2) |
| Continue starting up with a feature disabled on a broken config | The misconfiguration would carry through to runtime (§8.3) |
| Scan for `~/.claude*` to discover config homes | M6. The instance boundary would waver depending on the execution environment |
| Cache derived values to disk | M4. Persisting something reconstructable creates a consistency procedure |

## 11. Test policy

### 11.1 Share the contract's fixtures

The daemon's tests also read the "real wire JSON passes the schema" fixtures held by the
protocol repo. By running the frames the daemon returns through the same validator as those
fixtures, **a contract violation fails in the daemon's tests too**. The daemon side never
transcribes expected-value JSON (transcribing it would create two copies of the contract).

### 11.2 Always test authorization boundaries directly

In the old daemon, the 3 modules holding authorization boundaries were never imported from a
test even once. v2 places **a test that directly calls the route** on every route that holds a
boundary. We do not skip this on the grounds that "it's covered by e2e."

- Each of §3.2's steps 1–6 independently returns the correct code on its own
- For every op in the attribute table, a role outside `roles` gets `forbidden` (auto-generated
  by walking the table)
- For the 3 ops with `scope: "role"`, the difference in visible range by role actually shows up
- Containment of file access (each of the contained / workspace / external surfaces)
- Narrowing of delivery destinations (a user-only topic does not flow to a session role)
- A forwarded op is also authorized at the forwarding destination (§7.3)

### 11.3 Detect changes that break "do not grow"

§1.1's M1–M6 don't hold if only stated in prose, so they are pinned down with tests.

| Target | Test |
|---|---|
| M1 | Every op in the attribute table passes through dispatch (confirm via walking the table that the implementation side has no role comparison) |
| M2 | No op exists that returns the contract's topic value |
| M3 | A list of periodic timers, each with a comment stating its rationale |
| M4 | Start → stop → start does not increase the number of files beyond §3.6's 3 kinds |
| M5 | There is a single implementation of push suppression (no push bypasses the topic mechanism) |
| M6 | Nothing outside our own config home is read (confirm, by placing a separate config home, that it is not scanned) |

### 11.4 Delivery

Since delivery holds "whether it arrived" as state, the state transitions are pinned down by
tests.

- For each condition where route (a) is unavailable (flag disabled / no socket / cannot read
  key / generation mismatch / ack timeout), it falls back to (b) and the delivery result is
  the same
- When route (a) drops it, it stays in inbox, `throttled` is returned, and it is resent after
  the backoff (§4.4)
- Once delivered, it is removed from inbox. Undelivered items survive a daemon restart (§4.3)
- The 6 non-delivery reasons are determined solely from §4.2's information sources (no separate
  route is consulted per reason)

### 11.5 mesh

The test tables from mesh-peer-auth §10 / mesh-self-identification §7 are carried out as-is on
the daemon side (the PKI layer / protocol layer / boundary cases / non-persistence of state).
In addition, as daemon-specific tests:

- Forwarding loop detection (a request whose `hops` already contains itself is dropped)
- An `instance-local` op during an instance disconnection becomes `instance_unreachable`, and
  succeeds after recovery
- A disconnected instance's full value set is not dropped, is replaced on reconnection, and is
  discarded once the retention window passes (§7.5)
- Startup succeeds with an unreachable peer present, and `self` is determined (§7.1's
  relaxation)

## 12. Settled decisions

Lead's ruling (2026-09-08). The relevant sections of the body text are written in this shape.

| # | Point of discussion | Decision | Reference |
|---|---|---|---|
| DV-Q1 | Delivery route | **Prefer direct route (a), fall back to topic `inbox` (b)**. (a) is disabled by a feature flag until verified on real hardware | §4.1 |
| DV-Q2 | When (a) drops a message | **Do not mark it delivered; keep it in inbox and resend with backoff**. The response is `delivered: false, reason: "throttled"` | §4.4 |
| DV-Q3 | Persisting inbox | **Persist it** (append-only jsonl, cleared on delivery). An undelivered body cannot be restored as a derived value | §4.3 / §3.6 |
| DV-Q4 | Basis for retention period and count limit | **Written on the contract side**. The daemon only references the contract's values | §4.3 |
| DV-Q5 | Source for the Busy / Idle judgment | **The gateway's request / response events are authoritative**. Raw status is used only for `waiting` (dialog) and process existence | §5.1 |
| DV-Q6 | Polling `claude agents` | **Replaced**. Read via watching our own config home's `sessions/` plus a low-frequency confirmation poll; no subprocess is kept | §5.1 |
| DV-Q7 | transcript's fold | **A single one** (M5). No light/heavy two-tier setup | §3.3 |
| DV-Q8 | Reflecting config | **Unified to once, at startup**. No hot reload | §8.2 |
| DV-Q9 | A broken config | **Startup fails** (fail-fast, the same treatment as a self-identification failure) | §8.3 |
| DV-Q10 | Startup timing | **Long-running (resident)** (registered for startup at `ccmsg plugin install` time). Lazy startup is not adopted | §8.4 |
| DV-Q11 | Self-identification relaxation | **Adopted** (unreached peers are excluded from the match count; startup failure only at a match count of 0 or 2+) | §7.1 |
| DV-Q12 | A disconnected instance's full value set | **Kept until reconnection, discarded after 7 days** (the same window as inbox / last_live) | §7.5 |

### 12.1 Changes that went into the contract side

DV-Q2 / DV-Q4 entail changes to the contract, already reflected by the lead into the protocol
v2 design: `throttled` was added to the non-delivery reasons, and 7 days / 256 items got their
rationale (matching last_live's retention window / symmetric with Claude Code's own receive
queue limit). The daemon only references these values and does not decide them itself (§4.3).
