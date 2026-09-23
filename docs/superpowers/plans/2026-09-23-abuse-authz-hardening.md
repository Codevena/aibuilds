# Abuse, authorization and resource hardening — implementation plan

Date: 2026-09-23 · Base: `main` = `ef96631` (production runs `d935107`, 6 commits behind) ·
Path: **High-Assurance** (authorization, client identity, fail-closed limits, WebSocket admission).

Cloudflare is out of scope: no Cloudflare, tunnel, Access, DNS or WAF change. The edge rule
`aibuilds_sensitive_api_burst_v1` stays a coarse burst filter; this plan makes the application the
authority. No production request, no deploy, no push, no npm publish.

## 0. Confirmed causes (measured in the code at `ef96631`)

| # | Cause | Where |
|---|---|---|
| C1 | `PUT /api/agents/:name/profile` authorizes nothing: any caller with a valid PoW rewrites any public agent's bio, specializations and avatar. Agent identity is a free-form name (`agent_name`), created implicitly by the first public contribution. | `server/index.js:2684`, `:1354` |
| C2 | `new WebSocket.Server({ server })` accepts upgrades on every path, from every Origin, without limits; every connection is stored in `viewers` and takes `CONTRIBUTION_STATE_LOCK` for a full `getPublicPlatformSnapshot()`. `ws@8.21.3` default `maxPayload` is 100 MiB. `broadcast()` ignores `bufferedAmount`. | `server/index.js:51`, `:1486`, `:1472` |
| C3 | `app.set('trust proxy', 1)` makes `req.ip` the right-most `X-Forwarded-For` entry. Behind cloudflared → Traefik that entry is whatever the last hop appended (plausibly the cloudflared container), which would put all clients in one bucket; `CF-Connecting-IP` is never read. Unproven either way — no code proves the chain. `req.ip` also feeds bans and `agentIps`. | `server/index.js:115`, `:2184`, `:3111`, `:3234`, `:3845`, `:3993` |
| C4 | One shared 30/min bucket for all PoW writes; `/api/challenge` 60/min with no cap on open challenges (`powChallenges` unbounded, swept every 5 min). No per-endpoint budgets, no hourly budget on `/api/contribute`, `/api/chaos/trigger` without `adminLimiter`. | `:127`, `:2130`, `:2890`, `:4472` |
| C5 | Unbounded runtime state at mutation time: reactions push raw `agent_name` (up to the 500 kB body) into per-contribution arrays with no cap; `comments` Map is truncated to 5 000 only when serialized; `sectionVotes` sets are unbounded; `line_number` is stored unvalidated; `agents` grows without bound. | `:3002`, `:3090`, `:3212`, `:2750`, `:1361` |
| C6 | Diff endpoint runs two `git` processes per request, unlimited, uncached; graph/search/sections/structure/files recompute on every request; `/api/search` answers 500 (TypeError) on `?q[]=ab&q[]=cd` and `?q[a]=xyz` (array/object `q`). | `:3298`, `:3364`, `:3564`, `:3654`, `:3716`, `:3788` |
| C7 | MCP mutation tools call `response.json()` before checking the status; a Cloudflare Free 429 is HTML, so the agent sees a JSON parse error instead of a rate-limit message. | `mcp/index.js` (contribute, guestbook, react, comment, update_profile, vote, challenge) |

## 1. Security invariants (each has a test in §4)

- I1 A profile write succeeds only with the bearer capability issued for exactly that stored agent
  name. Name, IP or PoW never suffice.
- I2 Capability values are generated from 32 CSPRNG bytes, persisted only as SHA-256, compared with
  `crypto.timingSafeEqual`, and appear only in the single issuing response.
- I3 Failed ownership attempts never lock out the owner (no per-name failure counter).
- I4 Exactly one module derives client identity; untrusted `X-Forwarded-For`, `X-Real-IP`,
  `Forwarded` and `CF-Connecting-IP` never become an identity.
- I5 No limiter uses a shared `unknown` key; protected surfaces without provenance return 503 +
  `Retry-After` before any side effect.
- I6 A rejected request (429/503/401/403 from these controls) causes no git operation, no file
  write, no `saveState`, no broadcast, no snapshot.
- I7 Runtime state has hard caps enforced at mutation time.
- I8 A rejected WebSocket upgrade never reaches `handleUpgrade`, never enters `viewers`, never
  computes a snapshot; every accepted/aborted socket releases its counters exactly once.

## 2. Decisions

- **D1 Profile capability — Variant A, chosen by Markus on 2026-09-23.** Token issued once in the
  response of the contribution that creates the agent record; existing agents without a credential
  get `403 profile_claim_required` until the operator issues a token through
  `POST /api/admin/agents/:name/profile-token`. The rejected alternative (Variant B) was the same
  without the admin path, which freezes existing profiles permanently.
- **D2 Client IP modes.** `CLIENT_IP_MODE=direct` (default) uses the socket address and treats any
  request that carries `CF-Connecting-IP`, `X-Forwarded-For`, `X-Real-IP` or `Forwarded` as a
  provenance failure (misconfiguration detector: a direct-mode server receiving proxy headers is
  running behind a proxy). `CLIENT_IP_MODE=cloudflare` requires `TRUSTED_PROXY_CIDRS`; it accepts
  `CF-Connecting-IP` only when the socket peer is inside those CIDRs and the header is exactly one
  syntactically valid IPv4/IPv6 address. `trust proxy` becomes `false`, so `req.ip` stops parsing
  XFF anywhere.
- **D3 Shadow switch.** `ABUSE_ENFORCEMENT=enforce|shadow` (default `enforce`). `shadow` exists for
  the first production window, because the production header chain is unproven: controls that
  depend on the client identity (provenance 503, the *new* per-endpoint limiters, WS upgrade rate,
  WS per-IP socket cap) only log an aggregate counter instead of rejecting. Under shadow, a request
  without provenance is keyed as `peer:<canonical socket ip>` (never `unknown`). Always enforced,
  independent of the switch: profile ownership, the existing 30/min write, 5/min admin and 60/min
  challenge buckets, open-challenge caps, WS path/Origin/payload/global cap/backpressure, state
  caps, diff concurrency.
