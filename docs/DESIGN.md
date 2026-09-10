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

### 1.3 What M3 covers, and the time values that are not periods

What M3 names is the **periodic timer**: an interval value decides how often something is
gone and looked at, and the value cannot be explained by measurement, upstream behaviour, or
spec. The daemon also holds time values that are not periods — windows, expiries, cut-offs —
and those are outside M3. Their rationale is still written on the constant's doc comment, the
same discipline §11.3 applies to the timers.

| Value | Kind | What it decides | Rationale |
|---|---|---|---|
| The gateway liveness window, 5 minutes (`GATEWAY_LIVE_WINDOW_MS`) | window | How recently the gateway must have seen a session for that **alone** to count as alive (§5.2). Compared against `now` at the moment of reading; there is no timer | The window's role is written in the implementation, but no primary source explains the value of 5 minutes itself (**provisional**) |
| The sandbox grant expiry, 30 minutes (`GRANT_MS`) | expiry | How long a minted URL works. Minting the same scope again returns the same grant with its expiry moved out, so a preview in use keeps working and a forgotten one stops on its own. Expiry is judged at the moment of reading; there is no timer | The rationale is the shape (use extends it, neglect ends it). 30 minutes is the bound on how long a forgotten URL stays valid, not a measured value |
| The launcher drain, 500 ms (`DRAIN_MS`) | cut-off | How long the pipes are read after the command has exited. A launch that starts a session in a terminal leaves a grandchild holding the write end, so end-of-file may never arrive, and without a bound the reply would wait for that session to finish. On an ordinary exit every descriptor closes at once and the bound is never reached | Only a detached launch reaches it; everywhere else it costs nothing |
| The launcher force kill, 500 ms (`FORCE_KILL_MS`) | cut-off | How long a command that outlived its allowance (the config's `timeout_secs`) and was sent SIGTERM is given to leave before SIGKILL | A single grace per launch |

None of these decides how often anything is looked at. A window and an expiry only judge age at
the moment of reading, and a cut-off fires once per launch. Getting a value wrong changes when
something ages out or how long an answer waits, never whether the daemon goes back to look at
something again — and the latter is what M3 exists to prevent.

## 2. Assumptions

| # | Condition | If not satisfied |
|---|---|---|
| A1 | The wire contract (types, op attribute table, topic attribute table, validators) is owned by the protocol repo | The daemon writes its own validation and drifts out of sync with the webui's interpretation (the old daemon's state) |
| A2 | instance = 1 config home. The daemon process is 1:1 with the instance | It becomes undefined which config home's sessions are being answered for |
| A3 | The runtime is Bun. UDS, child processes, and file watching use Bun's APIs | The premise of startup and distribution (single binary) changes |
| A4 | daemon, sessions, and webui users are a single uid. No privilege separation | The UDS 0600 and the config home's 0600 key stop being the boundary, requiring authorization to be rebuilt |
| A5 | mesh peers are only instances that have passed the §7 authentication, and never cross the authentication boundary (uid / config home) | The basis for executing an op that came over mesh under one's own instance's privileges disappears |
| A6 | TLS termination and the public FQDN belong to what sits in front (a reverse proxy). The daemon takes plain HTTP / WS on loopback | Certificates, their renewal and a public name to be reached by become the daemon's to manage — three of the things §1.1 puts outside it — and binding to loopback stops being what keeps it off the network |
| A7 | Instances are peers: whichever one is connected to, the same set is visible. Conversation between sessions is not peer-like, and how a received message is to be taken is stated by the plugin's skill, not by the wire | A caller has to know which instance is the right one to ask; and manners that differ per harness would have to become contract |

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
| Entry-point permission | source IP allowlist, mesh peer TLS |
| Determining identity | binds a role and (for sessions) a sid to the connection as the result of `hello` |

**A person is authenticated by a passkey** (DR-0001; where it joins the rest is §3.7). A person's
WS connection presents the subprotocol `ccmsg.token.<access token>`, and a handshake whose token
no record answers to is refused. `source_ips` remains as the allowlist for *where* a connection
may come from, but **what answers "who came" is the token alone**: the `Origin` is not read, since
it would be a second answer to a question the token has already answered — one the operator would
have to keep in step with every URL the instance is reached through. A handshake without a token
is refused rather than let in as an anonymous person. The access token's
expiry is the connection's, stated by `hello`'s `auth_expires_at` and extended by `auth_refresh`
on the connection itself. UDS presents nothing and carries no expiry, since reaching it already
means passing the directory's permissions. mesh has the peer's TLS plus `iss` / `aud` and a proof
(§7.2), and webhook has `Authorization: Bearer`; each of those routes carries a secret of its
own.

**A proxy in front of the instance is one the operator names, or it is not believed.**
`entry.trusted_proxies` holds address blocks in CIDR notation, and `X-Forwarded-For` is read only
when the address the listener observed is inside one of them. Nothing else could decide it: a
forwarding header is written by whoever is in front of us, and anyone who can reach the port can
write one, so until the config says who the front is the header is a claim from a stranger. Where
the chain is believed, it is read from the right and the first hop that is not itself a named
proxy is taken — the entries to its right were written by our own hops, and everything to its left
by whoever was talking to the outermost one. This is separate from `source_ips` because the
questions differ: that one is who may connect at all, this one is whose account of somebody else
to take, and a proxy is commonly let in without being the only thing let in. What is recovered is
the person's address for `registered_ip`, `last_used_ip` and `last_refresh.ip` — a hint they
recognise their own sessions by and nothing is decided by (DR-0001 §2.2). Getting it wrong costs
little in access and much in that hint: a forged address kept on a record points the one person
reading it away from themselves, which is why an unnamed front leaves the observed address rather
than a guess.

**A person's and a gateway's entry points (`<endpoint>ws`, `<endpoint>auth/*`,
`<endpoint>webhook/<source>`) are matched by the end of the path, and the prefix is not asked about** (DR-0001 §2.7). A proxy may pass the
path through with its prefix intact, which is what lets an alias endpoint, or a load balancer
putting several instances behind one origin, hold without any relation to this instance's own
endpoint. **Only the mesh's key (`/mesh/jwk/<kid>`) stays under that endpoint's path**: the tie is
the boundary keeping two instances on one origin from answering for each other's keys
(mesh-peer-auth §6.3), and a person's entry has no such key space.

