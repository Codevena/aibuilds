# Review record — abuse, authorization and resource hardening (2026-09-23/24)

Plan: `docs/superpowers/plans/2026-09-23-abuse-authz-hardening.md` (plan gate: 3 rounds, executing
Opus reviewer, round 3 PASS). Contract: `docs/security/abuse-limits.md`.

Definition of Done: Slot A = executing Claude Opus subagent (Codex at quota until 2026-09-26);
Slot B = reading Claude Opus subagent (GLM not used: the ~445 KB payload is far beyond the size at
which glm-5.3 reliably returns content, and Ollama was failing/capped). Four finding rounds, the
third reached the round limit; the remaining round-3 WARN was fixed under the owner's standing
instruction ("follow your professional recommendation") and verified in two further passes.
Findings → decisions per round: `.review/rounds.md` content is reproduced at the end.

Final static gates: `node --check` on every changed file; `npm test` 410 pass / 0 fail, rc=0.
Tree binding: payload rebuilt from the final tree matches the reviewed payload (this file is the
only excluded path, listed in the payload header).

## Verdicts

| Round | Slot A | Slot B |
|---|---|---|
| r1 | VERDICT: FAIL | VERDICT: FAIL |
| r2 | VERDICT: FAIL | VERDICT: FAIL |
| r3 | VERDICT: FAIL | VERDICT: PASS |
| r4-verify | VERDICT: FAIL | VERDICT: PASS |
| r5-final (verification of the hook-loop fix) | VERDICT: PASS | — (fix proposed and measured by Slot A itself) |

## Slot A — r1