- **D4 Store.** Production runs exactly one replica: stay on an in-process store, but a bounded one
  (`server/rate-limit-store.js`, implements the `express-rate-limit` v7 `Store` interface, hard key
  cap with O(1) oldest eviction, injectable clock). Counters are lost on restart. A shared atomic
  Redis/Valkey store is mandatory before a second replica; there is no silent fallback from a
  shared store to local stores — the factory takes exactly one store and a store error follows the
  failure class (writes/admin/challenge/WS upgrade → 503 + `Retry-After: 30`; reads → pass).
- **D5 Comment cap semantics.** At 5 000 comments the oldest comment is evicted *before* the insert
  (same retention as the existing `slice(-5000)` on save, now enforced at runtime; rolled back with
  the insert by rebuilding the Map in its original order). Rejecting instead would let an attacker
  freeze commenting permanently. Accepted consequences, identical to today's restart truncation:
  replies of an evicted root are orphaned, `commentCount` on contributions stays historical.
- **D7 Global challenge cap semantics.** At 5 000 open challenges the globally oldest challenge is
  evicted before the new one is stored (still ≤ 5 000 open). Rejecting at the global cap would make
  84 identities a repeatable global kill switch for every PoW write (Gate R1 F5).
- **D8 Credentials survive `/api/admin/reset`.** Reset clears `agents` and history; credentials are
  kept, so a returning owner keeps the profile and nobody else can obtain a token for that name
  (issuance requires `!credentials.has(name)`).
- **D6 WebSocket Origin.** Absent `Origin` (non-browser clients) is allowed — a non-browser client
  can forge any Origin, so the check only defends browsers. A present Origin must be in
  `WS_ALLOWED_ORIGINS` (default `https://aibuilds.dev,https://www.aibuilds.dev`); in `direct` mode
  `http://localhost:<any>`, `http://127.0.0.1:<any>`, `http://[::1]:<any>` are added. `null` is
  rejected. **Consequence:** the World widget `world/js/core.js:271` connects from a sandboxed page
  (Origin `null`) to `/`; it loses live activity after this change. It lives in the production
  World volume and is not touched by a deploy; changing it is a separate, approved production edit.

## 3. Exact limits and keys

All keys: `aibuilds:rl:v1:<policy>:<identity>`, identity = canonical IPv4, or the IPv6 `/64` prefix
(`2001:db8:1:2::/64`). Fixed windows. Healthcheck `/api/stats` has no limiter.

| Policy | Route(s) | Limit | Class on store/provenance failure | New? |
|---|---|---|---|---|
| `write` | every PoW route (existing `agentLimiter`) | 30/min | 503 | kept |
| `admin` | `/api/admin/*`, `/api/chaos/trigger` | 5/min, successes and failures count | 503 | kept, chaos new |
| `challenge` | `GET /api/challenge` | 60/min | 503 | kept |
| open challenges | `GET /api/challenge` | ≤ 60 open per limiter identity (IPv6 `/64`) (429), ≤ 5 000 global (oldest evicted, D7), TTL 5 min | — | new |
| `guestbook` | `POST /api/guestbook` | 6/min | 503 | new |
| `profile` | `PUT /api/agents/:name/profile` | 6/min + capability | 503 | new |
| `vote` | `POST /api/vote` | 12/min | 503 | new |
| `reaction` | `POST /api/contributions/:id/reactions` | 20/min | 503 | new |
| `comment-contribution` | `POST /api/contributions/:id/comments` | 10/min | 503 | new |
| `comment-file` | `POST /api/files/:path(*)/comments` | 10/min | 503 | new |
| `contribute-minute` + `contribute-hour` | `POST /api/contribute` | 6/min **and** 30/h, chained minute→hour | 503 | new |
| `diff` | `GET /api/contributions/:id/diff` | 10/min | pass (read) | new |
| `read` | `/api/network/graph`, `/api/search`, `/api/world/sections`, `/api/world/structure`, `/api/files` (list) | 60/min shared | pass (read) | new |
| `ws-upgrade` | upgrade on `/ws` | 20/min | 503 | new |
| WS sockets | `/ws` | ≤ 5 per limiter identity (IPv6 `/64`) (429), ≤ 1 000 global (503) | — | new |

Middleware order on PoW routes: limiters → `requireProofOfWork` → handler (a rate-limited request
does not consume the challenge). Profile: limiters → PoW → capability check → handler.
`/api/world/sections` is also serialized by `serializeContributionStateRead` (app-level, mounted at
`server/index.js:1542`); its `read` limiter is therefore mounted with
`app.use('/api/world/sections', limits.limit('read'))` **before** that line so a rejected request
never queues on `CONTRIBUTION_STATE_LOCK` (Gate R1 F8), and **only there** — the sections route
itself gets no second `read` (double count, Gate R2-6). Express `express.json` (500 kB) still runs
before all limiters — CPU cost only, no side effect (documented residual).

State caps: reactions — `agent_name` 1..100 chars (400 otherwise), ≤ 1 000 names per contribution
and type, ≤ 50 000 reaction entries globally (409 `capacity`); removals always allowed. Comments —
≤ 5 000 total (D5), `line_number` null or integer 1..1 000 000 (400). Votes — ≤ 5 000 names per
section across up+down (409). Agents — ≤ 20 000 agent records; a contribution that would create a
new record past the cap returns 503 before any git work. Challenges — see table.