**A connection greets once, and the reply is what binds its identity.** The role is set once and
fixed for the connection's life (contract, `Role`); a second `hello` on a connection whose
identity is settled is `bad_request` whether it repeats the role or names another — it is not a
re-identification but a request to be somebody else on a connection that already is somebody.
The binding happens at the moment transport writes the `hello` reply (`hello` is the one op name
transport knows; every other op is opaque to it). A `session` or `user` greeting is answered
synchronously; **the `instance` greeting is the only one that answers with a promise**: it
cannot be answered until the mesh-peer-auth verification has run, and since nothing but a reply
settles an identity, the connection stays anonymous until the verification is done (§7.2). An
instance with no mesh refuses an `instance` greeting with `capability_unavailable`.

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
| mesh | the last whole value each peer stated on a cluster-wide topic, and the mark saying whether it can be reached (§7.4 / §7.5) | the originating instance |

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

Write only 6 kinds of things.

| Target | Reason |
|---|---|
| The instance id (`<state dir>/instance.id`) | This instance's identity. Lose it and `mid`, the store's keys, `last_live` and the issuer of every record it minted all lose what they point at |
| `last_live` (previously running sessions) | Losing it on restart makes Paused / Disappeared rows vanish from the list |
| Logs | To read the cause after a crash. Keep a single writer that does not drop the line right before exit |
| inbox (undelivered messages) | State that cannot be reconstructed from anywhere else (§4.3) |
| kv (values saved through `kv_write`) | The value a person saved, itself. Not a derived value: a client's copy is a copy |
| auth records (`<state dir>/auth/records.json`, mode 0600) | The registered credentials, token families and tombstones (§3.7). A credential exists nowhere but the authenticator and here, and losing a family logs its person out |

auth records are outside M4's scope for the same reason: a credential exists in the
authenticator and here, and nowhere else it could be reconstructed from. The copies the other
instances hold are replication rather than derivation — lose them all at once and nothing brings
them back.

inbox and kv are not exceptions to M4 — they are outside M4's scope. What M4 forbids is persisting
**derived values**, and an undelivered message is not a derived value. The sender's
`message_send` has already returned its response and is done; the body that "has not yet
arrived" exists nowhere in transcript or upstream. If the daemon loses it, the body is gone
with it. kv follows the same reasoning: a saved theme is the person's setting, and losing it
loses what they set (the contract's kv.ts assumes instances mirror these values and settle
disagreements by `updated_at`, which assumes a value outlives the process holding it).

There is no room jsonl (per contract §2.1, the source of truth for conversation logs is
transcript). Sandbox grants, subscription state, in-progress fold results, and the list of
config dirs are all reconstructable, so none of them are written (M4). pid / socket / lock are
resource handles, not state. **The instance id is the opposite case, and is written because it is
an identity rather than a handle**: everything the instance issued (`mid`, the store's keys,
`last_live`, a record's issuer) is keyed by it, so deriving it from the process or from where the
instance currently sits would make all of them lose what they point at the moment that derivation
changed. Moving an instance is moving the state directory, and the id travelling with it is the
only shape in which none of that is invalidated (DR-0001 §2.1). **The mesh's signing keys are not
written**: they are ephemeral keys, one per connection, minted at the dial and destroyed on the
acknowledgement (mesh-peer-auth §7), and they exist only in memory. Putting one in the state
directory would create a place to keep it and a way to recover it — two things to manage,
against §1.1.

The state directory holds one more thing: `dumps/`. `session_dump_write` writes the records it
cut out of a transcript to `<state dir>/dumps/<sid>-<generated_at>.json` and answers with that
path. This is none of the 5 kinds above, and it is not persistence in this section's sense: the
instance never reads the file back, and nothing breaks if it is gone. What the op adds over
reading the transcript is a durable artifact whose path can be handed to a successor session
(instead of a body that travels out through a client and back in again), and since the caller
never supplies a path, there is nothing for containment to judge. It lives under the state
directory because §8.1 derives every per-instance path from the config home.

It does not contradict M4 either. What M4 forbids is putting a derived value on disk and keeping
it consistent with its source; the harm is the consistency procedure that creates. A dump is
derived from the transcript, but it is a single cut fixed by its generation time and its bounds,
never made to follow the source, so no such procedure arises. Its standing is "an artifact a
person had an op make": like a child process the launcher started or a URL the sandbox minted,
it is an effect the instance leaves in the world on request, not state of the instance. Nothing
discards them.

### 3.7 Authenticating a person (passkey)

DR-0001 is the source of truth. What is here is only where it joins the other layers.

**Registration can only begin locally.** `ccmsg daemon passkey add <unit> [endpoint]` issues one
registration URL (`<endpoint>#register=<jwt>`) and **a six-digit code**. An endpoint is the
instance's own public base URL (`https://h/personal/`) and the web UI is served there, so nothing
has to be taken off it to build the address. The code is not in the URL and is shown only on the terminal — the two halves reach the browser by different
routes, so a leaked URL is not a registration. The secret signing the jwt lives only in the
issuing instance's memory and is lost on a restart: there is no lasting key. These three commands
(`add` / `list` / `remove`) are **not ops of the contract but administrative frames that reach
only the instance's unix socket**: the contract defines what reaches an instance over a network,
and registration is precisely what must not. Reaching the unix socket is itself the permission,
which is the footing the supervisor's own control requests stand on.

**The four HTTP routes** (`/auth/challenge`, `/auth/register`, `/auth/assert`, `/auth/refresh`)
are "ops with `needs_hello: false` carried over HTTP", and the carrier synthesizes the
`request_id`. They are matched by the end of the path for the reason `ws` is (§3.1). They are
reachable before anything is proven, so the four share one rate limit. CORS echoes
`Access-Control-Allow-Origin` and `Allow-Credentials` only when **the request `Origin` matches, in
full, one of the endpoint origins this instance knows — its own, a credential record's
`endpoint`, or an outstanding registration URL's `endpoint`** — and answers 403 otherwise. **The
RP ID is not what decides this**: it is a domain, and admitting everything under one would let a
sibling subdomain call `/auth/refresh` with `credentials: "include"` and read the person's access
token, since a browser attaches the cookie by domain. **Serving the web UI from a subdomain other
than the endpoint's is therefore not supported** — the UI is served below the endpoint.

**Authentication is bound to the record's endpoint, the base URL whole.** A registration writes
the endpoint from its URL's claims into `CredentialRecord.endpoint`, and register and assert are
accepted only where **`clientDataJSON.origin` is the endpoint's origin** and **the path the
request arrived at is the endpoint's path**. `https://h/` and `https://h/personal/` are two
endpoints and take two registrations — the RP ID is the host and may well be the same for both,
because it says which domain an authenticator answers for, which is coarser than which instance a
person has been admitted to. **The RP ID is fixed to the endpoint's host** and there is no way to
state another: naming a registrable suffix would make the credential usable at every host under
it.

**Tokens are unsigned opaque values**, verified by looking a record up. **A family has one access
token, shared by every page (tab) the person has open**: a rotation turns the refresh cookie over
every time, but leaves the access token standing until less than half its TTL is left and mints a
new one only then. Minting on every rotation would take the token out from under the other tabs —
one tab's load would break the rest. Half is the largest threshold that still leaves a full half of
the token's life for a page to notice the new value. The access token is in
the response body; the refresh token is an httpOnly cookie
(`__Secure-ccmsg-<first 16 hex of sha256(instance id + newline + sub)>`,
`HttpOnly; Secure; SameSite=Strict; Path=<the request path up to its /auth/>`). A family is
written by the instance that minted it (`iss`) alone, so a rotation that lands elsewhere is
forwarded there with `auth_rotate` (the route of §7.3). **A copy of a family this instance minted,
arriving from a peer, is refused**: with a single writer, a copy coming back is necessarily older
state, and taking it would revive a family that was failed. The generation before the standing one
is answered with the previous reply as a retry's grace; presenting any other retired value fails
the whole family — at the family's `iss`, which the instance the value was presented to reaches
with `auth_rotate` rather than writing a family it does not own (an unreachable issuer leaves the
refusal as the whole answer). Failing writes a family tombstone kept for seven days rather than
deleting the record, so a peer that was partitioned cannot bring its live copy back as the newer
write. What was rotated away is kept on the family as `retired`: the sha256 of each
value until that value would itself have expired. Only the `iss` writes it, but it replicates —
so the memory survives that instance restarting and holds wherever the reused value is presented.
Entries past their own expiry are dropped at the next rotation, after which remembering them would
refuse nothing their expiry does not. Failing a family and receiving a
tombstone both close the connections that person holds, a tombstone from a peer included.

`hello`'s `auth_expires_at` is the connection's deadline, and `auth_refresh` moves it only with
**that same person's** access token. The ops the table carries over HTTP (`auth_challenge`,
`auth_register`, `auth_assert`, `auth_refresh_token`) are **not reachable as frames**: reading or
setting a cookie is not something an open connection can do, so answering one there would answer
without the half that matters, and dispatch refuses them from the table. The carrier runs
`OP_SCHEMAS` before any handler, and refuses a POST that carries no `Origin`.