### FINDINGS
- [CRITICAL] D3 shadow switch is not implemented for the always-enforced policies: under `ABUSE_ENFORCEMENT=shadow`, a request without verified provenance hits `write`/`admin`/`challenge` (shadowable:false) → `effectiveEnforcement='enforce'` → 503 (server/abuse-limits.js:167-179). Every PoW route starts with `write`, so with a broken header chain (the exact case shadow exists for, plan §6 step 1) ALL writes and `/api/challenge` return 503 — a production write outage. Plan D3 says the provenance 503 is shadowable and a request without provenance is keyed `peer:<socket ip>`; plan §6 / docs/security/abuse-limits.md F19 residual says shadow "keys the always-enforced write, challenge and open-challenge caps on one shared peer identity" — the code contradicts both, and the comment on `requireProofOfWork` (server/index.js ~173) documents the wrong behaviour. Minimal fix: in `limit()`, decide the provenance branch on `config.enforcement` (global switch), not on `effectiveEnforcement`: if `config.enforcement==='shadow' && ident.key` fall through and count against the fallback key for every policy (non-shadowable policies still reject at their max via erl); keep `effectiveEnforcement` only for the erl handler / store-error branch. Add a spawned-server test: shadow + cloudflare + no CF header → challenge 200, guestbook 200, 31st write 429.
- [WARN] Diff cache stores transient failures permanently: `computeContributionDiff` returns `{diff:null, message:'Failed to get diff: …'}` from its catch and the route caches it in the 256-entry LRU (server/index.js diff route). Measured: git objects dir made unreadable → failure; restored → the same failure is still served. Minimal fix: signal failure (throw or a `cacheable:false` flag) from the catch branch and skip `diffCache.set` for it.
- [WARN] `app.use('/api/world/sections', limits.limit('read'))` prefix-matches, so `GET /api/world/sections/<file>.html` (served by `/api/world/*`; the MCP `aibuilds_read_file` path for section files) now consumes the shared 60/min `read` budget and gets 429 on the 61st request — a route not listed in §3. Measured: 61× `/api/world/sections/hero.html` → 60×200, 1×429. Minimal fix: mount path-exact, e.g. `app.get('/api/world/sections', limits.limit('read'))` before `serializeContributionStateRead` (a route-level middleware that calls next()), or guard `req.path === '/'`.
- [WARN] Startup never logs the parsed client-IP mode/enforcement and never emits the T1 production warning: `parseClientIpConfig` computes `productionWarning`, but nothing in server/index.js reads it or logs `mode`. Plan T1 ("unset → direct with a startup console.warn when NODE_ENV=production") and §6 step 4 ("startup log shows the parsed mode") are the passive rollout proof. Measured: `NODE_ENV=production` without `CLIENT_IP_MODE` → no line mentioning mode/enforcement. Minimal fix: after parsing, `console.warn` when `productionWarning`, and log `mode`, `enforcement`, number of trusted CIDRs at startup (no addresses needed).
- [WARN] The D5 rollback test is vacuous: `test/resource-caps.test.js:219` makes the data dir read-only, but the request then fails in `recordAgentIpDurably` ("Failed to persist comment moderation state") BEFORE `insertCommentWithCap` runs, so the eviction rollback is never exercised. Mutation replacing `restoreCommentsOrder(...)` with `comments.delete(comment.id)` stays GREEN on both the file-comment and contribution-comment paths. Minimal fix: make only the state save fail (e.g. pre-create `state.json.tmp` as a directory, or first record the agent IP with a prior successful comment so the moderation save is a no-op, then fail state), and assert the 500 body is the comment-save error; add the same for `/api/contributions/:id/comments`.
- [WARN] Plan T3 moderation tests missing: "ban `2001:DB8::1` → request from CF `2001:db8::1` → 403; persisted `::ffff:198.51.100.4` ban matches CF `198.51.100.4`" and "persisted top-level `agentIps` with `not-an-ip` still fails `load()`" are not in the change. Mutations: `ban()` storing the raw IP → GREEN; `isBanned` without canonicalization → GREEN; removing the top-level agentIps throw → GREEN (abuse-limits, moderation, publication-flow suites). Minimal fix: add the three tests the plan names (unit in test/moderation.test.js or spawned in test/abuse-limits.test.js).
- [WARN] Server wiring of `maxPayload` is unguarded: removing `maxPayload` from `new WebSocket.Server(...)` in server/index.js stays GREEN in test/ws-admission.test.js (the 1009 test uses its own in-process wss), so the real server would silently fall back to ws's 100 MiB default (plan M11). Minimal fix: in the spawned-server WS test, send 64 KiB + 1 byte on `/ws` and assert close code 1009.
- [INFO] `canonicalIp` returns null for valid expanded IPv4-embedded IPv6 literals (`0:0:0:0:0:ffff:1.2.3.4` → CF header 503 `invalid-cf-header`), and `::ffff:0102:0304` is not folded to `1.2.3.4` (separate bucket/ban key). Cloudflare/Node never emit these forms; cosmetic.
- [INFO] `/api/admin/ban` with an IP-only body whose `ip` is not a valid IP now returns `success:true` and silently bans nothing (before: the string was stored, also never matching). Consider a 400.
- [INFO] Diff single-flight sits inside the semaphore: 25 concurrent diff requests over 3 keys → 18×200, 7×503, although only 3 git computations were needed. Within the plan's wording; moving single-flight outside the semaphore would avoid rejecting followers.
- [INFO] GREEN mutations with no plan-mandated test: `/api/stats` cache wiring removed, diff single-flight bypassed, generation bump on finish/close removed (F16), graph 5 000-edge truncation removed, sections 4 MiB budget removed, 2 MiB diff cap removed — all stay green (the plan only asks for unit-level cache tests here). The bounds are verified only by reading.
- [INFO] `MAX_AGENTS` comment claims the check is "under the same lock trackAgentContribution() runs in" — true (CONTRIBUTION_STATE_LOCK), fine; but the 503 carries no `Retry-After`.
- [INFO] Keys are not namespaced `aibuilds:rl:v1:<policy>:<identity>` as §3 states; each policy has its own store so there is no collision — naming deviation only (matters once a shared Redis store is introduced, D4).
- [INFO] Shadow + `invalid-peer` in ws-admission passes `key=undefined` to `consume` and `reserve` (a shared `undefined` bucket, I5) — practically unreachable (socket without remoteAddress).
- [INFO] Copy deviations beyond the exhaustive T9 list: SECURITY.md changes a third line (sandbox/CORS bullet at ~l.73), and mcp/README.md adds a table row besides the permitted section. Both factually justified; add them to the list.
- [INFO] Pre-existing, now more visible: `onWsAccepted` attaches `ws.on('close')` after the awaited welcome, so a socket closed during the welcome stays in `viewers` until the heartbeat (measured: viewerCount 28 after all probe sockets closed). Admission counters are released correctly (socket-level close listener).
- [INFO] Three orphaned `node server/index.js` processes (cwd = repo, parents `node test/profile-ownership.test.js`, started 20:40–20:52, i.e. before this review) are still running; the baseline run of that file in the copy exits cleanly (rc=0, 12 s). Not created by this reviewer; left untouched.
### EVIDENCE
- ran: shadow+cloudflare server, requests without CF-Connecting-IP → `GET /api/challenge` 503, `POST /api/guestbook` 503 (at challenge stage), `GET /api/world/sections` 200; invalid CF header → challenge 503; direct+shadow with `X-Forwarded-For` → challenge 503, guestbook 503
- ran: profile probe (cloudflare/enforce, spawned server) → first contribution Owner-A 200 with `abp_`+43 token; second contribution no token; PUT no auth 401 `profile_token_required` + `WWW-Authenticate: Bearer`; `Basic x` 401; `Bearer abp_short` 401; Owner-B token on Owner-A 403 `invalid_profile_token`; lowercase `bearer` 401; double space 401; valid 200 and bio changed; manipulated names (`Owner-A%20`, `owner-a`, `Owner-A%00`, `__proto__`, 101 chars, `%2F..`, `%2Fx`, `constructor`, `hasOwnProperty`) all 404; 20 wrong tokens over 4 IPs then owner → 200
- ran: established-name issuance → comment-only name contributes: no token; guestbook-only / reaction-only names: token (no profile existed); 150-char name → token for the 100-char stored name, PUT on the 100-char name 200
- ran: admin profile-token → wrong secret 403, unknown agent 404, bad action 400, issue 200 with `Cache-Control: no-store`, old token 403 after re-issue, new token 200, revoke → 403 `profile_claim_required`, next contribution no token; after `/api/admin/reset` Owner-B keeps credential (no new token, old token 200)
- ran: secrecy scan of the whole temp root (state.json, agent-credentials.json, moderation, world) + server stdout/stderr + all WS messages for 4 issued tokens → 0 leaks, no `abp_` in logs; credentials file mode 600, contains only names+hashes; backups contain only state copies (backupState copies DATA_FILE only)
- ran: guestbook from 7 addresses in `2001:db8:1:2::/64` → 200×6, 429; other /64 → 200; alternating `::ffff:192.0.2.5`/`192.0.2.5` → 6×200, 429; `2001:DB8:9:9::1`/`2001:db8:9:9:0:0:0:2` share bucket → 429 on 7th
- ran: CF values `1.2.3.4, 5.6.7.8`, `1.2.3`, `999.1.1.1`, `fe80::1%eth0`, `abc`, `0:0:0:0:0:ffff:1.2.3.4` → 503; `::ffff:0102:0304` → 200
- ran: rejected 7th guestbook → 429, `Retry-After: 60`, state.json sha256 unchanged
- recomputed: exact limits on the real server → vote 12 then 429 (13th); reaction 20/21st 429; comment-contribution 10/11th 429; comment-file 10/11th 429 (independent budget, same IP); profile 6/7th 429; diff 10/11th 429; read `/api/files` 60/61st 429; challenge 60/61st 429; contribute 6/7th 429; `/api/stats` 70×200 (no limiter)
- ran: `/api/search` `q[]=ab&q[]=cd` 400, `q[a]=xyz` 400, 101 chars 400, `q=ab` 200, `q=a` 400, `type[]=x` 400; `line_number` `{"a":1}` 400, 42 200, 0 400, 1000001 400, 1.5 400, `"5"` 400, null 200; reaction agent_name 101 → 400, 100 → 200
- ran: WS on real server → `/`, `/ws/`, `/ws/x`, `/wsx`, `//ws`, `/WS` 404; `/ws?x=1` 101; Origin `https://evil.example`, `null`, `http://localhost:3000` (cloudflare mode), `https://aibuilds.dev/`, `https://AIBUILDS.dev` 403; `https://aibuilds.dev` 101; no CF header 503 `Retry-After: 30`; 64 KiB+1 → close 1009; 64 KiB stays open; 6 sockets in one /64 → 5×101, 429; after closing, 6 again → all 101 (counters released); 22 upgrades one IP → 20×101, 2×429; 50 raw upgrades aborted with `resetAndDestroy()` then 1025 attempts over 205 IPs → exactly 1000 opened, 25×503; after closing all → new upgrade 101
- ran: diff probe → `.git/objects` chmod 000 → "Failed to get diff"; restored → same cached failure; 25 concurrent diffs over 3 keys → 18×200, 7×503
- ran: 61× `GET /api/world/sections/hero.html` from one CF IP → 200…, last 429, `RateLimit-Policy: 60;w=60`
- ran: startup config → `CLIENT_IP_MODE=proxy`, cloudflare without CIDRs, `0.0.0.0/0`, `::/0`, `1.2.3.4/33`, `garbage`, `" , "`, `ABUSE_ENFORCEMENT=off`, `ABUSE_ENFORCEMENT=`, `CLIENT_IP_MODE=`, `WS_ALLOWED_ORIGINS=https://x.example/path` → all exit 1 before the banner; malformed agent-credentials.json → exit 1; `NODE_ENV=production` without mode → starts, no mode/warning line in the log
- ran: moderation unit → load `bannedIps ['::ffff:198.51.100.4','2001:DB8::1','garbage',' 1.2.3.4']` → `['198.51.100.4','2001:db8::1']` + "Dropped 2" warn; top-level `agentIps {A:'not-an-ip'}` → throws `Invalid persisted agent IP state`; `ban({ip:'not-an-ip'})` → silently ignored
- ran: read-only data dir + `POST /api/files/pages/t.html/comments` → 500 `Failed to persist comment moderation state` (fails before the comment insert)
- ran: `readJsonResponse` → HTML 429 `Retry-After: 10` → "…rate limit reached while contributing. Retry after 10 seconds."; JSON 429 → server `error`; HTML 500 → "HTTP 500"; 200 text/html → error; HTTP-date Retry-After parsed; 500-char JSON error truncated to 300
- ran: shadow+cloudflare with verified CF → no `ERR_ERL`/ValidationError output from express-rate-limit 7.5.1
- mutation: M4 untrusted peer accepted → RED (client-ip.test.js) in copy scratchpad/slot-a-copy
- mutation: M5 XFF read before CF → RED (client-ip.test.js) in copy scratchpad/slot-a-copy
- mutation: M6 IPv6 key = full address → RED (client-ip.test.js) in copy scratchpad/slot-a-copy
- mutation: direct-mode forwarded-header detector removed → RED (client-ip.test.js) in copy scratchpad/slot-a-copy
- mutation: mapped IPv4 not unwrapped → RED (client-ip.test.js) in copy scratchpad/slot-a-copy
- mutation: M17 owner cap removed → RED (challenge-registry.test.js) in copy scratchpad/slot-a-copy
- mutation: D7 global eviction removed → RED (challenge-registry.test.js) in copy scratchpad/slot-a-copy
- mutation: owner-set cleanup removed → RED (challenge-registry.test.js) in copy scratchpad/slot-a-copy
- mutation: M18 generation check in set() removed → RED; generation check in get() removed → RED (read-cache.test.js) in copy scratchpad/slot-a-copy
- mutation: semaphore waiter cap removed → RED (rc=1, read-cache.test.js) in copy scratchpad/slot-a-copy
- mutation: M2 timingSafeEqual → hex `===` → RED; unclaimed dummy compare removed → RED (agent-credentials.test.js) in copy scratchpad/slot-a-copy
- mutation: M15 MCP parses JSON before status → RED (mcp-http-response.test.js) in copy scratchpad/slot-a-copy
- mutation: M1 profile capability check removed → RED; M3 token on every contribution → RED; establishment check without comments → RED; without history → RED; token written to the contribution log line → RED (profile-ownership.test.js) in copy scratchpad/slot-a-copy
- mutation: M7 hour limiter dropped → RED; M8 chaos without admin → RED; M16 provenance fail-open → RED; sections double-mounted `read` → RED; `limits.identity` → `req.ip` → RED (abuse-limits.test.js) in copy scratchpad/slot-a-copy
- mutation: `isBanned` without canonicalization → GREEN; `ban()` stores raw IP → GREEN (abuse-limits + moderation + publication-flow) in copy scratchpad/slot-a-copy
- mutation: top-level agentIps strict-validation throw removed → GREEN (every suite mentioning agentIps) in copy scratchpad/slot-a-copy
- mutation: load of bannedIps without canonicalization → RED (abuse-limits + moderation) in copy scratchpad/slot-a-copy
- mutation: M9 WS path check removed → RED (rc=1); M10 Origin check removed → RED; M11 `maxPayload` removed from server/index.js → GREEN; M12 post-await abort check removed → RED; counter release on close removed → RED; M19 backpressure removed → RED; per-identity cap removed → RED; global cap removed → RED; admin reset loop over `viewers` replaced by `[]` → RED (ws-admission.test.js) in copy scratchpad/slot-a-copy
- mutation: M13 comment cap removed → RED; M14 per-type reaction cap removed → RED; global reaction cap removed → RED; vote cap removed → RED; agent cap removed → RED; line_number validation removed → RED; search string check reverted → RED (resource-caps.test.js) in copy scratchpad/slot-a-copy
- mutation: comment eviction rollback reverted to `comments.delete` (contribution path) → GREEN; same on the file-comment path → GREEN (resource-caps.test.js) in copy scratchpad/slot-a-copy
- mutation: `/api/stats` cache bypassed → GREEN; diff single-flight bypassed → GREEN; finish/close generation bump removed → GREEN (resource-caps + read-cache); graph truncation disabled → GREEN; sections 4 MiB budget disabled → GREEN; 2 MiB diff cap disabled → GREEN (resource-caps.test.js) in copy scratchpad/slot-a-copy
- ran: `diff -rq` copy vs working tree for server/ and mcp/ after all mutations → identical; `git diff --stat` of the working tree unchanged (18 files, 1036+/380-); copy deleted
- could-not-run: WS abort during a slow store `await` on the real server → the in-process store resolves in a microtask, so the abort window cannot be widened without code changes; covered instead by the RED mutation M12 on the unit test with a delayed store
- could-not-run: real Cloudflare → cloudflared → Traefik header chain → no network beyond loopback (plan §6 item 3 remains Markus' proof)
### VERDICT
FAIL

## Slot A — r2

### FINDINGS
- [WARN] R1-W9 fix is incomplete on the admin path: `app.use('/api/admin', …bumpReadGenerationForMutation…)` (server/index.js ~369) runs BEFORE the per-route `...limits.routes.admin` limiter and also matches paths that have no route at all, so an unauthenticated, unlimited burst of `POST /api/admin/<anything>` (404), admin 429s and admin provenance 503s all bump the read generation and defeat the 5 s read cache and the /api/stats snapshot cache for everyone — the exact defect class R1-W9 was about. The comment there and docs/security/abuse-limits.md ("already gated by its own 5/min limiter regardless of the authentication outcome") are false as measured (200× `POST /api/admin/nope` from one IP → 200×404, no limiter). Minimal fix: drop the `app.use('/api/admin', …)` start bump and do the bump AFTER the admin limiter — e.g. append a `(req,res,next)=>{bumpReadGenerationForMutation(req,res);next();}` middleware to `routes.admin`/`routes.chaos` in server/abuse-limits.js (or call it after each route's secret check); fix the doc sentence; extend the R1-W9 test with `POST /api/admin/nope` and a 6th (429) admin POST asserting no invalidation.
- [WARN] R1-W7 fix is incomplete: the global `totalReactionCount` is still not decremented when `MAX_HISTORY` (1000) trimming in `/api/contribute` (server/index.js ~4427, `contributions.delete(removed.id)`) evicts a contribution with reactions. Measured: preload 1000 history entries totalling exactly 50,000 reactions (oldest entry holds 1,980) → react 409; a new contribution trims the oldest (GET of it → 404, real total now 48,020) → react still 409 until restart (loadState recomputes). On a busy instance the counter only ever grows and the 409 `capacity` becomes permanent until the process restarts. Minimal fix: subtract `removed`'s reaction entries in the trim branch and add them back where `transaction.trimmedHistory` is restored on rollback (or recompute the counter after the rollback), plus a spawned test like the one above.
- [INFO] Comment near the admin bump says it "also covers admin GETs, which bumpReadGenerationForMutation itself skips" — it does not (the function returns early for GET; measured `GET /api/admin/nope` → no invalidation). Harmless (admin GETs are read-only), comment is wrong.
- [INFO] The finish/close `res.statusCode < 400` condition (W9c) is unguarded: removing it stays GREEN (resource-caps + read-cache). Only an extra invalidation, no correctness loss.
- [INFO] R1-W6 real-server 1009 test goes RED under the mutation only by the 5 s test timeout (`cancelled 1`), not by an assertion; the 5 s budget includes spawning the server, so it may flake under load. Consider a local close-wait timeout that asserts a code, and a larger test timeout.
- [INFO] Since R1-W1, every caught diff error is uncached, including deterministic ones (e.g. a stored gitHash that no longer resolves after a history rewrite): each request re-spawns git. Bounded by the diff limiter (10/min/IP) and the semaphore; acceptable.
- [INFO] Credentials `snapshot()`/`restore()` in the admin profile-token route replaces the whole map. The admin route does not hold `CONTRIBUTION_STATE_LOCK`, so a creation-token issued concurrently between snapshot and a failed save would be dropped from memory by the restore (and from disk if its own save runs after the restore). Needs a concurrent transient disk failure; restoring only the entry for `name` would close it.
- [INFO] The R1-W5 spawned test named "persisted ::ffff:-mapped ban" bans via the admin API (ban-time canonicalization), not via a persisted file; load-time canonicalization is covered by the new unit test in test/moderation.test.js, so coverage is complete overall.
### EVIDENCE
- ran: server (copy == working tree) `CLIENT_IP_MODE=cloudflare TRUSTED_PROXY_CIDRS=127.0.0.1/32,::1/128 ABUSE_ENFORCEMENT=shadow PORT=0 POW_DIFFICULTY=0`, no CF-Connecting-IP → `GET /api/challenge` 200; `POST /api/guestbook` with PoW 200; `POST /api/admin/moderation` valid secret 200 (body = moderation state); then 31 PoW-less guestbook POSTs → 29×403, then 429, 429 (the 31st write overall is 429 on the fallback key); `POST /api/vote` afterwards 429 (shared write bucket); admin 2..6 → 403×4, 429
- ran: same server config with enforce (default) → no CF header: `/api/challenge` 503 + `Retry-After: 30`, guestbook 503, admin/moderation 503
- ran: startup log line in shadow run → `[client-ip] mode=cloudflare enforcement=shadow trustedProxyRanges=2` (no address); production warning verified via the R1-W3 test + mutation W3b RED
- ran: ws-admission unit harness, `enforcement:'shadow'`, resolveIdentity → `{ok:false, reason:'invalid-peer', fallbackKey:null}` → `HTTP/1.1 503 Service Unavailable`, `Retry-After: 30`, consume calls 0, handleUpgrade calls 0, stats `{total:0, perKey:{}}`
- ran: enforce server, contribution created, `chmod 000 .git/objects` → diff `{"diff":null,"message":"Failed to get diff: …"}`; `chmod 755` → next diff returns a real diff (failure not cached); response has no `cacheable` key
- ran: 61× `GET /api/world/sections/hero.html` from one CF IP → 61×200; then 61× `GET /api/world/sections` same IP → 60×200, 1×429 (counted once, own budget); HEAD / trailing slash / uppercase path on the exhausted IP → 429; `/api/files` → 429 (shared read budget); fresh IP 30 sections + 30 files → 60×200, 61st 429
- ran: real server WS `/ws` with CF header: 65,537-byte message → close 1009; 65,536 bytes → still open after 1 s
- ran: read-generation probe on enforce server (new world file written before each probe, `/api/stats.fileCount` before/after): control 1→1; `POST /api/nope` 404 1→1; PoW-less guestbook 403 1→1; guestbook 429 (31st write) 1→1; `POST /api/admin/nope` 404 1→6 (INVALIDATED); `GET /api/admin/nope` 6→6; admin/moderation 429 7→8 (INVALIDATED); admin/moderation without CF 503 8→9 (INVALIDATED); successful PoW guestbook 9→10; admin valid secret 10→11
- ran: 200× `POST /api/admin/nope` from one CF IP → 200×404 (no limiter on unrouted admin paths)
- ran: MAX_HISTORY trim probe (spawned server, 1000 preloaded history entries, total reactions 50,000, oldest has 1,980) → react 409; `/api/contribute` 200 (trims oldest; GET of it → 404); react → 409 (counter not decremented)
- ran: fault injection in a separate copy (throw inside the graph and search cache compute fns) → `/api/network/graph` 500 `{"error":"Failed to build network graph"}`, `/api/search?q=abc` 500 `{"error":"Search failed"}`, no hang
- recomputed: shadow fallback write bucket max → 30 accepted, 31st 429
- recomputed: sections read budget per IP → 60 (one count per request), file sub-paths 0
- mutation: C1 provenance branch back on `effectiveEnforcement` → RED (2 tests, abuse-limits.test.js) in copy scratchpad/slot-a-copy-r2
- mutation: W1 cache failures unconditionally → RED (abuse-limits.test.js R1-W1) in copy scratchpad/slot-a-copy-r2
- mutation: W2 `app.use('/api/world/sections', limit('read'))` → RED (abuse-limits.test.js R1-W2) in copy scratchpad/slot-a-copy-r2
- mutation: W3a startup `[client-ip]` log removed → RED (2 tests); W3b production warning removed → RED (abuse-limits.test.js) in copy scratchpad/slot-a-copy-r2
- mutation: W4a contribution-comment rollback `restoreCommentsOrder` → `comments.delete(comment.id)` → RED; W4b same on file-comment path → RED (resource-caps.test.js) in copy scratchpad/slot-a-copy-r2
- mutation: W5a `ban()` stores raw ip → RED; W5b `isBanned` without canonicalization → RED; W5c top-level agentIps throw removed → RED (moderation.test.js) in copy scratchpad/slot-a-copy-r2
- mutation: W6 `maxPayload` removed from server/index.js WebSocket.Server → RED (ws-admission.test.js R1-W6, via 5 s timeout/cancelled) in copy scratchpad/slot-a-copy-r2
- mutation: W7 purge decrement removed → RED (resource-caps.test.js R1-W7) in copy scratchpad/slot-a-copy-r2
- mutation: W9a bump at top of requireProofOfWork → RED; W9b bump for every non-GET → RED; W9d no bump after PoW success → RED (resource-caps.test.js R1-W9) in copy scratchpad/slot-a-copy-r2
- mutation: W9c finish bump ignores status (<400 dropped) → GREEN (resource-caps + read-cache) in copy scratchpad/slot-a-copy-r2
- mutation: INFO c single-flight bypassed → RED (resource-caps.test.js INFO c) in copy scratchpad/slot-a-copy-r2
- mutation: INFO g limiter namespace dropped → RED (abuse-limits.test.js) in copy scratchpad/slot-a-copy-r2
- mutation: INFO b re-issue save failure → `revoke(name)` instead of restore → RED (profile-ownership.test.js) in copy scratchpad/slot-a-copy-r2
- mutation: ws invalid-peer shadow fallthrough (`if (!fallbackKey)` → `if (false)`) → RED (ws-admission.test.js) in copy scratchpad/slot-a-copy-r2
- mutation: INFO e invalid ban ip check disabled → RED (abuse-limits.test.js) in copy scratchpad/slot-a-copy-r2
- ran: after all mutations `diff -rq` copy vs working tree for server/ and test/ → identical; working tree `git diff --stat` 19 files, 1204+/386-; all started servers killed (no `node server/index.js` left); copies and run dirs deleted
- could-not-run: WS invalid-peer on the real server → a loopback socket always has a canonicalizable remoteAddress; measured on the module with an injected resolver instead
### VERDICT
FAIL

## Slot A — r3

### FINDINGS
- [WARN] R2-W4: the fix is correct, but no test guards it. The claim that no test can see it is wrong: a deterministic test exists and was measured. The admin profile-token route now holds CONTRIBUTION_STATE_LOCK for the whole snapshot → issue/revoke → save → restore sequence (server/index.js ~2678-2721), and every other credentials mutation (issue/save/revoke in /api/contribute, server/index.js ~4494-4498) runs inside the same lock (acquired at ~4305, released at ~4534). But removing the lock stays green in the suite, so a regression on a credentials/persistence concurrency path would go unnoticed. Minimal fix: add this spawned test to test/resource-caps.test.js (measured in the copy; about 35 lines):
  1. Preload one history entry for agent `Existing`.
  2. After startup, pin `core.hooksPath` to `world/.git/hooks` and install a `pre-commit` hook that touches an `entered` marker and then loops until a `release` file exists.
  3. POST `/api/contribute` for a new agent. Its git commit blocks inside the hook while the handler holds the lock.
  4. Poll for `entered`, then POST `/api/admin/agents/Existing/profile-token` with `{action:'issue'}`.
  5. Wait `Promise.race([admin, 1 s])`, then create `release`.
  6. Assert both requests return 200 and the completion order is `['contribute','admin']`.
  The green side is deterministic: the admin request cannot finish while the lock is held. Without the lock, the admin route finishes first, and the test went RED 6 of 6 times.
- [INFO] `chaosChain = [...limits.routes.chaos, bumpAfterLimiter]` runs before `requireProofOfWork`. A PoW-less `POST /api/chaos/trigger` → 403 therefore now bumps the read generation (measured). The chaos chain's admin limiter still bounds this to 5/min/IP, so the class is the same as the accepted admin wrong-secret bump. But docs/security/abuse-limits.md says "a PoW-less 403 — does not bump it", which is false for this one route. requireProofOfWork already bumps after PoW, so `chaosChain` could simply be `limits.routes.chaos` (or else fix the docs sentence).
- [INFO] R2-W1 fixed as measured: an unrouted `/api/admin/*` 404 and an admin 429 do not bump; an admin request that clears the limiter bumps (wrong secret included, bounded at 5/min/IP). All 8 admin routes and the chaos route use `adminChain`/`chaosChain`; no `app.use('/api/admin', …)` remains.
- [INFO] R2-W2 fixed: the trim subtracts `reactionEntryCount(removed)`, and the rollback adds the same count back from the same object. While the contribution is trimmed it is absent from `contributions`, so a concurrent reaction to it 404s and cannot desynchronize the counter.
- [INFO] R2-W3 fixed: once a start bump has happened, the finish/close bump is unconditional. The new R2-W3 test depends on timing (`sawMidFlight`), but it passed 15/15 serially and 24/24 run 8-way in parallel. Its setup assertion fails loudly rather than passing vacuously.
### EVIDENCE
- ran: `node --test --test-name-pattern='R2-W|R1-W9' test/resource-caps.test.js` (unmutated copy) -> 3 pass / 0 fail
- ran: R2-W3 test 15× serially -> 15 pass; 3 rounds of 8 parallel runs -> 24× rc=0
- ran: live server (PORT=0 POW_DIFFICULTY=0, temp world/data/backup dirs, CLIENT_IP_MODE=cloudflare, loopback trusted), file dropped before each probe, /api/stats fileCount before→after: `POST /api/admin/nope` 404 1→1 (no bump); `POST /api/chaos/trigger` without PoW 403 1→3 (bumped); `POST /api/admin/moderation` wrong secret 403 3→4 (bumped); 6th admin POST 429 5→5 (no bump); server killed
- read: server/index.js 392-393 `adminChain`/`chaosChain`; all admin routes (2460, 2512, 2605, 2660, 2725, 2745, 2758, 2817) and /api/chaos/trigger (3216) use them; no app-wide /api/admin mount
- read: server/index.js 1133-1140 rollback re-adds `reactionEntryCount(transaction.trimmedHistory)`; 4465-4473 trim subtracts `reactionEntryCount(removed)`
- read: server/index.js 2678-2721 profile-token route under CONTRIBUTION_STATE_LOCK with try/finally release (the 404 return path included); 4305/4494-4498/4534 contribute issuance under the same lock; no other `credentials.issue/revoke/restore/save` call sites besides load() at startup (4880)
- mutation: adminChain = [bumpAfterLimiter, ...limits.routes.admin] -> RED ("an admin request rejected with 429 must not invalidate") in copy scratchpad/slot-a-copy-r3
- mutation: re-add `app.use('/api/admin', bump)` -> RED ("an unrouted /api/admin/* 404 must not invalidate") in copy scratchpad/slot-a-copy-r3
- mutation: bumpAfterLimiter removed from adminChain -> RED (R1-W9/R2-W1 test) in copy scratchpad/slot-a-copy-r3
- mutation: trim subtract removed -> RED ("…must free capacity for a new addition") in copy scratchpad/slot-a-copy-r3
- mutation: rollback add-back removed -> RED ("a failed, rolled-back trim must leave the global reaction counter unchanged") in copy scratchpad/slot-a-copy-r3
- mutation: finish bump skipped when statusCode >= 400 -> RED ("…must be recomputed once that mutation finishes (unconditionally)…") in copy scratchpad/slot-a-copy-r3
- mutation: finish/close listeners removed -> RED (R2-W3 test) in copy scratchpad/slot-a-copy-r3
- mutation: profile-token lock replaced by a no-op release, with the probe test described above -> RED 6/6 (order ["admin","contribute"]); unmutated -> GREEN 6/6 (order ["contribute","admin"], both 200) in copy scratchpad/slot-a-copy-r3
- ran: after mutations, `diff -q` copy index.js vs working tree -> identical; copy deleted; working tree `git diff --stat` 19 files; `pgrep -fl 'node server/index.js'` -> none
### VERDICT
FAIL

## Slot A — r4-verify

### FINDINGS
- [WARN] The new R3-W1 test (test/resource-caps.test.js, around line 1003-1012 plus its t.after hooks) leaks an orphaned, never-ending `git commit` + `/bin/sh pre-commit` busy loop on every RED run. That is exactly the run the test exists for: a regression in the lock. Cause: the t.after hooks run in FIFO order, so the release marker is written, then the server is killed, then `fs.rm(dirRoot)` deletes the whole temp dir, release marker included. All of that happens within the hook's 50 ms poll interval, so the hook never sees the marker and `while [ ! -f release ]` spins forever (parent reparented to PID 1). The test comment claims the opposite ("a failing or hanging run always releases the hook FIRST"). Measured: 4 of 4 mutated (red) runs each left one leaked pair. 0 of 12 green runs leaked. 6 further identical orphans from 23:59:24-23:59:43 were already running before this pass (PIDs 62449, 63149, 63441, 63751, 63922, 64116; not started by me, still alive, and their temp dirs are gone), so the earlier mutation runs leaked the same way. Minimal fix: make the hook loop also exit once the temp dir is gone. Change the loop line to `` `while [ ! -f '${releaseMarker}' ] && [ -d '${dirRoot}' ]; do` ``. Measured in the copy with this fix: mutated runs RED 2 of 2 with 0 leaked processes; unmutated run GREEN. Separately, kill the 6 orphan PIDs listed above.
- [INFO] R3-W1 is otherwise verified. The test is deterministic on the green side (5 of 5 serial, 6 of 6 run 6-way in parallel, and the full file 18 of 18). It goes RED at the intended assertion ("must still be blocked on the lock 1s after …") when the profile-token route's lock acquisition is replaced by a no-op (4 of 4).
- [INFO] R3-I1 is verified. `/api/chaos/trigger` mounts `...limits.routes.chaos, requireProofOfWork` (server/index.js:3224), and no `chaosChain` or `bumpAfterLimiter` remains on it. `limits.routes.chaos = chain('write','admin')` reuses the memoized `limit('admin')` middleware, which is the same bucket as the admin routes, and the probe confirms the bucket is shared in both directions.
- [INFO] R3-I2 is verified. The comment at server/index.js:340-348 (the stale "any non-GET/HEAD mutation" sentence is replaced), the comment block at 358-396, and the "Read-generation cache bump rule" in docs/security/abuse-limits.md:113-123 all match the code. No `chaosChain` or `admin/chaos` references remain in server/, test/, docs/, mcp/, the READMEs or public/llms-full.txt.
- [INFO] Apart from the test-cleanup leak above, the delta touches only comments, the one chaos mount and the new test. No new defect found.
### EVIDENCE
- ran: `node --test --test-name-pattern='R3-W1' test/resource-caps.test.js` ×5 serially (working tree) -> 5× rc=0, each 1 pass / 0 fail
- ran: same command ×6 in parallel -> 6× rc=0
- ran: `node --test test/resource-caps.test.js` -> rc=0, 18 tests / 18 pass / 0 fail
- mutation: profile-token route `const releaseContributionState = await acquireWorldMutation(CONTRIBUTION_STATE_LOCK);` -> `() => {}` (only line 2686 changed, checked by diff) -> RED 4/4 at "the admin issue request must still be blocked on the lock 1s after the contribute request entered the hook", in copy scratchpad/slot-a-verify
- ran: `pgrep -fl aibuilds-lock-order` after the mutation runs -> 4 new orphaned pairs `git commit --only --allow-empty -m [NewLockOrderAgent] …` + `/bin/sh …/aibuilds-lock-order-*/world/.git/hooks/pre-commit`, PPID 1, started 00:03:58-00:04:03 (my 4 red runs). Their temp dirs no longer exist. I killed my 4 pairs. 6 older pairs from 23:59 (not mine) are still running.
- mutation: the same lock removal plus the proposed hook fix (`&& [ -d '${dirRoot}' ]`) -> RED 2/2, 0 leaked processes afterwards, in copy scratchpad/slot-a-verify
- ran: the proposed hook fix on unmutated server code -> rc=0, 1 pass, in copy scratchpad/slot-a-verify
- ran: live server from the working tree (PORT=0 POW_DIFFICULTY=0, temp world/data/backup dirs, ADMIN_RESET_SECRET=probe value, CLIENT_IP_MODE=cloudflare, loopback trusted) via scratchpad/probe-r3i1.js, file dropped into world/ before the probes:
- recomputed: a PoW-less `POST /api/chaos/trigger` returns 403 and does not invalidate /api/stats -> 403; fileCount 1→1 (stale, not bumped)
- recomputed: a chaos request with PoW but the wrong secret bumps through the PoW success -> 403; fileCount →2
- recomputed: the chaos route shares the 5/min admin bucket (admin→chaos) -> 5× `/api/admin/moderation` 403, then chaos with PoW and the right secret from the same IP -> 429
- recomputed: the chaos route shares the 5/min admin bucket (chaos→admin) -> 5× PoW-less chaos 403, 6th chaos 429, `/api/admin/moderation` from the same IP 429; fileCount 3→3 across both 429s
- recomputed: chaos with PoW and the right secret -> 200; fileCount 3→4 (bumped)
- mutation: re-add `bumpAfterLimiter` before `requireProofOfWork` on the chaos route -> the probe's P1 flips to fileCount 1→2 (a PoW-less 403 bumps), in copy scratchpad/slot-a-verify, so the probe discriminates. No suite test guards R3-I1; it was an INFO fix.
- ran: `grep -rn -e chaosChain -e bumpAfterLimiter -e 'admin/chaos' server test docs mcp README.md SECURITY.md NEXT_SESSION.md public/llms-full.txt` -> only server/index.js:401 `adminChain` plus the comment lines
- ran: `diff -q` of the copy's index.js against the working tree after restoring -> identical; copy deleted; `git diff --stat` -> 19 files (unchanged); `pgrep -fl server/index.js` -> none; probe temp dir removed
### VERDICT
FAIL

## Slot A — r5-final

### FINDINGS
- none
- [INFO] test/resource-caps.test.js is untracked, so `git diff -- test/resource-caps.test.js` is empty; the fix was confirmed by reading the file: hook loop is `while [ ! -f '${releaseMarker}' ] && [ -d '${dirRoot}' ]; do` with a two-line comment above it.
### EVIDENCE
- ran: node --test --test-name-pattern="R3-W1" test/resource-caps.test.js (x3, original tree) -> rc=0 each, pass 1 / fail 0
- ran: pgrep -fl "aibuilds-lock-order|pre-commit" before and after the GREEN runs -> no processes
- mutation: R3-W1 test with server/index.js:2686 `await acquireWorldMutation(CONTRIBUTION_STATE_LOCK)` replaced by `() => {}` (only in the admin profile-token route; diff vs original = that single line) -> RED in copy /private/tmp/claude-501/-Users-markus-Developer-aibuilds/3b5dd47c-c6ab-4648-9c97-3771292ee9f8/scratchpad/slot-a-final (3 runs, rc=1, pass 0 / fail 1, assertion "the admin issue request must still be blocked on the lock 1s after the contribute request entered the hook")
- ran: pgrep -fl "aibuilds-lock-order|pre-commit|git commit" and ps -Ao pid,etime,command | grep -E "lock-order|pre-commit|git commit|hook-release|sleep 0.05" after each RED run -> no leftover git commit / pre-commit hook / sleep processes
- ran: ls $TMPDIR/aibuilds-lock-order-* after RED runs -> 0 leftover temp dirs
- ran: rm -rf of the copy -> removed; original server/index.js still contains 15 occurrences of `await acquireWorldMutation(CONTRIBUTION_STATE_LOCK)` (untouched, no writes to the real repo besides this file)
### VERDICT
PASS

## Slot B — r1 (verdict and findings)

### FINDINGS
- [CRITICAL] Shadow mode does not relax the provenance 503 on `write`, `challenge` and `admin`. Plan D3, abuse-limits.md §1/§6 (residual F19) and the rollout's "deploy in shadow first" all say otherwise. In `limit()`, a non-shadowable policy is forced to `effectiveEnforcement = 'enforce'`, so an unverified request gets 503 even under `ABUSE_ENFORCEMENT=shadow`. Every PoW chain starts with `write`, so with shadow on a broken or misconfigured header chain (wrong TRUSTED_PROXY_CIDRS, stripped CF header, or direct-mode default behind Traefik adding XFF), every contribute, guestbook, vote, reaction, comment, profile, challenge and admin request returns 503. That is exactly the outage shadow mode is documented to prevent, and no test covers shadow + missing provenance. The code comments contradict each other too: index.js requireProofOfWork says unverified requests are "already rejected upstream", while the guestbook, comment and contribute handlers say `clientIp` is null "in shadow mode", which is unreachable. Minimal fix: in `limit()`, when `config.enforcement === 'shadow'` and `ident.key` (fallbackKey) exists, count non-shadowable policies on the fallback key instead of returning 503, as F19 describes, and add a spawned-server test (shadow + missing CF header → guestbook/challenge 200, `provenanceFailures` counted). Alternatively, if fail-closed is intended, rewrite D3, abuse-limits.md §1, §6 F19 and the rollout text, and remove the dead `clientIp !== null` shadow comments.
- [WARN] The startup log never shows the parsed client-IP mode or enforcement, and `productionWarning` is computed but never surfaced. abuse-limits.md §6 and plan §6 item 4 make "the startup log shows the parsed mode" a passive-proof step, and plan T1 requires a `console.warn` when NODE_ENV=production and CLIENT_IP_MODE is unset. With the default `direct` mode behind Traefik (which adds XFF), every write 503s silently. Minimal fix: after `parseClientIpConfig`, log `mode`/`enforcement` (no IPs) and `console.warn` when `clientIpConfig.productionWarning`.
- [WARN] `totalReactionCount` is not decremented when `/api/admin/moderate` `delete` purges contributions from `history`/`contributions`. The counter drifts upward until restart and can produce a false global 409 `capacity`, contradicting the comment "maintained incrementally at mutation time". Minimal fix: in the purge loop, subtract the purged contribution's reaction array lengths (or recompute the counter after the purge).
- [WARN] docs/security/abuse-limits.md contradicts the code and its own "everything below is implemented" status note. §5 says `public/js/app.js` "still needs this one-line change" (it was changed in this diff), the heartbeat line says "once wired", and §4 labels issuance "target behavior, once T3/T5 wiring lands". Minimal fix: remove the pending/future wording from these three places.
- [WARN] `app.use('/api/world/sections', limits.limit('read'))` prefix-matches every method and every sub-path. `GET /api/world/sections/<file>.html` (served by `/api/world/*`, used by MCP `aibuilds_read_file`) therefore now consumes the shared 60/min `read` budget, while the docs list exactly five read routes. The in-process test fixture copies the same mount, so it cannot catch this. Minimal fix: wrap the mount so it only counts `req.method === 'GET' && (req.path === '/' || req.path === '')`, or document the extra coverage.
- [WARN] `bumpReadGeneration` bumps the global read-cache generation for every non-GET/HEAD request before any limiter, PoW or auth, including 404s, 429s and 503s. Any unauthenticated cheap POST (for example to a nonexistent path) invalidates all generation caches. The documented bounds therefore fail: residual F18 ("open-class reads without provenance ... bounded only by the read caches") and the `/api/stats` snapshot cache (the route has no limiter). Minimal fix: bump only for requests that reach a mutating handler, e.g. after `requireProofOfWork` succeeds and after the admin secret check. Keep both the start bump and the finish bump there.
- [WARN] Copy-manifest deviation: SECURITY.md's sandbox bullet ("CSS/JS includes of the World page still load ... WebSocket checks the Origin header ...") was rewritten. Permitted deviation 5 only allows "two rows rewritten" (rate-limit and CORS), so this third changed visible line is unlisted. Minimal fix: add it to the exhaustive permitted-deviation list in the plan, or revert it.
- [INFO] test/client-ip.test.js `assert.notEqual('::ffff:1.2.3.4', canonicalIp('1.2.3.4'))` is vacuous: it compares a literal with the unchanged IPv4 and cannot fail under any mutation of the mapped-address branch. The real guard is the previous line.
- [INFO] The "without X ... (documents the guard)" tests (challenge-registry owner cap at maxPerOwner 1e6, generation cache set with the current generation, semaphore with maxWaiters 1e6) exercise a different configuration. They cannot turn red when the production guard is mutated, so they are not mutation evidence.
- [INFO] The `/api/search` and `/api/network/graph` handlers became `async` without try/catch under Express 4. A throw inside the compute function now leaves the request hanging (it is only logged by the `unhandledRejection` handler) instead of Express returning 500.
- [INFO] The diff LRU also caches `{ diff: null, message: 'Failed to get diff: ...' }`, so a transient git error for a contribution stays pinned until LRU eviction (previously the next request retried).
- [INFO] The admin `issue` save-failure path calls `credentials.revoke(name)`, which also drops a previously valid credential in memory while disk still holds it (memory and disk diverge until restart). `snapshot()`/`restore()` exist but are unused. The `revoke` save-failure path diverges the same way.
- [INFO] `canonicalIp` returns null for valid IPv6 literals with embedded dotted IPv4 (e.g. `64:ff9b::1.2.3.4`, `::1.2.3.4`), because `expandIPv6Groups` yields 7 groups. Such a CF-Connecting-IP becomes `invalid-cf-header`.
- [INFO] `WS_ALLOWED_ORIGINS` accepts an entry with a trailing slash (`isValidOrigin` allows `${rebuilt}/`), but browsers never send one, so that entry silently never matches.
- [INFO] The D8 wording "nobody else can claim that name" holds only for names that already had a credential. After `/api/admin/reset`, or once a name's only comments were evicted at the 5,000 cap, a credential-less legacy name becomes "not established" and its next contributor gets an automatic token.
- [INFO] The resource-caps comment-rollback test forces the save failure with `chmod 0500` on the data dir. Run as root, the write succeeds and the rollback assertions do not exercise the failure path.
### VERDICT
FAIL

## Slot B — r2 (verdict and findings)

### FINDINGS
- [WARN] R1-W9 is only half fixed: the `/api/admin` bump reopens the same hole. `app.use('/api/admin', ...)` (server/index.js:369-372) runs BEFORE the route-level `...limits.routes.admin` limiter (e.g. server/index.js:2435, 2487, 2580) and matches every sub-path. Two consequences. First, a 429'd admin request still bumps the generation, so the comment's premise "already gated by its own 5/min limiter, so bumping there is bounded" (server/index.js:366-367) is false. Second, `POST /api/admin/<anything-nonexistent>` has no limiter at all: it bumps and then 404s. An unauthenticated, cheap POST burst can therefore still defeat the 5s read cache and the unlimited `/api/stats` snapshot cache for everyone. That contradicts the new docs rule ("A request that never got that far — a 404, a 429, or a PoW-less 403 — does not bump it", docs/security/abuse-limits.md, "Read-generation cache bump rule"). The new R1-W9 test only probes a non-admin 404 and a PoW-less 403, so it cannot catch this. Minimal fix: drop the `app.use('/api/admin', …)` bump. Instead, call `bumpReadGenerationForMutation(req, res)` inside each admin handler right after `safeSecretEqual` succeeds, or in a middleware appended after `...limits.routes.admin` plus a secret check. Then add one test case: `POST /api/admin/does-not-exist` → 404 → `/api/stats` still cached.
- [WARN] The R1-W9 fix silently regresses Gate R1 F16. `armReadGenerationFinishBump` now bumps only when `res.statusCode < 400` (server/index.js:356). F16 exists for exactly the failing case: a mutation that changes in-memory state, fails partway and rolls back (the comment handlers return 500 after `restoreCommentsOrder`, server/index.js:3459-3468 / 3588-3595; contribute rolls back history). A read cached while that request was in flight, after the start bump, then keeps serving the provisional, rolled-back state for up to 5s. The comment at server/index.js:347-350 still claims F16 is honoured. The `< 400` condition also buys no abuse protection: the start bump is now reachable only after PoW success (or, once the WARN above is fixed, after admin auth). Minimal fix: remove the `if (res.statusCode < 400)` guard and bump unconditionally on finish/close, as before. Correct the docs sentence "but only if the response actually succeeded (`res.statusCode < 400`)" to match.
- [WARN] The R1-W7 fix is incomplete: the routine MAX_HISTORY trim path has the same drift. `/api/contribute` evicts the oldest contribution once history exceeds 1,000 (`history.shift(); contributions.delete(removed.id)`, server/index.js:4427-4431) without subtracting its reaction entries from `totalReactionCount`. loadState only recomputes the counter at restart (server/index.js:1334-1343). On a live instance past 1,000 contributions, every new contribution therefore leaks the evicted record's reactions into the counter until a false global 409 `capacity`. This is the same defect class as R1-W7 on a far more frequent path. The rollback re-inserts `transaction.trimmedHistory` (server/index.js:1112-1115), so it must re-add what the trim subtracted. Minimal fix: subtract the removed record's reaction-array lengths at the trim, and re-add them in `rollbackContributionTransaction` when `transaction.trimmedHistory` is restored. Alternatively, recompute the counter from `contributions` after both. Add a test: preload 1,000 history entries whose oldest carries N reactions sitting at the cap, contribute once, then assert a new reaction → 200.
- [WARN] The INFO (b) fix introduces a new memory/disk divergence on credentials. The admin profile-token route does not hold CONTRIBUTION_STATE_LOCK (server/index.js:2635-2683), yet it `restore()`s a whole-map `snapshot()` (agent-credentials.js:150-156) after awaiting `save()`. A contribution that auto-issues a creation token for a new name (under the lock, server/index.js:4451-4454) can interleave between that snapshot and restore. Its chained save can succeed and persist both the new name and the admin's new hash, because `writeFile()` serializes the live map at write time (agent-credentials.js:95-101). The admin's failure path then restores the old map. The newcomer's delivered token stops verifying in memory while disk still holds it, and the admin's undelivered re-issued hash is what lands on disk, so the old owner's token breaks after restart. The old `revoke(name)` only touched `name`. Minimal fix: acquire CONTRIBUTION_STATE_LOCK in the admin profile-token route for the whole snapshot → issue/revoke → save → restore sequence, which serializes it against creation issuance. Alternatively, restore only `previous.get(name)` for that name.
- [INFO] R1-C1 is fixed as specified. `canShadowFallback` now keys on `config.enforcement` (payload-delta-r2.diff:1268), non-shadowable policies still reject at their own max through the erl `handler`, and `/api/challenge` uses `req.abuseIdentity.key`, i.e. the fallback peer key (server/index.js:2343), consistent with the F19 residual. The unit test (30×200, 31st 429, 31 provenance failures) and the spawned shadow/enforce pair would go red on the old line. Docs §1, the abuse-limits.js header comment and the requireProofOfWork comment now agree.
- [INFO] R1-W1, R1-W2, R1-W3, R1-W4, R1-W5, R1-W6, R1-W8 and R1-W10 look fixed by reading.
  - R1-W1: `cacheable:false` is set only in the catch branch and stripped before `res.json`.
  - R1-W2: `app.get` exact path plus a pass-through, mirrored in the fixture.
  - R1-W3: the startup log prints only the CIDR count.
  - R1-W4: `state.json.tmp` as a directory matches `_saveStateImpl`'s temp name (server/index.js:1488-1489). The asserted body `'Failed to persist comment'` matches both handlers (server/index.js:3468, 3595), which proves `recordAgentIpDurably` succeeded first.
  - R1-W5: unit tests exercise moderation.js's own canonicalization, and the load() test runs in a child process with `AIBUILDS_DATA_DIR`, matching moderation.js:12-13.
  - R1-W6: a spawned 1009 test with a 5s timeout.
  - R1-W8: the pending/future wording is removed.
  - R1-W10: plan items 6 and 7 are added.
- [INFO] The comment at server/index.js:366-368 says the admin bump "also covers admin GETs", but `bumpReadGenerationForMutation` returns early for GET/HEAD (server/index.js:362). The comment at server/index.js:328-330 still says "any non-GET/HEAD mutation invalidates every cached read". Both are stale.
- [INFO] The R1-W1 test forces the failure with `chmod 0o000` on `.git/objects`. Run as root, git still reads the objects, and the `failing.body.diff === null` assertion fails spuriously. The R1-W4 test deliberately moved to the root-safe EISDIR technique for this reason.
- [INFO] The spawned test "a persisted ::ffff:-mapped ban" bans via `/api/admin/ban`, not via persisted state. The persisted case is covered separately by the new moderation.test.js `loadModeration` unit test, so only the test name is misleading.
- [INFO] With the diff single-flight now outside the semaphore, a `DIFF_SEMAPHORE_FULL` thrown by a leader is shared by all of its followers, which all get 503. That is acceptable. Any other throw from `diffSemaphore.acquire()` is rethrown from an async Express 4 handler without a response (the hanging-request class fixed in INFO a for search/graph). This is practically unreachable.
### VERDICT
FAIL

## Slot B — r3 (verdict and findings)

### FINDINGS
- [INFO] R2-W1 fixed: the app-wide `app.use('/api/admin', …)` bump is gone. `bumpAfterLimiter` is appended after `limits.routes.admin` / `limits.routes.chaos` (server/index.js:388-393), and every admin route now uses `...adminChain`. An unrouted `/api/admin/*` 404, a limiter 429 and a provenance 503 all end before the bump. The new test covers the unrouted 404, five in-budget admin hits that bump, and a 6th (429) that does not. Both mutation directions (old prefix mount, bump before the limiter) would turn it red.
- [INFO] Small doc/code mismatch on `/api/chaos/trigger`. `chaosChain` bumps BEFORE `requireProofOfWork` (server/index.js:393 + the route mount), so a PoW-less 403 on that route DOES bump. docs/security/abuse-limits.md ("Read-generation cache bump rule") lists "a PoW-less 403" as never bumping, without qualification. The bump is still bounded by the admin policy (5/min per identity; the chain is write+admin), so the impact is harmless. Optional fix: add "(except `/api/chaos/trigger`, whose bump follows its admin limiter)" to the docs, or move `bumpAfterLimiter` after `requireProofOfWork` for chaos (PoW success already bumps).
- [INFO] R2-W2 fixed: the trim subtracts `reactionEntryCount(removed)` (server/index.js:4472) and the rollback adds it back (server/index.js:1139). The counting rule matches loadState/purge. The new test's three assertions (409 after rollback, 404 after the real trim, 200 once capacity is freed) would go red if either half were removed on its own. Asymmetry: the trim clamps with `Math.max(0, …)` but the add-back does not. This only matters if the counter had already drifted below the trimmed entry's count, so it is harmless in practice.
- [INFO] R2-W3 fixed: `armReadGenerationFinishBump` bumps unconditionally (server/index.js:366-375), and the comment and docs now describe F16 correctly. The new test is non-vacuous against a restored `< 400` guard (the mid-flight cached +1 would persist, and the test expects +2). But it depends on a timing race to set `sawMidFlight`, which it asserts explicitly (an honest red, not a silent pass). It may flake on a fast machine where the comment POST settles before a poll recomputes.
- [INFO] R2-W4 fixed: the whole issue/revoke + save + snapshot/restore sequence runs under `CONTRIBUTION_STATE_LOCK` with a `finally` release (server/index.js:2678-2720). The only other credential writer found is the on-creation issuance, which already runs inside the same lock (server/index.js:4493-4502, released at 4534). No nested acquisition, so no deadlock. There is no dedicated regression test for the interleaving, which is hard to reproduce deterministically, so this is acceptable.
- [INFO] Stale comment at server/index.js:340-342: "any non-GET/HEAD mutation invalidates every cached read together" no longer matches the R1-W9/R2-W1 rule. The round-2 mapping said comments would be adopted, but this one was not updated.
### VERDICT
PASS

## Slot B — r4-verify (verdict and findings)

### FINDINGS
- [INFO] R3-W1 done. test/resource-caps.test.js now has the lock-order test Slot A specified: a pre-seeded `Existing` agent and history entry, a World repo created and seed-committed before the server starts with `core.hooksPath` pinned to its own `.git/hooks`, a blocking `pre-commit` hook installed after startup, an `entered` marker asserted as a setup precondition, a 1 s `Promise.race` that must end in `timeout`, then release, then both requests return 200 and the order is `['contribute','admin']`. The test is not vacuous against the lock being removed: without the lock the admin request settles inside the 1 s window and the race assertion fails. Cleanup is safe: the release-marker `t.after` is registered before spawnServer's kill hook (FIFO, as the spawnServer comment states), so a hung hook is released before the child is killed, and the temp dir (`root` passed, so spawnServer skips its own rm) is removed by the test's own later hook.
- [INFO] R3-I1 done. `/api/chaos/trigger` now mounts `...limits.routes.chaos, requireProofOfWork`. `chaosChain` is removed. The PoW-success bump inside requireProofOfWork still covers a real chaos mutation. No test guards this reversal: re-adding `bumpAfterLimiter` to the chaos chain would stay green. That is acceptable for an INFO-class, 5/min-bounded path.
- [INFO] R3-I2 done. The stale comment at server/index.js:340-348 now describes the real bump rule (PoW success or a passed admin limiter; never missing PoW, wrong challenge, 429 or unrouted 404; unconditional finish/close). The comments at 358-371 and 387-396 and the docs paragraph (abuse-limits.md:113-123) agree with the code, including the chaos exception.
- [INFO] The completion-order assertion `['contribute','admin']` rests on client-side fetch resolution order. It holds in practice: contribute's `res.json` (4530) is sent before the lock is released, and the admin handler still has to acquire the lock and run `credentials.save()` afterwards. Still, it is an ordering over two sockets, not a server-side guarantee. The 1 s race assertion is the load-bearing check.
### VERDICT
PASS

## Findings mapping (.review/rounds.md)

### DoD rounds — abuse/authz hardening (2026-09-23)

### Round 1 — Slot A FAIL (1 CRITICAL, 6 WARN, 10 INFO) · Slot B FAIL (1 CRITICAL, 6 WARN, 9 INFO)
Slot B note: one `echo noop` Bash call (protocol breach, disclosed by the reviewer, no ran:/recomputed:/mutation: lines emitted); its findings were measured before acting.

| # | Finding | Slot | Verdict | Decision → file |
|---|---|---|---|---|
| R1-C1 | shadow mode 503s write/admin/challenge without provenance (D3 violated) | A+B | bestätigt (measured by A; code read abuse-limits.js:167-179) | fix: provenance branch on global enforcement, fallback key for all policies; spawned test → server/abuse-limits.js, test/abuse-limits.test.js |
| R1-W1 | diff cache pins transient git failures | A (+B INFO) | bestätigt (A measured) | fix: never cache failures → server/index.js, test |
| R1-W2 | sections read limiter prefix-matches /api/world/sections/<file> | A+B | bestätigt (A measured 60×200,1×429) | fix: exact-path GET mount → server/index.js, test |
| R1-W3 | startup never logs mode/enforcement/productionWarning | A+B | bestätigt | fix → server/index.js |
| R1-W4 | D5 rollback test vacuous (fails before insert) | A (+B INFO root) | bestätigt (A mutation green) | fix test for both comment paths → test/resource-caps.test.js |
| R1-W5 | T3 moderation tests missing | A | bestätigt (3 green mutations) | add tests → test/moderation.test.js / test/abuse-limits.test.js |
| R1-W6 | server maxPayload wiring unguarded | A | bestätigt (M11 green) | spawned 1009 test → test/ws-admission.test.js |
| R1-W7 | totalReactionCount drifts on admin delete | B | bestätigt by code read (purge loop has no decrement) | fix + test → server/index.js |
| R1-W8 | docs still carry pending/future wording | B | bestätigt | fix → docs/security/abuse-limits.md |
| R1-W9 | read-generation bump on any non-GET (404/429 POST defeats caches) | B | bestätigt (no regression vs. uncached baseline, but defeats the documented bound) | fix: start-bump only after PoW success or on /api/admin/*; finish/close bump only when status < 400 → server/index.js, test |
| R1-W10 | SECURITY.md third line + mcp/README table row not in permitted-deviation list | A INFO + B WARN | bestätigt | plan T9 list extended (content verified accurate) → plan |
| INFO | async search/graph without try/catch; credentials save-failure drops prior token; single-flight inside semaphore; vacuous client-ip assert; /api/admin/ban invalid ip → success; onWsAccepted close listener after await; rl key namespace; ws invalid-peer undefined key; trailing-slash origin; D8 wording; untested bounds (sections budget, graph truncation, diff cap, stats cache) | A/B | adopted where cheap | see fix brief |
| INFO | IPv4-embedded IPv6 forms rejected; MAX_AGENTS 503 without Retry-After | A/B | accepted as is | Cloudflare/Node never emit these forms; capacity is not transient |

### Round 2 (delta) — Slot A FAIL (0 CRITICAL, 2 WARN, 6 INFO) · Slot B FAIL (0 CRITICAL, 4 WARN, 6 INFO)
All round-1 findings measured fixed by Slot A except W9 (admin path) and W7 (history trim).

| # | Finding | Slot | Verdict | Decision → file |
|---|---|---|---|---|
| R2-W1 | admin generation bump runs before the admin limiter and on unrouted /api/admin/* (404/429/503 invalidate caches; measured) | A+B | bestätigt | fix: bump appended after the admin limiter inside the admin route chain only; test admin 404 and 429 do not bump; docs/comment fixed |
| R2-W2 | history trim at MAX_HISTORY does not subtract reactions (measured 409 persists) | A+B | bestätigt | fix: subtract on trim, add back on rollback; test |
| R2-W3 | finish bump only when status < 400 leaves rolled-back provisional state cached up to 5 s (F16 regression) | B (A INFO: condition unguarded) | bestätigt (code read :356) | fix: once a request started a mutation bump, bump on finish/close unconditionally |
| R2-W4 | admin profile-token route restores the whole credentials snapshot without the state lock → can drop a concurrently issued creation token in memory | B (A INFO) | bestätigt (code read) | fix: admin issue/revoke+save under CONTRIBUTION_STATE_LOCK (contribute issuance already holds it) |
| INFO | wrong comment on admin GETs; 1009 test red only via timeout; deterministic diff errors no longer cached; persisted-ban spawn test bans via API; W1 test not root-safe | A/B | adopted: comments; others accepted as is (unit test covers persisted load; timeout is an honest red; not caching deterministic errors is harmless) | — |

### Round 3 (delta, finding-round limit reached) — Slot A FAIL (0 CRITICAL, 1 WARN, 4 INFO) · Slot B PASS (0/0/6 INFO)
R2-W1..W3 measured fixed by Slot A (7 mutations red at the right assertion); Slot B confirms all four by reading.

| # | Finding | Slot | Verdict | Decision → file |
|---|---|---|---|---|
| R3-W1 | R2-W4 lock untested although a deterministic test exists (blocking world pre-commit hook holds contribute inside the lock; admin issue must complete after it; 6/6 green with lock, 6/6 red without, measured by Slot A) | A (B INFO) | bestätigt | escalation per CLAUDE.md round limit; decided under Markus' standing instruction ("follow your professional recommendation", 2026-09-23): add the test → test/resource-caps.test.js; verification pass follows |
| R3-I1 | /api/chaos/trigger chain bumps before requireProofOfWork, so a PoW-less 403 bumps (bounded 5/min/IP), docs claim otherwise | A+B INFO | bestätigt (A measured) | fix: chaos route uses limits.routes.chaos without bumpAfterLimiter (the PoW success bump already covers it) |
| R3-I2 | stale comment server/index.js:340-342 | B INFO | bestätigt | fix comment |
| R3-I3 | rollback add-back lacks the Math.max symmetry; R2-W3 test timing-dependent (15/15 and 24/24 green, explicit sawMidFlight guard) | A/B INFO | accepted as is | counter only ever adds back what was subtracted; the test fails honestly when it cannot observe mid-flight |

### Verification pass after round 3 — Slot A FAIL (0/1 WARN/4 INFO) · Slot B PASS (0/0/4 INFO)
R3-W1, R3-I1, R3-I2 confirmed by both slots (A: lock test 5/5 + 6/6 green, lock-removal mutation 4/4 RED at the right assertion; chaos PoW-less 403 no longer bumps, shared admin bucket both directions).

| # | Finding | Slot | Verdict | Decision → file |
|---|---|---|---|---|
| V-W1 | R3-W1 test leaves an endless `git commit` + pre-commit hook pair on every RED run: cleanup deletes the temp dir before the 50 ms poll sees the release marker (measured 4/4) | A | bestätigt (six such pairs from earlier mutation runs found and killed) | fixed with the reviewer's measured minimal fix: loop also ends when the temp dir is gone → test/resource-caps.test.js; controller measured 3/3 green, lock-removal mutant 2/2 RED, 0 leftover processes |
| V-I1 | R3-I1 has no regression test (old mount re-added stays green) | A+B INFO | accepted as is | INFO; path bounded by the 5/min admin bucket; measured manually by Slot A |