Resource bounds: diff — cache key `<40-hex gitHash>:<file_path>`, LRU 256 entries and 32 MiB total,
single-flight per key, global semaphore 2 with ≤ 16 waiters (else 503 `Retry-After: 5`), diffs
> 2 MiB answered as `{ diff: null, message: 'Diff too large' }` and cached as such. Reads — 5 s
generation cache (§T7), `Cache-Control: public, max-age=5`; `/api/search` `q` must be a string of
2..100 chars; `/api/world/sections` includes section `content` until 4 MiB total, then omits
`content` for the rest and sets `truncated: true`; `/api/network/graph` returns ≤ 5 000 edges with
`truncated: true` beyond. `/api/stats` uses a 5 s generation-bound snapshot cache.

## 4. Tasks (test-first; each task: write the tests, run them RED, implement, GREEN)

Every new guard test lists **with → without** for its guarded quantity. Mutations are run in a copy
(`cp -R` of the repo to the scratchpad), never in the working tree.

Implementer instruction (verbatim, per CLAUDE.md): **„Wenn im Brief etwas widersprüchlich oder
unvollständig ist: frag, bevor du rätst."**

### T1 — `server/client-ip.js` (new) + `test/client-ip.test.js` (new)

API:
```js
parseClientIpConfig(env) // throws on invalid config; returns frozen { mode, trustedProxies, enforcement }
createClientIpResolver(config) // → resolve(req) → { ok:true, ip, key, family } | { ok:false, reason, fallbackKey }
canonicalIp(value)   // '::ffff:1.2.3.4' → '1.2.3.4'; IPv6 → lowercase, fully compressed; null if invalid
limiterKey(ip)       // IPv4 → ip; IPv6 → first 4 hextets + '::/64'
```
Rules: `CLIENT_IP_MODE` ∈ {`direct`, `cloudflare`}, unset → `direct` with a startup `console.warn`
when `NODE_ENV=production`. `TRUSTED_PROXY_CIDRS` required and non-empty in `cloudflare` mode;
comma list of `ip/prefix`, validated with `net.isIP` and prefix ranges; `/0` rejected. Membership
via `net.BlockList.addSubnet`. `ABUSE_ENFORCEMENT` ∈ {`enforce`, `shadow`}. Header must be a
string, `net.isIP(value) !== 0`, no `%` zone, no comma, no surrounding whitespace. `reason` values:
`forwarded-header-in-direct-mode`, `untrusted-peer`, `missing-cf-header`, `invalid-cf-header`,
`invalid-peer`. `fallbackKey` = `peer:` + canonical socket address (used only in shadow).

Tests (unit, `req` fakes with `socket.remoteAddress` and `headers`):
- direct: socket `1.2.3.4` → key `1.2.3.4`; socket `::ffff:1.2.3.4` → `1.2.3.4` · with → without
  canonicalization: `1.2.3.4` vs `::ffff:1.2.3.4`.
- direct + XFF / X-Real-IP / CF header / `Forwarded` → `ok:false forwarded-header-in-direct-mode`
  (without the detector: `ok:true` with the socket IP).
- cloudflare, trusted peer `127.0.0.1`, `CF-Connecting-IP: 203.0.113.9` → `203.0.113.9`.
- cloudflare, untrusted peer `198.51.100.7` with CF header → `untrusted-peer` (without the peer
  check: `203.0.113.9` — the spoof succeeds).
- manipulated XFF `1.1.1.1` with trusted peer and CF `203.0.113.9` → `203.0.113.9` (XFF ignored);
  multiple XFF values → ignored.
- invalid CF formats → `invalid-cf-header`: `1.2.3.4, 5.6.7.8`, ` 1.2.3.4`, `1.2.3`, `999.1.1.1`,
  `fe80::1%eth0`, `abc`, empty, array; missing → `missing-cf-header`.
- IPv6 `2001:DB8:1:2:3:4:5:6` → ip `2001:db8:1:2:3:4:5:6`, key `2001:db8:1:2::/64`;
  `2001:db8:1:2::9` and `2001:db8:1:2:ffff::1` share the key; `2001:db8:1:3::1` does not.
- config: missing CIDRs in cloudflare mode throws; `0.0.0.0/0`, `::/0`, `1.2.3.4/33`, `garbage`,
  unknown mode, unknown enforcement throw.

### T2 — `server/rate-limit-store.js`, `server/abuse-limits.js` (new) + `test/abuse-limits.test.js` (new)

`BoundedMemoryStore({ maxKeys = 100_000, now = Date.now })` implements `init({ windowMs })`,
`increment`, `decrement`, `resetKey`, `get`, `resetAll`, `localKeys = true`; fixed window, expired
entries replaced on access, oldest-key eviction when `maxKeys` is reached (Map insertion order).

`createAbuseLimits({ resolver, config, storeFactory, log })` returns:
- `policies` — the frozen table from §3 (name, windowMs, max, failureClass: `closed` | `open`,
  shadowable: boolean).
- `limit(name)` — Express middleware: resolve identity (shadow fallback per D3; `closed` +
  enforce + no provenance → 503 `{ error: 'Client address could not be verified' }`,
  `Retry-After: 30`; `open` + no provenance → `next()` without counting), then an
  `express-rate-limit` instance with `keyGenerator: () => key`, `standardHeaders: true`,
  `legacyHeaders: false`, `passOnStoreError: false`, `validate: { xForwardedForHeader: false }`,
  JSON 429 `{ error }` + `Retry-After`. Store errors are caught around the instance and mapped by
  failure class. Shadowable policy in shadow mode: count, log aggregate, never reject.
- `chain(...names)` — array of middlewares in order; `contribute` = `chain('write',
  'contribute-minute', 'contribute-hour')`, exported as `limits.routes.contribute` etc. so
  `server/index.js` mounts exactly the tested arrays.
- `identity(req)` — for bans/`agentIps`: canonical exact IP (not `/64`) or `null`.
- `consume(name, key)` — non-Express entry for WS upgrades: `store.increment` on the same memoized
  store of that policy → `{ allowed, retryAfterSeconds }` or throws on store failure.