**A challenge is 32 bytes of randomness plus its issuer (an instance id), good for five minutes
and good once.** Behind a load balancer the instance that issued it need not be the one that
receives the answer: the receiver verifies the assertion itself and asks the issuer only to spend
the challenge and to check a registration jwt, with `auth_resolve`. **The six digits travel to the
issuer unjudged**: a receiver that decided them would count the tries separately per instance,
letting somebody spread guesses across the cluster. The jwt, the code and the count of attempts
are the issuer's alone.

**The person's WebAuthn user handle (`user_id`) is settled once per subject by the issuer.**
Sixteen random bytes go in the jwt, the page creates the credential against them, the record keeps
them as `user_handle`, and an assertion naming a handle is held to it. An authenticator stores the
handle beyond this instance's reach, so two values for one person would show up on their device as
two accounts; a second registration of the same subject reuses the handle it already has.

**Credential records, token families and tombstones are replicated on the `auth_records`
topic.** It does not ride the relay of §7.4 — its granularity is `element`, so there is no whole
value per instance and the receiver folds entries by key. Its only role is `instance`, and unlike
every other topic the relay carries, **it is subscribed to as the instance** rather than on a
person's behalf: put where a person can read it, a token would be their session. `passkey remove`
writes a tombstone per subject, and a tombstone refuses every later write under its key (the
exception to last-write-wins). A credential's tombstone is kept without end; a family's for seven
days.

### 3.8 Harnesses

An instance answers for one config home (A2). **Which program owns that config home** is an
attribute of the instance and **is not stated in the contract**. `ccmsg daemon add --harness
<kind> <dir>` writes it into that entry of the shared config, and the instance reads it at
startup (§8.2). The default is `claude`, so an existing entry runs unchanged.

**Why a setting rather than a discovery**: an empty config home says nothing about the program
it belongs to. An instance that guessed would walk the wrong tree for the whole of its first
session.

The differences are these six and nothing else reads the harness.

| What | claude | codex |
|---|---|---|
| Environment variable naming the config home | `CLAUDE_CONFIG_DIR` | `CODEX_HOME` |
| Environment variable naming the session | `CLAUDE_CODE_SESSION_ID` | `CODEX_THREAD_ID` / `CODEX_SESSION_ID` |
| The file that says "this is a config home" | `settings.json` | `config.toml` |
| Evidence that a session is there | `sessions/<pid>.json` (carries pid, cwd, status) | `thread-writer-locks/<thread-id>.lock` (carries only the thread id) |
| Where transcripts live, and their names | `projects/<flattened cwd>/<sid>.jsonl` | `sessions/<year>/<month>/<day>/rollout-<start>-<thread-id>.jsonl` |
| Direct delivery (route (a)) | Write to the messaging socket (§4.1) | `codex queue --thread <sid> --message <text>` |
| Where the plugin goes | Registered through the agent's own CLI | Written straight into the config home's `hooks.json` and `skills/` |

For both, the sid is the value the harness itself states. On Codex that is the thread UUID, and
the `SessionStart` hook, the rollout's filename and `codex queue --thread` all carried the same
one (measured against codex-cli 0.153.4). A reverted thread's rollout is named
`<thread-id>_<rollout-id>`, and **the first half is what names the session**, so ccmsg resolves
it to the same single session.

**The `agents` topic is Claude Code's own.** The contract's `AgentInfo` requires a pid, a cwd
and a kind — it is Claude Code's own list (see the upstream note on `AgentInfo`) — and a lock
file carries none of them. So a Codex instance reports **nothing** on `agents`. Where a session
runs and what it is called is what its greeting said, and the registry holds that for every
harness alike.