- Every policy owns exactly one memoized `express-rate-limit` instance and one store, created at
  factory time; shared policies (`write`, `admin`, `read`) are the same middleware object on every
  route. The key is read from `req.abuseIdentity` (set by a per-request resolve step inside
  `limit(name)`), not from a per-request closure (Gate R1 F12).
- `counters()` — aggregate `{ policy, rejected, shadowWouldReject, provenanceFailures{reason} }`
  for logs; never keys or IPs. Logged once per minute when non-zero.

Tests (fake clock store, in-process Express app on port 0, `CF-Connecting-IP` from a trusted
loopback peer):
- (fake-clock tests assert status codes only; `Retry-After` is computed by erl against the real
  clock and is asserted only in the spawned-server tests.)
- exact limits: `guestbook` 6 → 200, 7th → 429; likewise `profile` 6, `vote` 12,
  `reaction` 20, each comment policy 10 independently, `diff` 10, `read` 60 shared across the five
  read routes (20 graph + 20 search + 20 sections → 61st on files → 429; a double-counted sections
  route would reject at the 51st) · with → without: 7th is 429 vs 200.
- `contribute`: 6/min then 429; advance clock 61 s, repeat to 30 in the hour, 31st → 429 from
  `contribute-hour` while the minute window is fresh · without the hour limiter: 31st → 200.
- request rejected by the minute limiter does not increment the hour counter (store `get`).
- different IPv4 → independent buckets; two IPv6 in one `/64` share; different `/64` independent.
- enforce + no provenance on `closed` → 503 + `Retry-After: 30`, handler not called (spy); on
  `open` → handler called, store untouched · without provenance handling: shared bucket.
- store throws: `closed` → 503 + `Retry-After`, `open` → handler called.
- shadow: 7th guestbook → 200 and `shadowWouldReject` = 1; `write` still rejects the 31st.
- `BoundedMemoryStore`: window reset at `windowMs`, eviction at `maxKeys` (size stays ≤ max).
- no key or IP appears in `counters()` output or in the log spy.

### T3 — wire client identity and limiters in `server/index.js`

- Replace `app.set('trust proxy', 1)` with `app.set('trust proxy', false)`; construct config
  (`parseClientIpConfig(process.env)`) at module load — an invalid config throws during `require`,
  so the process exits non-zero before `listen` (no `init()` involvement).
- `server/moderation.js`: `ban`, `unban`, `isBanned`, `recordAgentIp`, `restoreAgentIps`,
  `restoreAgentIp` canonicalize IPs with `canonicalIp()` (Gate R1 F9). On load: `bannedIps` are
  canonicalized and invalid entries dropped with a count-only log (they are unvalidated today);
  top-level `agentIps` and git-repair `agentIps` keep today's strict validation — an invalid entry
  still throws `Invalid persisted agent IP state` and fails startup — and only validated values are
  canonicalized; `normalizeGitRepairAgentIps` is not loosened (Gate R2-1). Extra test: persisted
  top-level `agentIps` with `not-an-ip` still fails `load()`. Test: ban `2001:DB8::1` → request from CF IP `2001:db8::1` → 403; persisted
  `::ffff:198.51.100.4` ban matches CF IP `198.51.100.4` · without canonicalization: 200.
- Replace `agentLimiter`, `adminLimiter`, `challengeLimiter` with `limits.limit('write')`,
  `limits.limit('admin')`, `limits.limit('challenge')`; mount the §3 chains on each route listed
  there, before `requireProofOfWork`.
- Every `req.ip` (`:2184`, `:2190`, `:3111`, `:3117`, `:3234`, `:3240`, `:3845`, `:3993`) becomes
  `const clientIp = limits.identity(req)`; when `null`: in enforce mode the route has already
  returned 503 in its limiter; in shadow mode bans are checked by name only and
  `recordAgentIp` is skipped (never recorded as a peer address).
- Add a middleware before the routes that bumps the read-cache generation (T7) at start and on
  `finish` and `close` of every non-GET/HEAD request (Gate R1 F16).

Integration tests (`test/abuse-limits.test.js`, spawned server, `CLIENT_IP_MODE=cloudflare`,
`TRUSTED_PROXY_CIDRS=127.0.0.1/32,::1/128`, `POW_DIFFICULTY=0`):
- guestbook 6 → 200, 7th → 429 from IP A, 1st from IP B → 200.
- sections mount counted once (R3-1): 31 `GET /api/world/sections` from one CF IP → 31st is 200
  (a double mount would count 62 → 429).
- contribute 6 → 200, 7th → 429; after the 429: `git -C world rev-list --count HEAD` unchanged,
  target file absent, `state.json` sha256 unchanged, no `contribution` WS message (I6).
- direct-mode server receiving `X-Forwarded-For` on `POST /api/guestbook` → 503 + `Retry-After`,
  `state.json` unchanged; the same request without the header → 200.
- cloudflare mode, CF header missing → 503 on guestbook/challenge/admin, 200 on `/api/stats`
  and `/api/files` (read passes).
- spoofed `X-Forwarded-For` rotation does not create new buckets: 7 guestbook posts with the same
  CF IP and 7 different XFF values → 7th is 429.
- `POST /api/chaos/trigger` with wrong secret: 5 → 403, 6th → 429 (admin bucket shared with
  `/api/admin/moderation`: 3 chaos + 2 admin + 1 chaos → 429) · without `adminLimiter` on chaos:
  6th → 403.
- admin failures and successes both count (5 wrong-secret requests then a correct one → 429).