**Which session a process is inside is not decided by the order of environment variables.** A
session started from another session inherits its whole environment, so **both config homes are
named at once** (measured: the hook environment of a Codex session started from a Claude Code
session carries `CLAUDE_CONFIG_DIR` and `CLAUDE_CODE_SESSION_ID`). What decides is the
**session variables**, and the config home is read from whichever harness claimed the process —
one answer for both "who am I" and "which instance do I speak to", so the two can never
disagree.

Where more than one claims it, **Codex is asked first**. Claude Code exports its session id into
every process it starts, another harness included; Codex names its thread only to the commands
of its own turn, and the narrower claim is the truer one. The reverse nesting — a Claude Code
session started from a Codex turn — reads as Codex, and `--sid` is what says otherwise.

**Sending from a Codex session depends on Codex naming its thread, which is unverified.**
`ccmsg post`, `reply` and `peers` take their own sid from the variables above. What was measured
is that the `SessionStart` hook's environment carries only `CODEX_HOME`; **whether Codex passes
`CODEX_THREAD_ID` to the commands a tool runs was not observed** (0.153.4 sends no `tools` in the
Responses request, so a mock model cannot make it run a shell command). If it does, a Codex
session sends as itself with nothing further. If it does not, `--sid <thread-id>` is the only
way, and the sending side is unsupported. Either way, a send from a Codex session is never
attributed to the parent Claude Code session, because Codex's claim is read first.

**A route that names the config home does not go through that inference.** Where the caller has
decided the home — `daemon <sub> <dir>`, `plugin install <agent>` — the paths are derived
straight from that value (`resolvePathsFor`). Re-deriving from the environment would make the
target depend on which session the command happened to be run inside.

**The hook script ccmsg lays down drops the other harness's variables before calling `ccmsg`**
(`env -u CLAUDE_CONFIG_DIR -u CLAUDE_CODE_SESSION_ID CODEX_HOME=…`). A hook speaks for the
session it fired for, not for whoever started that session. For the same reason, route (a) drops
those variables when it runs `codex queue`.

**Stale locks**: a thread that ends normally takes its lock with it. A process killed outright
leaves it behind (measured). The upstream thread store holds the lock with flock and, when
somebody next starts writing a thread, sweeps the locks it can take — "takeable" meaning nobody
holds it — so a leftover lock stands until then. Testing it with flock would settle staleness,
but Node has no flock, so that is not taken. The thread therefore reads as present until the
sweep.

**Hook trust**: Codex will not run a command hook a person has not reviewed. `plugin install
codex` lays the files down and answers that trust is required in `needs`; it does not write the
trust itself (trust is Codex asking whether this program may run, and answering that on
somebody's behalf is not an install's business). `hooks.json` belongs to the config home, so it
is **merged**, and uninstall takes out only the entries ccmsg put there.

## 4. Delivery

The contract's `message_send` promises only "deliver to the destination sid," returning a
reason if it fails to. The daemon-side implementation splits into those two things: the
delivery means, and determining the reason for non-delivery.

### 4.1 Two routes for the delivery means

| Route | Content | Prerequisites |
|---|---|---|
| (a) Directly to the harness's own way in | Claude Code: connect to the `messagingSocketPath` in `sessions/<pid>.json`, authenticate with the config home's 0600 `peerToken` key, then write a user frame. Codex: hand the text to `codex queue --thread <sid>` (§3.8) | Unofficial protocol. On Claude Code the `peerProtocol` generation must match; on Codex `codex` must be on `PATH` |
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

0. **The feature flag is enabled** — verified on real hardware, so it is enabled by default
   and can be turned off in config (while it is off, delivery is accomplished by (b) alone —
   the fallback simply becomes the everyday route; the semantics of delivery do not change)
1. `sessions/<pid>.json` has `messagingSocketPath` and a known `peerProtocol`
2. The corresponding key file can be read by ourselves (= same uid, same config home,
   matching A2 / A4)
3. The receiving side does not say, within the deadline, that it did not take the message

Condition 3 is settled on **a separate delivery-status socket, not on the connection the
message was written to**. That connection is one-way: the receiving side writes not a single
byte back. When it does have something to say, it writes a `peer_message_status` to the address
the user frame's `from` named. So ccmsg holds a UDS of its own (0600) and passes it as
`uds:<path>` in `from`.