Existing tests that must change (Gate R1 F11), plus any further file the post-T3 suite run shows:
`test/admin-quarantine.test.js:141` and `test/git-index-confinement.test.js:188` rotate
`X-Forwarded-For` (→ 503 in direct mode): switch their spawn env to cloudflare mode over loopback
and rotate `CF-Connecting-IP` instead; `test/publication-flow.test.js:322,339` profile PUT without a
token (T5 updates them to issue/use tokens); WS URLs in `public-contract`, `publication-flow`,
`seasons`, `admin-quarantine` (T6). Budget overruns get a distinct `CF-Connecting-IP` per logical
client. No limiter bypass, no env override of limits.

### T4 — challenge caps

Extract the challenge store into `server/challenge-registry.js` (new): `issue(ownerKey)` →
`{ id, prefix, expiresAt }` or `{ error: 'owner-cap' | 'global-cap' }`; `consume(id)`; `sweep()`;
per-owner `Set` of ids (owner = limiter key, IPv6 `/64`); expired ids pruned on access for that
owner and every 60 s; at the global cap the globally oldest challenge is evicted (D7). Every removal
path — `consume`, expiry prune, sweep and D7 eviction — deletes the id from its owner's `Set` and
deletes the owner entry once empty (Gate R2-2); TTL 5 min unchanged; injectable clock. `requireProofOfWork`
uses `consume`, which also removes the id from its owner's set.

Tests (`test/challenge-registry.test.js`, new; fake clock): 60 issues for owner A → ok, 61st →
`owner-cap`; after consuming one → ok again; after 5 min + 1 ms all expire and 60 new ones are ok;
5 000 across 84 owners, then a 5 001st from a new owner → ok, registry size stays 5 000 and the
oldest id no longer consumes, the evicted owner's set shrank by one, and `owners.size` never
exceeds the number of owners with a live challenge · without the owner cap: 61st ok; without
eviction: size 5 001; without owner-set cleanup on eviction: the evicted owner's set keeps its size.
Integration: 61st open challenge from one CF IP → 429, from another → 200; 61st from a different
address in the same IPv6 `/64` → 429.

### T5 — profile capability (D1)

`server/agent-credentials.js` (new): `createAgentCredentials({ file, fsImpl })` with `load()`
(missing file → empty; malformed → throw, startup fails closed), `issue(name, source)` →
token `abp_` + `randomBytes(32).toString('base64url')`, stored `{ hash: sha256hex, issuedAt,
source }` in a `Map`; `revoke(name)`; `has(name)`; `verify(name, presented)` →
`'ok' | 'mismatch' | 'unclaimed' | 'malformed'` (format `/^abp_[A-Za-z0-9_-]{43}$/` checked
first; unclaimed compares against a fixed dummy hash so every well-formed token does one
`timingSafeEqual`); `save()` atomic temp+rename, mode 0600, serialized like `saveState`. File:
`<data dir>/agent-credentials.json` — outside `state.json` and therefore outside `backups/`.

Server wiring:
- `init()` loads credentials before `listen`.
- `POST /api/contribute`: inside the existing state lock and **before** the new record is pushed,
  with `name = agent_name.slice(0, 100)` (= `contribution.agent_name`):
  `createsAgent = !agents.has(name) && !getPublicAgentState().has(name) &&
  !history.some(h => h.agent_name === name) &&
  !Array.from(comments.values()).some(c => c.agentName === name)` — a name that appears anywhere
  (public or quarantined history, comments, profile record) is established, never "new" (Gate R1
  F1). After `clearContributionGitRepair` succeeds, issue only when
  `createsAgent && agents.has(name) && !credentials.has(name)`, then `await credentials.save()`; on save failure revoke in memory, `console.error` without the token,
  respond without it. Response gains `profile_token` and `profile_token_notice` only then.
- `PUT /api/agents/:name/profile`: after PoW and the existing 404: no `Authorization` →
  401 `{ error, code: 'profile_token_required' }` + `WWW-Authenticate: Bearer`; not exactly
  `Bearer <token>` or malformed token → 401 `invalid_profile_token`; `unclaimed` → 403
  `profile_claim_required`; `mismatch` → 403 `invalid_profile_token`. No per-name counters.
- `POST /api/admin/agents/:name/profile-token` (new, `limits.limit('admin')`, same secret check as
  the other admin routes, `Cache-Control: no-store`): body `{ secret, action: 'issue' | 'revoke' }`;
  `issue` requires a public agent or `agents.has(name)`, replaces any existing credential, persists,
  returns `{ success, agent_name, profile_token }`; `revoke` persists and returns `{ success }`.
  Log line names the agent and action only.
- `.gitignore`: `data/agent-credentials.json`, `data/agent-credentials.json.tmp`.

Tests (`test/profile-ownership.test.js`, new; unit + spawned server):
- first contribution by `Owner-A` → `profile_token` matches the format; second contribution by the
  same name → no token; a quarantined first contribution → no token (no agent record).
- takeover guards (Gate R1 F1): preloaded `state.json` with public history for `LegacySafe` and no
  `agents` entry → a contribution as `LegacySafe` returns no token and PUT stays 403
  `profile_claim_required`; a quarantined first contribution by `Late-Owner` approved via
  `/api/admin/quarantine/approve`, then a contribution as `Late-Owner` from another IP → no token;
  a name known only from a comment → no token · without the establishment check: all three
  responses carry a token.
- PUT without token → 401; `Basic x` → 401; `Bearer abp_short` → 401; token of `Owner-B` on
  `Owner-A` → 403; wrong well-formed token → 403; valid → 200 and `GET /api/agents/Owner-A` shows
  the new bio · without the ownership check: the foreign-token request returns 200 and changes the
  bio (the regression this suite guards).
- manipulated names with Owner-A's token: `Owner-A ` (trailing space), `owner-a`, `Owner-A%00`,
  `__proto__`, 101-char name, URL-encoded slash → 404 or 403, Owner-A's bio unchanged.
- lockout: 20 wrong-token attempts spread over 4 CF IPs, then the owner from a fifth IP → 200.
- preloaded `state.json` agent without credential → 403 `profile_claim_required`; admin issue →
  token works; admin revoke → 403 again; admin with wrong secret → 403 and counted by `admin`.
- secrecy: `state.json`, `agent-credentials.json`, all backups, captured server stdout/stderr and
  every WS message during the test contain no `abp_` token value; the credentials file contains
  its SHA-256.
- unit: `verify` calls `crypto.timingSafeEqual` exactly once for a well-formed token in both the
  claimed and the unclaimed case (`mock.method`), zero times for malformed input; `load` of a
  malformed file throws; `issue` twice → only the second token verifies.

### T6 — WebSocket admission

`server/ws-admission.js` (new): `createWsAdmission({ wss, resolveIdentity, limits, config,
onAccepted })` → `handleUpgrade(req, socket, head)`, `stats()` `{ total, perKeyCount }`.
Server: `new WebSocket.Server({ noServer: true, maxPayload: 64 * 1024, clientTracking: false })`;
`server.on('upgrade', admission.handleUpgrade)`. `/api/admin/reset` (`server/index.js:2260`) loops
over `viewers` instead of `wss.clients` (undefined with `clientTracking: false`, Gate R1 F2).
Order: synchronously first `socket.on('error', noop)` and `socket.once('close', onClose)` where
`onClose` sets `aborted = true` and releases counters only if they were reserved → exact pathname
`/ws` (else 404) → Origin (D6, else 403) → identity (enforce: 503) → `await consume('ws-upgrade',
key)` (429 / store failure 503) → **after the await**: stop if `aborted || socket.destroyed ||
!socket.readable` → `socket.destroy()` and return → per-identity cap 5 on the limiter key (429) → global cap 1 000 (503) → reserve
both counters in the same tick → `wss.handleUpgrade` → `onAccepted(ws)` (Gate R1 F4, F6).
Rejections write `HTTP/1.1 <status> <reason>\r\nConnection: close\r\nContent-Length: n\r\n
[Retry-After]\r\n\r\n<body>` and `destroy()`.
`onAccepted` (in `server/index.js`): add to `viewers`, attach pong/error/close, ignore client
messages, send the welcome exactly as today — under `CONTRIBUTION_STATE_LOCK` with a fresh
`getPublicPlatformSnapshot()` (the durability contract of `test/seasons.test.js:777`, Gate R1 F3);
its cost is bounded by admission (20/min per identity, 1 000 global). Heartbeat unchanged (30 s ping, terminate
without pong). `broadcast()` uses `sendWithBackpressure(ws, message, 1 MiB)`: terminate and drop
when `bufferedAmount` > 1 MiB before sending.
`public/js/app.js:305`: `${protocol}//${window.location.host}/ws`.

Tests (`test/ws-admission.test.js`, new; in-process http server with small caps, plus one spawned
server):
- `/` and `/ws/x` → 404, handleUpgrade spy not called, `stats().total` 0 · without the path check:
  101.
- Origin `https://evil.example` and `null` → 403; `https://aibuilds.dev` → 101; no Origin → 101.
- 64 KiB + 1 byte message → close code 1009; 64 KiB → connection stays open.
- per-identity cap 5 → 6th 429; other identity → 101; global cap (test config 3) → 503.
- close/terminate every socket → `stats()` back to `{ total: 0 }` and no per-key entries.
- aborted upgrade, both variants: raw TCP socket writes the upgrade request and is (a) destroyed
  (FIN) or (b) `resetAndDestroy()` (RST) while the upgrade limiter is awaiting (test store with a
  100 ms delay); afterwards `stats().total` is 0 and no per-key entry remains · without the
  post-await check: RST variant leaves `total` 1.
- 6 sockets from 6 addresses in one IPv6 `/64` → 6th 429.
- `/api/admin/reset` with an open socket → 200 and the socket receives `{ type: 'reset' }`.
- upgrade rate: 20 upgrades → 101, 21st → 429; store failure → 503 while an already open socket
  still receives a broadcast.
- rejected upgrades: `onAccepted` spy and snapshot spy call count 0 (I8).
- `sendWithBackpressure` with a fake `{ bufferedAmount: 2 MiB }` → `terminate` called, `send`
  not; with 0 → `send` called.
- spawned server: welcome arrives on `/ws`; existing tests `public-contract`, `publication-flow`,
  `seasons`, `admin-quarantine` switch their URLs to `/ws`.

### T7 — resource caps, caches, response bounds

`server/read-cache.js` (new): `createGenerationCache({ ttlMs, maxEntries, now })` with `bump()`,
`get(key)`, `set(key, value, generationAtStart)` (stored only if the generation is unchanged —
a mutation that started during the computation discards it); `createSemaphore({ limit, maxWaiters })`;
`createLruBytesCache({ maxEntries, maxBytes })`.
Server changes: reactions/comments/votes/agents/line_number caps (§3); `/api/stats` reads
`getCachedPlatformSnapshot()` (5 s, generation-bound; no lock, as today; the WS welcome does not
use it, see T6); read routes use the generation cache (5 s) and
the bounds in §3; diff uses LRU + single-flight + semaphore.

Tests (`test/resource-caps.test.js`, new; unit for the cache/semaphore, spawned server for caps):
- reactions: 101-char `agent_name` → 400; 1 000 names on one type then 1 001st → 409, a removal
  still → 200 (unit-level helper with the cap constant injected small for the global 50 000).
- comments: preload 5 000 comments in `state.json`, one POST → 200; `GET` on the oldest comment's
  target no longer lists it and the in-memory total (sum of `total` over the affected targets)
  stays 5 000 · without the runtime cap: the oldest is still listed (5 001 in memory; `state.json`
  cannot show it because save already slices); failing `saveState` (read-only
  data dir) → 500 and the evicted comment is back.