**The receiving side sends no positive acknowledgement.** A message it accepts gets nothing
back; `refused` / `denied` / `dropped` / `expired` / `held` are raised only where it does not
take the message (2.1.263's inbound gate). So silence within the deadline reads as "it
arrived," and one of those arriving reads as the drop of §4.4. The deadline's value has no
primary source (**provisional**). What can be said for it is that the receiving side raises the
receipt from the same gate decision, so it is one UDS round trip away on this same host.

The status socket **lives beside the target's socket, not in the state directory**. The
receiving side vets the reply address and discards anything outside its own socket namespace as
`reply address unshaped or outside our socket namespace` (2.1.263), so sitting next to it is
the only way to hear anything at all.

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

**Delivery over route (b) is at-most-once.** A message counts as delivered the moment its frame
is written to the connection. The subscription's snapshot is "everything still undelivered for
that sid," and **subscribing is receiving**, so the inbox is cleared of them as the snapshot is
returned (the frame is queued on the connection right behind the subscription's reply). The same
holds when `message_send` pushes straight to a subscribed connection: nothing goes into the
inbox. If the receiving side loses the frame along with its connection, the body is nowhere.
A connection with no sid — a person watching — gets an empty snapshot: the topic carries what was
said to a session, and a person is not one.

This follows from the inbox being the place for "what has not yet arrived" and nothing else (the
table above). Keeping what was handed over until it is acknowledged would make the inbox hold
"what may have arrived," and the next subscription or the next re-offer over route (a) would
deliver the same body twice. **One message goes out on one route**: leaving a message claimed by
an in-flight route (a) offer out of the snapshot is the same rule, so a subscription arriving
mid-offer does not make it two messages.

### 4.4 When route (a) drops a message

The receiving side has rate limiting (token bucket / duplicate detection / queue limit) and
may decline and drop a message. **A dropped message is not marked as delivered** (DV-Q2). It
stays in inbox awaiting the next occasion to be offered again, and the sender receives
`delivered: false, reason: "throttled"`.

Reason: a drop means "the destination cannot receive it right now," neither "it arrived" nor
"the destination is absent." Marking it delivered would lose the body; marking it
`session_not_found` would say the destination is absent. Leaving it in inbox and resending
aligns it with the same treatment as the other non-delivery states in §4.2 (it goes out once
receivable again).

`throttled` is a reason defined by the contract, not something the daemon adds on its own. The
daemon only returns the contract's reasons and does not extend the set of reasons on its own
side. What occasions a re-offer is exactly §4.3's dequeue condition (the next `message_send` to
the same sid got through on (a) / `inbox` got subscribed / the session became live again), not
the passage of time. There is no periodic resend timer (M3 — no primary source states the
recovery rate of the peer's token bucket, so an interval cannot be anything but guesswork).
Messages go out one at a time, oldest first, stopping at the first one that does not get
through; the rest stay in inbox in order.

## 5. Session state model

The list's classification (Pinned / Waiting / alive / unmanaged / Paused / Disappeared) is
**derived by the daemon**. If the webui combines raw values to classify, the interpretation
drifts per instance.

### 5.1 Inputs

| Input | What it tells us | How it's obtained |
|---|---|---|
| Connection | Whether it's talking to ccmsg, and when it last did | transport (events) |
| The harness's own list (§3.8) | **The session's existence**, and on Claude Code also `waiting` (dialog) and the messaging socket | Own config home only (M6). **Read where a judgement needs it** |
| llm-gateway's request / response | **Whether inference is actually running** (= busyness) | webhook (push). **Counts only for sids this instance knows** |
| `last_live` + `stopped_at` | Previously running / intentionally stopped | a file we wrote ourselves |
| transcript's fold | Whether it's stopped on an API error, the last human input | tail |

**The classification's inputs do not depend on subscription.** Reading `sessions/` and
watching it are two different things, and what §6.3 makes subordinate to subscription is only
the latter. Which sessions exist is a fact about the instance itself, so the directory is read
where a judgement needs it: `message_send` deciding on an addressee, the recompute that writes
`last_live`, and classification. The watch and its poll are the resource that pushes a change
to subscribers, not the route by which an answer is obtained. Confusing the two makes a live
session `session_not_found` while nobody is subscribed, and writes a session that is still
running into `last_live` as gone.

**A Codex session names no terminal.** "Unmanaged" in the classification means "alive, but with
no handle to type into" (§5.2), and there is no way to type into a Codex thread the way a
terminal is typed into. So a live Codex session this instance holds no connection to reads as
`live_unmanaged`. Delivery is a separate matter: route (a) puts the message on the thread's
queue (§4.1).

**No subprocess for `claude agents`** (DV-Q6). Watching our own config home's `sessions/`
yields the same set, so the child-process launch every 5 seconds disappears entirely (M3).
Since file watching can miss events, a low-frequency confirmation poll **runs alongside it** —
this is the same shape the old daemon adopted for transcript tail based on measurement, and
the rationale for the interval is "catch changes that the watch dropped before the user
notices," not the primary acquisition route.

**The gateway's events count only for sids we know.** The gateway stands above every config
home and its events name nothing but a sid, so "the gateway saw it" is not by itself evidence
about *this* instance's sessions — a sid belonging to another config home would classify as
live here, put a row on `peers`, and make `message_send` accept an addressee that has no inbox
here. What counts as an input to liveness (`gateway_active_at`) is only a sid that **has
greeted us — still connected or remembered in `last_live` — or that our own config home's
`sessions/` names**. The events themselves are not dropped: they go out on the `llm_requests`
topic, which is a view of what the gateway sees rather than of this instance's sessions.

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

"Recent" in "has recent gateway activity" means within 5 minutes of the gateway last seeing
inference (the liveness window of §1.3). An observation outside the window is no basis for
liveness, and the next time a payload is built it is gone from the row's `gateway_active_at` as
well. The window is judged at the moment of reading; no timer announces that it has closed
(§1.3).

### 5.3 The two kinds of "last activity time"

The old daemon kept "the time updated on every ccmsg request" (the agent's busyness) and "the
time the human typed input" (the sort order) in two separate places. v2 **makes explicit at
the type level that these are two values for two different purposes**, and decides in one
place which one drives the sort order. They are never held under the same name.

### 5.4 The two routes from a sid to its transcript

The file a sid names is reached by **two routes: what was announced, and the walk**. The
`transcript_path` a `hello` stated comes first — it is exact and costs no search. A sid that
announced nothing (a session that never greeted this instance, or one that is over) is found
by walking `projects/**/<sid>.jsonl`, reaching the same file through **the identity the
filename carries**. The op that reads one (`transcript_read`) and the side that follows one
(the tail behind `transcript:<sid>`) both ask the same way, so **one sid resolves to one file
whichever way it is reached**.

Both routes share a single boundary: **nothing outside this config home's `projects/` tree is
ever looked at** (M6). An announced path was taken only because it was inside that tree, and
the walk is a walk of that tree. What decides acceptance is **where the file goes, not whether
it is there**: at the moment a session-start hook states the path the harness has created
neither the file nor its directory, and a config home whose first session is greeting may not
have `projects/` yet either. The part of the path that exists is resolved, the part that does
not is kept as spelled, and the whole is compared against the tree — so a path that climbs out
through `..` or a symlink is refused however far inside it is spelled. A path that is not taken
simply leaves that field absent from the session's `peers` row, and `hello` still answers `ok`
(the contract is unchanged) — **the reason goes to the daemon's log as one line**, which makes
it the operator's answer rather than the contract's.

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
| Suppression | **For the granularities that replace the value**, do not send if identical to the last value sent (**a single implementation shared by all topics**, M5) |

The old daemon had suppression on only 3 topic-equivalents, and each was a separate
implementation. v2 builds suppression into the topic mechanism itself, so "this topic has no
suppression" can never happen.

### 6.2 Delta granularity

| Granularity | topic |
|---|---|
| Full replacement per instance | `peers` / `agents` / `session_errors` / `llm_requests` / `llm_status` |
| Full replacement | `session_status:<sid>` |
| Element add / update | `inbox` / `kv:<ns>` |
| Append (byte offset) | `transcript:<sid>` |
| Event (no value held) | `notify` |

The snapshot of `transcript:<sid>` is **the file's current end (`size`) and nothing else**;
what is appended flows after it. It is stated for any file the two routes of §5.4 reach, so
**even a past session that will never be appended to again says where to page back from**. The
subscriber reads back from that size with `transcript_read`, and anything appended stitches
onto the same offsets.

**Suppression applies to the two full-replacement granularities only** (`whole` /
`per_instance_whole`). Sending the same full value again leaves the subscriber holding what it
already holds, so there is nothing in it to send.

Suppression compares against the last wire sent, so **a payload never states when it was
read**. The `agents` contract has a `polled_at`, and this instance leaves it out: a value that
changes on every confirmation poll (§5.1) would make each poll a value the list did not have
before, even for a directory that had not changed, and the one suppression every topic shares
(M5) would let it through as a five-second heartbeat.

**The delta granularities (`element` / `append`) and `event` pass straight through.** Two
frames with the same content are two things happening, not a duplicate — offering an inbox
message again is the one chance to reach a peer that was not listening the first time, and
restating a `kv` entry is itself the operation. **Event** additionally holds no current value,
so subscribing to it produces no snapshot. Suppression stays one implementation, which reads
the contract's granularity to decide where it applies.

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
- What is subordinate to subscription here is **only the watch that pushes changes**, never
  **reading what the state is right now**. Asking an owner for its current value (§3.3) and the
  classification inputs of §5.1 give the same answer with zero subscribers
- An instance whose cluster-wide topic has been subscribed to also subscribes to the same
  topic on each mesh peer, and streams the received frames straight through to its own
  subscribers (keeping the originating `instance` intact) (§7.4)

## 7. mesh

### 7.1 Endpoint and id

**An endpoint is the instance's public base URL** (`https://h.example/personal/`, trailing slash,
`http(s)://`). `<endpoint>ws` (upgraded in place, the scheme kept), `<endpoint>mesh/*`,
`<endpoint>auth/*` and `<endpoint>webhook/*` are routes below it rather than part of the address
(contract, `Endpoint`).

**All config carries is `peers` — every mesh endpoint, this instance's own among them — and
which of them is this instance is settled at startup by the probe** (mesh-self-identification,
§8.2, DR-0001 §2.7). The URL of an instance sitting behind a proxy or an alias is not a value
the process can read off its own socket, but the probe never reads the URL a request came in
on: it turns only on whether the probe arrived here, so it holds through a proxy or an alias
alike.

**The procedure**: a probe carrying a token minted per destination goes to every endpoint in
`peers`, and the token that arrives at this instance's own listener is matched against the
table. The one URL it matches is this instance's endpoint. The probe to ourselves must not be
left out of the send — it is the one that always arrives, so a peer echoing a stolen token back
makes two matches and fails rather than being believed (mesh-self-identification §4.2).

**No match, or more than one, fails startup**. None means `peers` does not name this instance,
or names a URL nobody answers at; more than one means two URLs reaching one instance (an alias,
a load balancer), and since neither can be preferred as the proper name, startup is failed the
same way a broken config is (§8.3). A peer that did not answer is left out of the count and
recorded rather than refused — one machine being powered off or asleep is the normal state of
this mesh (DV-Q11) — and remains a dial target under §7.2. The settled endpoint is not dialled
(§8.2).

**The instance id is a separate thing from the endpoint.** The id is a fixed value held in the
state directory (§3.6) and the endpoint is a URL that configuration can change; the
correspondence between them is made by the handshake: `MeshHello` names the id, and the binding
is made once the proof passes (riding mesh-peer-auth §5.1 R7, "what the greeting said becomes
trusted retroactively after the proof"). The dialling side makes the same binding from the
`instance` in the peer's `hello` reply — in that direction what vouches for the name is the TLS
of the URL that was dialled.

**One id binds to one endpoint and no more.** A greeting naming an id already bound to another
endpoint closes the newcomer: the only thing vouching for a name is the endpoint list the
operator distributed, so the binding that list has already vouched for is the one kept. This is
what an instance that has moved runs into while the one at its old URL is still up, and the
remedy is to take the old endpoint out of every peer's `peers`, not to let the newer link win.

Looking up the link to dial down from `to_instance` (an id) also goes through this table (§7.3).
An endpoint that has finished one handshake stays in it after a disconnection and appears in
`instances[]` marked unreachable (§7.5).
**A peer the config names appears in `instances[]` before any handshake too**, with no `id` on
its row, because nobody has claimed one yet. Hiding a row without an id would hide the peer
whose link is down — the very row a reader is looking for — so it is stated with its endpoint
and `reachable` alone. An instance with no mesh has no URL to be named by, so it states no
`endpoint` — neither on the reply nor on its own row, which is still there.

### 7.2 Dial and glare

- Every instance dials all peers symmetrically (dial responsibility is not assigned to one
  side)
- Authentication is mesh-peer-auth. A `hello` with `role: "instance"` is the starting point; C2
  exchanges the key and challenge, and C1 returns the proof. No message is sent until the ack
  is received
- On glare (both sides dialed), after verifying both, the side with the lexicographically
  smaller `iss` string keeps the connection it dialed. What is compared is the **endpoint URL**
  (`iss` is the endpoint, not the id). The whole of the rule is that both ends compare the same
  two strings and so reach the same conclusion, not that either connection is the better one
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
- What they are run against is the envelope's `caller`, the identity an authenticated link
  named, rather than the forwarding instance's outcome

How "the owning instance of the target" is decided: the sid-to-owning-instance mapping is
looked for, in order, in the `peers` topic's `peers[]` (connected), then the `agents` topic's
`agents[]` (every session the harness knows of, including one that has not yet appeared in
`peers`), then the `peers` topic's `last_live[]` (disconnected but still within the retention
window). An unknown sid means "nowhere in the cluster" = `session_not_found`. However, while an
unreachable instance exists, the judgment is deferred (§4.2).

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
- The `peers` frame carries that same list in `instances`, so a subscriber learns of a link
  going down without greeting again
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
| peers | A list of mesh endpoints (each the instance's public base URL, trailing slash included). **The same list, this instance's own URL included, can be distributed to every instance** (which entry is this one is settled by the startup probe, and the reader takes itself out, §7.1). **It is the only list of URLs config carries** |
| Entry-point permission | bind, source IP |
| upstream | gateway's URL and webhook source, terminal gateway, launcher (roots and recipes), translation helper, sandbox origin |

**config is read only once, at startup. There is no hot reload** (DV-Q8). Because
per-instance config is small and restart is cheap (most state is volatile; the only things
persisted are the 5 kinds in §3.6), there is no reason to hold mtime watching / reload /
rewiring so that "an edit takes effect on the next request." Restarting the instance is the
sole way to make a config change take effect.

**There is one file, and it has two levels.** `${XDG_CONFIG_HOME:-~/.config}/ccmsg/config.json`
holds

```json
{ "defaults": { ...settings handed to every instance... },
  "instances": [ { "dir": "<config home>", ...overrides for this instance alone... } ] }
```

and each of an instance's settings resolves in the order `instances[].<key>` →
`defaults.<key>` → the built-in default. There is no file per config home because both of the
things this one carries are facts about the set — the same peer list can go to every instance
(§7.1), and "which config homes have an instance" is not a question a single instance can
answer about itself. A config home that `instances[]` does not list, run with
`ccmsg daemon run`, is `defaults` plus the built-in defaults.

### 8.3 Startup order

1. Path resolution and creation of the state dir
2. Acquire the single-instance lock. If someone else already holds it, exit without doing
   anything. If the process named by the lock file's pid is already gone (asked with signal
   0), the file is taken over and the lock contended for again
3. Load config. **A broken config fails startup** (DV-Q9). Continuing to start with the
   feature disabled would carry the state of "a feature you thought you configured is silently
   not working" through to runtime. As with a failure to settle this instance's endpoint in §7.1,
   a misconfiguration is failed at startup. What the config names is resolved here too, and fails
   for the same reason: a gateway webhook secret that cannot be read, and a translation helper
   that cannot be run, are each exactly the state of a configured feature silently not working
4. **Read the instance id** (generating it here when the state directory has none, §3.6). It
   comes before everything derived from it: `mid`, the store's keys and `last_live` are all
   keyed by that id, so there is nothing that may be built while it does not exist. A config
   home the shared file's `instances[]` does not list, started with `ccmsg daemon run`, gets
   its first id here too (DR-0001 §2.1)
5. **Settle this instance's endpoint** (§7.1). On a configuration with mesh, **the WebSocket is
   bound first**: what settles it is the probe this instance sent arriving at its own listener,
   so it cannot come before listen. In that window the listener answers only the two
   pre-authentication routes — the probe and the key of mesh-peer-auth §6 — and refuses
   everything else until the instance exists (a window of one round of probes). No match, or
   more than one, fails startup; a peer that did not answer is recorded and left as a dial
   target. A configuration without mesh is never dialled, so it has no endpoint and states none
   in `hello`
6. Load `last_live` and the inbox. These come after step 4 because every entry of both carries
   the instance id as its `instance` — nothing derived from the id exists before the id does
7. listen. Record the pid → prepare the socket dir and sweep the real paths whose pid is
   already gone (the same test the lock takeover uses) → bind UDS at `daemon.<pid>.sock` →
   swap the stable path clients use, `daemon.sock`, in atomically once the listener is
   accepting, by creating the symlink under a temporary name and renaming it (§8.5) → the
   WebSocket (on a configuration with mesh, the one bound in step 5 is taken in; on one without
   mesh that serves HTTP, the listener is bound here)
8. Dial to peers (§7.2)

**Watching upstream (transcript tail / `sessions/` / gateway) does not begin at startup.**
Since subscriptions are the driver of a resource's lifecycle (§6.3), it begins with the first
subscription.

### 8.4 An instance is long-running

**Lazy startup (starting when a session in that config home first calls `ccmsg`) is not
adopted** (DV-Q10). The instance is long-running (resident), and **keeping it that way is two
levels of supervision**:

- `ccmsg daemon supervise` — the foreground supervisor. It reads the shared config's
  `instances[]` once at startup (DV-Q8), starts each config home's instance as a child
  process, and starts it again when it dies. The wait before a restart grows exponentially
  (the reason is on the values themselves: a config that fails at startup must not spin the
  supervisor). On SIGTERM it stops each child with `instance_shutdown`, in the order of §8.5.

  **The supervisor is the only route by which an instance is started.**
  `ccmsg daemon start / stop / restart / status` are requests to it, and the CLI has no
  route of its own for starting a child — an instance started another way is one nothing
  restarts and nothing knows about, which is not what being resident (DV-Q10) says. With no
  supervisor these fail with `{"error":{"code":"supervisor_not_running"}}`. The requests
  travel as JSON lines over a control socket kept with the state
  (`<state root>/supervise.sock`, 0600), and its op names carry a `supervise_` prefix to
  keep them apart from the contract's — **this is not the contract**. It is an internal
  protocol about processes on this host; no web UI and no mesh peer reaches it.

  `ccmsg daemon add` / `remove` write the shared config and then tell the supervisor (with
  none running, they only write). `remove` stops it being looked after and **does not stop
  the child**: editing a list is not a shutdown, and a session already talking to that
  instance keeps talking to it.

  There are two exceptions. `ccmsg daemon run [dir]` is a one-off foreground start outside
  the supervisor's care (and outside `status`). `ccmsg daemon log` reads the files directly
  — a log is read after something died, so it must not need the supervisor to be up
- `ccmsg service register` — registers that supervisor with launchd (macOS) or
  systemd --user (Linux). Surviving a logout is this layer's business; what
  `ccmsg plugin install` hands out is the agent-side plugin alone

The supervisor belongs to no single config home, so its output is the one exception to §8.1's
"derived from the config home": it goes to `${XDG_STATE_HOME:-~/.local/state}/ccmsg/service.log`
(on systemd a unit's output goes to the journal, so `ccmsg service log` reads that instead).
`ccmsg service status` puts ccmsg's own reading (registered / running) beside **the init
system's** (`service`: loaded / running / pid / last exit) — so that a disagreement, such as a
file that exists while launchd has never heard of it, is visible rather than smoothed over.
What the unit names as its program is registered as a path that outlives an upgrade — a
`ccmsg` on `PATH` that leads back to this build, rather than the runtime's own versioned
path, which the next upgrade takes away — and `service status` reads that path back out of
the unit (`program`: path / durable / exists), because a supervisor whose program has moved
looks, from every other field, exactly like one that was never started

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

**Authenticating a person does not belong on this list.** The daemon answers "who came" itself,
with a passkey (DR-0001; where it joins the rest is §3.7). Leaving it to whatever sits in front (a proxy's forward auth, a
tunnel's identity) would mean the shape of the identity the daemon receives varies as much as
those deployments do, so the front stays transparent (DR-0001 §3). It coexists with having no
privilege separation (A4): what the daemon holds is settling who someone is, and the boundary on
what they may do afterwards is still the uid and the file permissions.

## 10. Rejected

| Option | Reason for rejection | What would make it worth revisiting |
|---|---|---|
| Check role / capability per op handler | This is M1 itself. It creates two representations — the attribute table and the branching — where only one might change | An op whose authorization cannot be stated in the table at all — one whose answer turns on the contents of its arguments |
| Keep a one-shot fetch op for observation (to cut the CLI's round trips) | M2. A second route for the same value is costlier than the increase from 1 to 3 round trips | Round trips becoming measurable rather than countable: a listing large enough that 3 of them are felt |
| Rescue non-delivery with a time-window rewind | This is closing a hole in delivery guarantees with time. inbox holds "whether it arrived" as state, so no window is needed | A delivery surface that cannot hold an inbox, because the receiving side keeps no state of its own |
| Delivery via (b) only | The gap before the receiving side subscribes remains, bringing back the time window | Route (a) disappearing from the harness side, leaving nothing to be the first route |
| Delivery via (a) only | A generation change in the unofficial protocol wipes out delivery entirely | The unofficial protocol becoming official, so that a generation change stops being a thing that can happen unannounced |
| Mark something dropped by (a) as delivered | The body is lost. A drop means "cannot receive right now," not "arrived" (§4.4) | A drop that carries the body with it, so what was dropped could be reconstructed afterwards |
| Make inbox volatile | The undelivered body cannot be reconstructed from anywhere. It would vanish on a daemon restart (§3.6) | The undelivered body being held somewhere outside the daemon, so a restart no longer loses it |
| Determine Busy / Idle from raw status | Only the gateway knows whether inference actually ran (§5.1) | Sessions that never pass through a gateway — another harness whose inference the daemon can only see from the outside |
| Keep the `claude agents` subprocess | Watching `sessions/` yields the same set. Launching a child process every 5 seconds falls under M3 | State the harness keeps out of `sessions/` becoming necessary, so watching files no longer yields the same set |
| Write push suppression per topic | M5. It would create topics with suppression and topics without | One topic carrying a flow an order of magnitude above the rest, which a shared suppression cannot keep up with |
| Introduce a new op for mesh forwarding | The 3-field envelope suffices. An op duplicated per surface would be a double definition | A forward the 3-field envelope cannot carry — relaying through more than one hop, which needs the route stated |
| Trust a forwarded op under the forwarding origin's authorization | A compromised instance could invalidate the whole cluster's authorization (§7.3) | Trust between instances being established cluster-wide (mutual attestation), so the forwarding origin's authorization means something here |
| Start an instance lazily | Mesh cannot distinguish a sleeping instance from a down one, and a mesh peer has no way to wake it (§8.4) | A way to wake an instance from the mesh side, so a sleeping one and a down one stop being the same thing to a peer |
| Reflect config changes without a restart | It adds watching / reload / rewiring for the reflection. Restarting is cheap (§8.2) | Restarting stopping being cheap: in-memory state worth keeping across a config change |
| Continue starting up with a feature disabled on a broken config | The misconfiguration would carry through to runtime (§8.3) | Availability outweighing the carry-over, when one broken corner of a config makes the whole instance unstartable |
| Scan for `~/.claude*` to discover config homes | M6. The instance boundary would waver depending on the execution environment | An environment where the person has no way to state the config home, because somebody else prepared it for them |
| Cache derived values to disk | M4. Persisting something reconstructable creates a consistency procedure | Reconstruction showing up in startup time — session counts an order of magnitude higher |

## 11. Test policy

### 11.1 Share the contract's fixtures

The daemon's tests also read the "real wire JSON passes the schema" fixtures held by the protocol repo. The contract exports, from `@ccmsg/protocol/fixtures`, one `{request, response}` per op (`OP_FIXTURES`), one frame per topic (`TOPIC_FIXTURES`), and the ids and instant they are built from (`FIXTURE_IDS` / `FIXTURE_NOW`).

- A request frame sent to the daemon starts from `OP_FIXTURES[op].request`. A field is replaced only where that field is what the daemon is being asked about (for example, a sweep that lets dispatch choose the destination drops `to_instance`)
- The frames the daemon returns — an op's response, a topic's snapshot or event — go through the contract's schema. The daemon side never transcribes expected-value JSON (transcribing it would create two copies of the contract)
- The session, instance and endpoint a test names come from `FIXTURE_IDS`, so a frame the daemon builds and a frame the contract states name the same things

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
- A credential is accepted only at the endpoint it was registered for (an instance at another
  origin, or under another path prefix, refuses it, §3.7)

### 11.3 Detect changes that break "do not grow"

§1.1's M1–M6 don't hold if only stated in prose, so they are pinned down with tests.

| Target | Test |
|---|---|
| M1 | Every op in the attribute table passes through dispatch (confirm via walking the table that the implementation side has no role comparison) |
| M2 | No op exists that returns the contract's topic value |
| M3 | A list of periodic timers, each with a comment stating its rationale |
| M4 | Start → stop → start does not increase the number of files beyond §3.6's 5 kinds and the dumps a caller asked for |
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
- Two instances handed the same `peers` each settle on their own endpoint (§7.1)
- No match (`peers` does not name this instance) and more than one (two URLs reaching one
  instance) each fail startup (§7.1)
- Startup succeeds with an unreachable peer present, and that peer stays on the dial list
  (§7.1, DV-Q11)
- A hello naming an id already bound to another endpoint closes the newcomer (§7.1)

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
| DV-Q9 | A broken config | **Startup fails** (fail-fast, the same treatment as a failure to settle this instance's endpoint) | §8.3 |
| DV-Q10 | Startup timing | **Long-running (resident)** (`ccmsg daemon supervise` keeps it up; `ccmsg service register` registers that with the OS). Lazy startup is not adopted | §8.4 |
| DV-Q11 | A peer that cannot be reached | **Does not stop startup**. A peer that did not answer is left out of the count, recorded, and left as a dial target; startup fails only on no match or more than one | §7.1 |
| DV-Q12 | A disconnected instance's full value set | **Kept until reconnection, discarded after 7 days** (the same window as inbox / last_live) | §7.5 |

### 12.1 Changes that went into the contract side

DV-Q2 / DV-Q4 entail changes to the contract, already reflected by the lead into the protocol
v2 design: `throttled` was added to the non-delivery reasons, and 7 days / 256 items got their
rationale (matching last_live's retention window / symmetric with Claude Code's own receive
queue limit). The daemon only references these values and does not decide them itself (§4.3).