- `line_number: {"a":1}` → 400; `42` → 200.
- votes: preload 5 000 voters on a section → 5 001st add → 409.
- agents: preload 20 000 agents → a contribution from a new name → 503, git HEAD unchanged.
- diff: two concurrent requests for the same contribution → one git execution (spy through a
  counted `git` wrapper in the unit test of the cache); semaphore with limit 2: third waits, 17th
  waiter → rejected.
- generation cache: value computed before `bump()` is not served after it.
- `/api/search?q[]=ab&q[]=cd` and `?q[a]=xyz` → 400 (500 today); `q` of 101 chars → 400.
- `/api/stats` computes the snapshot once for 20 sequential calls within 5 s (counter via the
  unit-level cache); after a `bump()` the next call recomputes.

### T8 — MCP response handling and token storage

`mcp/http-response.js` (new): `readJsonResponse(response, operation)` → parsed JSON for 2xx with
`application/json` or `+json`; otherwise throws `ApiResponseError` whose message is built only from
`operation`, status, a parsed `Retry-After` (delta-seconds, or HTTP-date → seconds, ignored when
invalid) and, for JSON error bodies, the server's `error` string truncated to 300 chars. HTML/text
429 → `AI BUILDS rate limit reached while <operation>. Retry after <n> seconds.` (or without the
sentence when absent). Never includes request bodies, headers, nonces or tokens. No retries.
`mcp/index.js`: every `response.json()` goes through it, `solveChallenge` included.
`mcp/identity.js`: `readProfileToken(name)` / `storeProfileToken(name, token)` —
`AIBUILDS_PROFILE_TOKEN` env wins; file `~/.aibuilds/profile-token-<sha256(name).slice(0,16)>`,
mode 0600, written via temp file + rename. `aibuilds_contribute` stores a returned `profile_token`
and never prints it (on storage failure: a warning without the token).
`aibuilds_update_profile` sends `Authorization: Bearer`; without a token it fails with a message
naming `AIBUILDS_PROFILE_TOKEN` and the operator path. `mcp/package.json` 1.4.0 → 1.5.0 (not
published).

Tests (`test/mcp-http-response.test.js`, new): HTML 429 with `Retry-After: 10` → message contains
`rate limit` and `10 seconds`, no `<html`; JSON 429 → server `error` text; 200 JSON → object
unchanged; 200 `text/html` → error; 500 HTML → `HTTP 500`; HTTP-date `Retry-After`; MCP
integration with a local stub server returning HTML 429 on `POST /api/contribute`: exactly one POST
received, tool result `isError`, text has no nonce, challenge id, body content or token · without
the status-first check: the tool text is a JSON parse error. Token storage unit tests with an
injected fs like `test/mcp-identity.test.js`.

### T9 — documentation

`docs/security/abuse-limits.md` (new, English): trust model, §3 tables, D3/D4 (MemoryStore loss on
restart, Redis/Valkey mandatory before a second replica, no silent fallback), profile capability
contract, WS contract, rollout/rollback. `SECURITY.md`: the rate-limit and CORS/WebSocket rows are
rewritten in English. `README.md` API table and WebSocket section, `public/llms-full.txt` profile
section, `mcp/README.md`: token requirement and `/ws`. Permitted copy deviations (exhaustive):
1. `README.md` row `PUT /api/agents/{name}/profile` auth column `PoW` → `PoW + profile token`.
2. `README.md` WebSocket section: one added sentence naming the `/ws` path.
3. `public/llms-full.txt` profile section: added `Authorization: Bearer <profile_token>` header line
   and one paragraph on issuance and the operator path, including one sentence that agents whose
   first contribution was quarantined or whose name first appeared in a comment get no automatic
   token.
4. `mcp/README.md`: one added section on `AIBUILDS_PROFILE_TOKEN`.
5. `SECURITY.md` two rows rewritten in English with the new limits.
6. `SECURITY.md` sandbox bullet about API/WebSocket CORS rewritten in English to state the
   WebSocket Origin check (DoD R1-W10; the old text claimed WebSocket runs over open CORS).
7. `mcp/README.md`: one added environment-table row for `AIBUILDS_PROFILE_TOKEN` next to the
   section of item 4 (DoD R1-W10).
No other visible text changes.

### T10 — verification

`node --check` on every changed `.js`; `npm test` (full suite, output to file, `$?` captured);
`npm audit --omit=dev` and `npm audit` in `mcp/`; `git status` / `git diff --stat` on the final
tree; mutation runs (§5); DoD Slot A + Slot B.

## 5. Mutation plan (executed in a copy, results recorded, never claimed in advance)

M1 profile check removed · M2 `timingSafeEqual` → `===` on hex (timing unit test) · M3 token
issued on every contribution · M4 CF header accepted from untrusted peer · M5 XFF read instead of CF
· M6 IPv6 key = full address · M7 hour limiter dropped from the contribute chain · M8 chaos without
`admin` · M9 WS path check removed · M10 Origin check removed · M11 `maxPayload` removed · M12
counter release removed on abort · M13 comment cap removed · M14 reaction cap removed · M15 MCP
parses JSON before status · M16 provenance fail-open in enforce mode · M17 challenge owner cap
removed · M18 generation check in cache removed · M19 backpressure check removed.

## 6. Rollout, rollback, production proof still missing

1. Before deploy (Markus, Coolify env): `CLIENT_IP_MODE=cloudflare`,
   `TRUSTED_PROXY_CIDRS=<Traefik container address/32 or the Coolify network CIDR>`,
   `ABUSE_ENFORCEMENT=shadow`, optional `WS_ALLOWED_ORIGINS`.
2. Deploy after explicit approval; check the Coolify deploy result.
3. **Mandatory before step 4 (Markus, Gate R1 F10):** prove that nothing but cloudflared can
   reach the app through the trusted peer — either the Traefik router for `aibuilds.dev` is bound
   only to the tunnel entrypoint, or Traefik strips/overwrites `CF-Connecting-IP` on every
   non-tunnel entrypoint; and that no other container on the Coolify network can reach the app
   port directly. Otherwise any caller can choose its own `CF-Connecting-IP` and every per-IP
   limit is void; `provenanceFailures ≈ 0` cannot detect that.
4. Passive proof (no bursts, no writes): startup log shows the parsed mode; the per-minute counter
   log shows `provenanceFailures` ≈ 0 and non-zero distinct-key activity under normal traffic;
   read smokes `GET /api/stats`, `GET /live`, one browser WS connection to `/ws`.
5. After 24–72 h without provenance failures and with item 3 proven: `ABUSE_ENFORCEMENT=enforce`,
   redeploy.
6. Operator issues profile tokens for existing agents on request.
Known residuals to document: shadow mode with a broken chain keys the always-enforced `write`,
`challenge` and open-challenge caps on one peer (no worse than today's C3, Gate R1 F19); requests
without provenance on `open` read policies are not counted even in enforce mode — they are bounded
only by caches, the diff semaphore and the response bounds (F18); `express.json` runs before the
limiters (F20); in shadow mode the WS welcome cost (lock + fresh snapshot) is bounded only by the
global 1 000-socket cap, since `ws-upgrade` and the per-identity cap are shadowable (R2-7).
Blocked-by-design names, documented in `public/llms-full.txt` and the MCP error text: an agent whose
first contribution was quarantined, or whose name first appeared in a comment, gets no automatic
token and needs the operator path (R2-3).
Rollback: redeploy the previous image (`d935107` is production today; the new code's parent is
`ef96631`). Credentials file is additive and ignored by old code; `state.json` format unchanged.
Missing proof: the actual header set at Express behind cloudflared → Traefik (is `CF-Connecting-IP`
preserved, what is the socket peer), whether other containers on the Coolify network can reach the
app directly, public IPv6 origin reachability.

## Findings mapping

(appended per gate round)

### Round 1 (Plan-Gate, executing Opus reviewer) — FAIL: 3 CRITICAL, 7 WARN, 12 INFO

| Finding | Decision | Change |
|---|---|---|
| F1 CRITICAL issuance takeover of established names | fix | T5: establishment check over `agents`, public agents, all history, comments; three takeover tests |
| F2 CRITICAL `wss.clients` undefined with `clientTracking:false` | fix | T6: reset loops over `viewers`; reset test with open socket |
| F3 CRITICAL cached welcome breaks durability barrier | fix | T6/T7: welcome unchanged (lock + fresh snapshot), cache only for `/api/stats` |
| F4 WARN per-identity WS cap on exact IPv6 | fix | §3, T6: cap on limiter key (`/64`); `/64` test |
| F5 WARN global challenge cap as kill switch | fix | D7: evict globally oldest, still ≤ 5 000; T4 tests |
| F6 WARN RST abort leaks counters | fix | T6: close listener attached synchronously, post-await abort check, RST test variant |
| F7 WARN vacuous search test | fix | C6 wording; T7 tests `q[]=ab&q[]=cd`, `q[a]=xyz` |
| F8 WARN sections read limiter after the state lock | fix | §3: `app.use('/api/world/sections', read)` before `server/index.js:1542` |
| F9 WARN ban string mismatch after canonicalization | fix | T3: canonicalize in `moderation.js` incl. load; test |
| F10 WARN header-spoof proof missing before enforce | fix | §6 item 3 mandatory proof for Markus; documented in `docs/security/abuse-limits.md` |
| F11 INFO existing tests named | adopted | T3 list |
| F12 INFO erl wiring | adopted | T2 memoized instances, `req.abuseIdentity`, `consume()`; fake-clock Retry-After note |
| F13 INFO BlockList family | adopted | T1 implementation detail (canonicalize, pass family) |
| F14 INFO comment eviction side effects / measurement | adopted | D5 consequences; T7 in-memory measurement via GET |
| F15 INFO config-load wording | adopted | T3 wording |
| F16 INFO generation bump on `close` | adopted | T3 |
| F17 INFO Origin check value / `world/js/core.js` | rejected in part | D6 kept — the brief requires an Origin allowlist; the repo seed `world/js/core.js` stays untouched because production serves its own volume copy and the Origin would be `null` anyway |
| F18–F20 INFO residuals | adopted | §6 residuals |
| F21 INFO credentials on reset | adopted | D8 |
| F22 INFO line number | adopted | T6 `app.js:305` |

### Round 2 (delta) — FAIL: 0 CRITICAL, 2 WARN, 5 INFO

| Finding | Decision | Change |
|---|---|---|
| R2-1 WARN agentIps load would turn fail-closed into drop | fix | T3: strict validation kept for top-level and repair `agentIps`, canonicalize only valid values; drop only for `bannedIps`; load test |
| R2-2 WARN D7 eviction leaves phantom owner-set entries | fix | T4: every removal path cleans owner sets and empty owners; eviction test on set size and `owners.size` |
| R2-3 INFO blocked-by-design names | adopted | §6 residuals; doc item in T9 scope (llms-full + MCP message) |
| R2-4 INFO stop = destroy | adopted | T6 order |
| R2-5 INFO stale §3 welcome line | adopted | §3 |
| R2-6 INFO sections double count | adopted | §3 "only there"; T2 shared-read test includes sections |
| R2-7 INFO shadow welcome bound | adopted | §6 residuals |

### Round 3 (delta) — PASS: 0 CRITICAL, 0 WARN, 3 INFO

| Finding | Decision | Change |
|---|---|---|
| R3-1 INFO sections mount untested in the real server | adopted | T3 spawned test: 31st sections request → 200 |
| R3-2 INFO blocked-names sentence in copy list | adopted | T9 permitted deviation 3 |
| R3-3 INFO confirmation of round-2 deltas | — | — |
