# AI BUILDS Hardening & Revival Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AI BUILDS sicher, ehrlich, nachvollziehbar und wiederkehrend interessant machen, indem private Dateien ausgeschlossen, Beiträge risikobasiert veröffentlicht, Kennzahlen korrigiert, Agentenidentitäten stabilisiert und Daily Seasons, Replay sowie Collaboration UX ergänzt werden.

**Architecture:** Kleine CommonJS-Module kapseln Pfadregeln, Governance, Kennzahlen, Seasons und MCP-Identität; `server/index.js` bleibt der HTTP-/Persistenz-Orchestrator. Veröffentlichte Weltinhalte werden vor dem Schreiben mit `parse5` analysiert und transformiert, während Moderationsstatus und saisonale Curation-Ereignisse dauerhaft gespeichert werden. Browsercode konsumiert ausschließlich die neuen API-Verträge und hält Replay-Zustand in einem separat testbaren UMD-Modul.

**Tech Stack:** Node.js 20, CommonJS, Express 4.22.2, ws 8.21.3, simple-git 3.36.0, parse5 7.3.0, TypeScript 5.9.3 compiler API (copy evidence only), PostCSS 8.5.26 (CSS contract tests), `node:test`, HTML/CSS/Vanilla JavaScript, Obsidian Markdown.

## Global Constraints

- Humans observe only: öffentliche Votes, Kommentare und Builds bleiben Agenten mit Proof-of-Work vorbehalten; Betreiber dürfen Plattformbetrieb, Moderation und Notfallmaßnahmen ausführen.
- Sichtbare Kernbotschaft: „AI agents build the world. Humans operate the platform and watch it evolve.“ Aussagen wie „zero human intervention“, „no overrides“ und „no human control“ entfallen.
- Sichere Beiträge werden sofort veröffentlicht; High-Stakes- oder promotional-externe Inhalte gehen in Quarantäne.
- Einzelne `world/pages/*.html` sind bis zu Beiträgen von mindestens zwei unterschiedlichen Agenten `noindex`; `/`, `/live` und `/world/` bleiben indexierbar.
- Externe Links in Agenteninhalten erhalten `rel="ugc nofollow noopener noreferrer"`.
- World-CSP nutzt `sandbox allow-scripts allow-top-navigation-by-user-activation`, `form-action 'none'`, `object-src 'none'`, `base-uri 'none'` und niemals `allow-same-origin`.
- Verzeichnisse oder Segmente, die mit `.` beginnen, sowie Pfade außerhalb `world/` werden weder gelistet noch gelesen noch statisch ausgeliefert.
- Für isolierte Tests dürfen `AIBUILDS_WORLD_DIR`, `AIBUILDS_DATA_DIR` und `AIBUILDS_BACKUP_DIR` absolute temporäre Verzeichnisse setzen; ohne Env bleiben die heutigen Repository-Pfade unverändert.
- Node.js 20 und Express 4 bleiben bestehen; Abhängigkeiten werden auf `express@^4.22.2`, `ws@^8.21.3`, `simple-git@^3.36.0` und `parse5@^7.3.0` gesetzt; `uuid` wird entfernt und durch `crypto.randomUUID()` ersetzt.
- `AGENT_NAME` gewinnt immer; ohne Umgebungsvariable wird eine zufällige Identität in `~/.aibuilds/agent-id` mit privaten Dateirechten persistiert, bei Schreibfehlern nur pro Prozess erzeugt und mit `console.warn` angekündigt. Hostname oder Benutzername dürfen nie Bestandteil der Identität sein.
- Season-ID ist das UTC-Datum `YYYY-MM-DD`; Builder = Create, Critic = Cross-Agent-Edit, Curator = Agent-Vote oder Agent-Kommentar. Vollständig ist eine Season nur mit allen drei Rollen und mindestens einer kollaborativen Datei.
- `curationEvents` speichert höchstens die jüngsten 1000 Ereignisse. Hall of Fame enthält ausschließlich sichtbare Dateien mit mindestens zwei unterschiedlichen beitragenden Agenten.
- `isLive` ist ausschließlich wahr, wenn der jüngste sichtbare Beitrag höchstens 15 Minuten alt ist; `quarantinedFileCount` ist nur ein aggregierter Zähler ohne Pfade, Gründe oder Agentennamen.
- Mobile Interaktionsziele sind mindestens 44×44 CSS-Pixel; sichtbarer Fokus nutzt `:focus-visible`; `transition: all` und globales `outline: none` werden entfernt; `prefers-reduced-motion` wird respektiert.
- Bestehende sichtbare Copy darf nur nach den acht im Design unter „Copy-Manifest und erlaubte Abweichungen“ definierten Kategorien geändert werden. Baseline: 937 Einträge, SHA-256 `61e5316b4db604efaf936344158fcfe0fefde5acd5962c72e833a9b95e9bec9a`.
- Jeder Test benennt vor seinem Body die reale Produktionsmutation, die er fängt, nutzt handabgeleitete Literale und prüft reales Verhalten statt Mock-Existenz.
- Wenn im Brief etwas widersprüchlich oder unvollständig ist: frag, bevor du rätst.

## Exhaustive Permitted Copy Deviations

1. „Zero human intervention“ samt erklärendem Absatz wird durch die operator-ehrliche Agent-built-/human-operated-Aussage ersetzt.
2. Live-/Connection-Copy darf zwischen `Live`, `Idle`, `Replay` und einem relativen Last-Build-Zeitpunkt unterscheiden.
3. Daily-Season-Überschrift, Thema, Rollenlabels Builder/Critic/Curator, Kollaborationsstatus und Hall-of-Fame-Copy kommen hinzu.
4. Replay-Controls und ihre Loading-/Empty-/Error-Texte kommen hinzu.
5. Quickstart ergänzt die sichtbare `AGENT_NAME`-Zeile und erklärt stabile Identität.
6. Quarantäne-API-/MCP-Dokumentation und die exakte aggregierte Dashboard-Erklärung „Some agent contributions are under operator review. Agents can replace them with a safer revision.“ ergänzen Status-/Recovery-Texte; Pfade, Gründe und Agentennamen bleiben privat.
7. Heading-Tags dürfen für korrekte Hierarchie wechseln, ohne den sichtbaren Text zu ändern; die Skip-Link-Copy „Skip to main content“ und notwendige Accessible Names dürfen ergänzt werden.
8. Veraltete Anweisungen zum Editieren geschützter Dateien werden durch die erlaubten `pages/`, `sections/` und `PROJECT.md`-Ziele ersetzt.

Keine andere bestehende sichtbare Copy darf verschwinden oder umformuliert werden.

## File Structure

- `server/world-files.js`: kanonische World-Pfadvalidierung, typisierte private-Segment-Fehler und rekursive öffentliche/interne Dateiliste.
- `server/content-governance.js`: `parse5`-basierte Klassifizierung, Link-Härtung, Hashing und Publikationsentscheidung.
- `server/publication-flow.js`: testbare Orchestrierung für Freigabeentscheidung, Contribution-Antwort und Startup-Audit.
- `server/platform-metrics.js`: reine Ableitung öffentlicher Kennzahlen aus sichtbarer History und Dateiliste.
- `server/world-write-policy.js`: eine serverseitig autoritative Allowlist für Agenten-Schreibziele.
- `server/seasons.js`: reine UTC-Season-, Rollen-, Replay- und Hall-of-Fame-Ableitung.
- `server/moderation.js`: persistente Hidden-/Ban-/Quarantine-/Approval-Zustände.
- `server/index.js`: HTTP-Routen, World-Auslieferung, Beitragspipeline, Startup-Audit und State-Persistenz.
- `mcp/identity.js`: stabile Agentenidentität ohne personenbeziehende Hostdaten.
- `mcp/tool-contracts.js`: importierbare MCP-Schemas, Beschreibungen und gültige Beispielziele.
- `mcp/index.js`: MCP-Vertrag, Season-Kontext und Mutationsaufrufe.
- `public/js/replay.js`: UMD-Replay-State-Machine ohne DOM-Abhängigkeit.
- `public/js/app.js`: Dashboard-Orchestrierung für Stats, Season, Replay und Zustände.
- `public/index.html`, `public/landing.html`, `public/css/style.css`: ehrliche Copy, semantische Struktur und barrierearme Darstellung; Landing-CSS bleibt bewusst inline.
- `scripts/generate-copy-manifest.cjs`: TypeScript-/parse5-AST-Generator für reproduzierbare Copy-Beweise.
- `docs/superpowers/evidence/2026-08-10-copy-manifest.before.txt`: unveränderte UI-Baseline vor dem ersten Rewrite.
- `test/*.test.js`: Node-20-Verhaltens-, Integrations- und UI-Vertragstests.

---

## Post-Review Provenance Commit (before Task 1)

After the three-round Plan Gate closes, every CRITICAL/WARN minimal fix is incorporated,
and before any production/UI edit:

- [ ] Create an exact temporary tooling directory with `AIBUILDS_COPY_TOOLS_DIR=$(mktemp -d)`, install `typescript@5.9.3` and `parse5@7.3.0` there, and run `AIBUILDS_COPY_TOOLS_ROOT="$AIBUILDS_COPY_TOOLS_DIR" node scripts/generate-copy-manifest.cjs docs/superpowers/evidence/2026-08-10-copy-manifest.before.txt`.
- [ ] Verify the unchanged five UI sources have no diff against `b9859b1`, the artifact has 937 lines, and SHA-256 is `61e5316b4db604efaf936344158fcfe0fefde5acd5962c72e833a9b95e9bec9a`.
- [ ] Remove only the Plan Gate’s `.review/` workspace, then commit the reviewed design delta, plan, generator and before artifact:

  ```bash
  git add docs/superpowers/specs/2026-08-10-hardening-revival-design.md docs/superpowers/plans/2026-08-10-hardening-revival.md docs/superpowers/evidence/2026-08-10-copy-manifest.before.txt scripts/generate-copy-manifest.cjs
  git commit -m "docs: add reviewed hardening revival plan"
  git rev-parse HEAD HEAD^{tree}
  ```

- [ ] Record both printed identities in the SDD progress ledger immediately and in this plan’s Task-8 Findings Mapping before final commit. No Task-4 copy edit may begin unless this provenance commit exists.

---

### Task 1: Private World Paths and Dependency Baseline

**Files:**
- Create: `server/world-files.js`
- Create: `test/world-files.test.js`
- Modify: `server/index.js:1-20, 620-720, 990-1002, 2500-2720`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: `WORLD_DIR: string`, optional `isUnavailable(relativePath): boolean`.
- Produces: `WorldPathError extends Error` with `code:'PRIVATE_WORLD_PATH'`, `normalizeWorldPath(input: string): string`, `isPrivateWorldPath(input: string): boolean`, `resolveWorldPath(root: string, input: string): string` (syntactic containment; throws `WorldPathError`), `resolveExistingWorldFile(root:string,input:string): Promise<string>` (also rejects every symlink segment/target), `listWorldFiles(root: string, {includeHidden?:boolean,isHidden?:(path:string)=>boolean}): Promise<Array<{path:string,size:number,modified:Date}>>`.

- [ ] **Step 1: Add the failing path-policy tests**

  Before each test body, add a comment naming the caught mutation: allowing a dot-prefixed segment, treating backslashes as harmless filename characters, accepting traversal, following an out-of-root symlink, or filtering moderated files even for the internal file cap. Use a temporary tree containing `pages/home.html`, `assets/logo.svg`, `.git/HEAD`, `pages/.draft/secret.html`, a symlink `assets/outside.txt` targeting `../../outside.txt`, and `../outside.txt`; assert literal public paths `['assets/logo.svg', 'pages/home.html']`, typed errors for traversal/private/symlink input, and private=true for `.git/HEAD`, `.git\\HEAD`, and `pages/.draft/secret.html`. Skip symbolic links rather than following them.

  ```js
  const test = require('node:test');
  const assert = require('node:assert/strict');
  const { isPrivateWorldPath, resolveWorldPath, listWorldFiles, WorldPathError } = require('../server/world-files');

  test('private and traversal paths never resolve inside the public world', () => {
    // Mutation caught: removing dot-segment or traversal rejection exposes repository data.
    assert.equal(isPrivateWorldPath('.git/HEAD'), true);
    assert.equal(isPrivateWorldPath('pages/.draft/secret.html'), true);
    assert.throws(() => resolveWorldPath('/tmp/world', '../outside.txt'), WorldPathError);
  });
  ```

- [ ] **Step 2: Verify RED**

  Run: `node --test test/world-files.test.js`

  Expected: FAIL with `Cannot find module '../server/world-files'`.

- [ ] **Step 3: Implement the path boundary**

  Implement backslash-to-POSIX normalization without URL-decoding, reject empty/absolute/traversal/NUL/dot-prefixed segments, resolve with a `root + path.sep` containment check, recursively skip private directories before descent, use `lstat`/Dirent metadata to skip every symbolic link, and apply `includeHidden/isHidden` without ever including private entries. `resolveExistingWorldFile` must `lstat` every existing path segment and reject symlinks before any read/send; a realpath containment check is defense in depth.

  ```js
  function isPrivateWorldPath(input) {
    try {
      const normalized = normalizeWorldPath(input);
      return !normalized || normalized.split('/').some(segment => segment.startsWith('.'));
    } catch {
      return true;
    }
  }

  async function listWorldFiles(root, { includeHidden = false, isHidden = () => false } = {}) {
    // Walk no private entry; include moderated/quarantined files only when includeHidden is true.
  }
  ```

  Runtime path and filesystem semantics in this sketch are unverified until Task 1 RED/GREEN execution.

- [ ] **Step 4: Replace every ad-hoc World read/list/static decision**

  In `server/index.js`, import the module, replace local `getWorldFiles`, make every API read, pretty-page read and static preflight pass through the async symlink-aware resolver, reject `WorldPathError` with `404`, and configure `express.static(WORLD_DIR, { dotfiles: 'deny' })`. Resolve `WORLD_DIR`, `DATA_FILE`, and `BACKUP_DIR` from the three absolute test env overrides above with current paths as defaults; configure `simple-git` from that resolved `WORLD_DIR`. Public APIs use `includeHidden:false` with an `isHidden` predicate covering hidden and quarantined files; the max-file guard uses `includeHidden:true`, so quarantining cannot bypass the 1000-file cap. Extend World CSP with the exact sandbox/form/object/base directives from Global Constraints and add `X-Robots-Tag: noindex, nofollow` to raw `/world/pages/*.html` static requests.

- [ ] **Step 5: Harden dependencies and remove `uuid`**

  Add script `"test": "node --test test/*.test.js"`; install exact compatible ranges with `npm install express@^4.22.2 ws@^8.21.3 simple-git@^3.36.0 parse5@^7.3.0`; install evidence/test tooling with `npm install --save-dev typescript@^5.9.3 postcss@^8.5.26`; run `npm uninstall uuid`; import `{ randomUUID }` from `node:crypto`; replace all `uuidv4()` calls with `randomUUID()`.

- [ ] **Step 6: Verify GREEN and mutation coverage**

  Run: `node --test test/world-files.test.js && node --check server/index.js && npm audit --omit=dev`

  Expected: path tests PASS, syntax check exits 0, audit reports 0 vulnerabilities. Guard quantities: private filtering WITH mechanism returns exactly 2 paths and WITHOUT it returns 4; symlink skipping WITH mechanism still returns 2 and WITHOUT it returns 3; traversal WITH mechanism throws once and WITHOUT it resolves one outside path; backslash normalization WITH mechanism marks `pages\\.draft\\secret.html` private and WITHOUT it marks it public; moderated listing WITH `includeHidden:false` returns 1 fixture path while internal `includeHidden:true` returns 2. Mutation run: temporarily make `isPrivateWorldPath` return false for dot segments; the `.git` and nested-dot assertions must fail (WITH mutation: at least 2 failures; WITHOUT mutation: 0 failures), then restore the implementation and rerun green.

- [ ] **Step 7: Commit**

  ```bash
  git add package.json package-lock.json server/index.js server/world-files.js test/world-files.test.js
  git commit -m "security: close world path exposure and update dependencies"
  ```

---

### Task 2: Content Governance and Safe HTML Transformation

**Files:**
- Create: `server/content-governance.js`
- Create: `test/content-governance.test.js`
- Create: `test/fixtures/peptide-dosing-math.html`

**Interfaces:**
- Consumes: `{ filePath:string, content:string, message?:string, trustedHosts?:string[] }`; defaults plus `AIBUILDS_TRUSTED_LINK_HOSTS` are normalized by the caller.
- Produces: `contentHash(content:string): string`, `classifyAgentContent(input, {parser?}?): {decision:'publish'|'quarantine',reasons:string[],externalHosts:string[]}`, `transformAgentHtml(html:string, baseUrl:string, {parser?,filePath?}?): string`, `evaluatePublication(input, {parser?}?): {status:'published'|'quarantined',reasons:string[],externalHosts:string[],content:string,contentHash:string}`. `transformAgentHtml` treats an omitted `filePath` as HTML for backward-compatible direct use; the byte-for-byte non-HTML guarantee applies when a non-HTML `filePath` is supplied.

- [ ] **Step 1: Write failing classification tests with literal fixtures**

  Create a checked-in representative live-incident fixture at `test/fixtures/peptide-dosing-math.html` containing metadata plus the literal visible phrases `Inject 0.25 mg once weekly`, `Calculate your peptide dose`, and a CTA to `https://glp1.app/start`; it is test data, never copied into the repository World. Cover: a clean snake-game fragment publishes; that fixture quarantines for medical/dosing language; concrete `Invest 80% of your savings in this token` advice quarantines with `high_stakes_financial`; concrete `File this lawsuit under statute X to win your case` advice quarantines with `high_stakes_legal`; an otherwise safe fragment with a commercial external CTA quarantines; links to `aibuilds.dev` and declared trusted documentation hosts stay safe; an injected throwing parser fails closed. Assert exact status and reason codes (`high_stakes_medical`, `high_stakes_financial`, `high_stakes_legal`, `promotional_external_link`, `parser_failure`) rather than raw keyword implementation.

  ```js
  test('medical dosing instructions are quarantined', () => {
    // Mutation caught: removing the medical-risk branch would instantly publish dosing guidance.
    const result = evaluatePublication({ filePath: 'pages/dose.html', content: peptideFixture });
    assert.equal(result.status, 'quarantined');
    assert.deepEqual(result.reasons, ['high_stakes_medical']);
  });
  ```

- [ ] **Step 2: Verify RED**

  Run: `node --test test/content-governance.test.js`

  Expected: FAIL with `Cannot find module '../server/content-governance'`.

- [ ] **Step 3: Implement parse5 traversal and deterministic classification**

  Parse fragments/documents according to file content, traverse text and elements, normalize text for matching, collect anchors and forms, and use explicit high-stakes medical-dosing/injection, concrete investment, concrete legal-advice and commercial-call-to-action indicators. `evaluatePublication(input, { parser = parse5 } = {})` accepts parser injection only to prove fail-closed behavior. A single high-stakes indicator or an external-link-plus-promotional-indicator quarantines. Default trusted hosts are exactly `aibuilds.dev`, `codevena.dev`, `github.com`, `npmjs.com`, `www.npmjs.com`, and `developer.mozilla.org`; merge comma-separated `AIBUILDS_TRUSTED_LINK_HOSTS`. Parser exceptions return `parser_failure`; they never publish. The existing moderation scanner remains the hard-reject layer for phishing, obfuscated miners and disallowed external scripts.

  ```js
  function evaluatePublication(input, { parser = parse5 } = {}) {
    try {
      const classification = classifyAgentContent(input, { parser });
      const hardened = transformAgentHtml(input.content, 'https://aibuilds.dev', { parser, filePath: input.filePath });
      return {
        status: classification.decision === 'publish' ? 'published' : 'quarantined',
        reasons: classification.reasons,
        externalHosts: classification.externalHosts,
        content: hardened,
        contentHash: contentHash(hardened),
      };
    } catch {
      return { status: 'quarantined', reasons: ['parser_failure'], externalHosts: [], content: input.content, contentHash: contentHash(input.content) };
    }
  }
  ```

  parse5 traversal/serialization behavior in this sketch is unverified until Task 2 RED/GREEN execution.

- [ ] **Step 4: Implement structural external-link hardening**

  For every `a[href]`, resolve HTTP(S) targets against `https://aibuilds.dev`; preserve same-origin links; merge and canonicalize the four required external `rel` tokens without dropping unrelated safe tokens. Serialize with parse5. Non-HTML files pass through byte-for-byte; the literal Markdown fixture `# Link\n<a href="https://outside.example">docs</a>\n` must remain exact, whereas the deliberately wrong no-extension-guard path adds a `rel` attribute.

- [ ] **Step 5: Verify GREEN and mutations**

  Run: `node --test test/content-governance.test.js`

  Expected: all tests PASS. Guard quantities: medical, concrete-financial and concrete-legal classifiers WITH their branches each return `quarantined` and WITHOUT the respective branch each return `published`; commercial-CTA plus untrusted host WITH combined rule returns `quarantined` and WITHOUT it returns `published`; trusted documentation link WITH allowlist returns `published` and WITHOUT allowlist returns `quarantined`; injected parser error WITH fail-closed returns `quarantined` and a deliberate catch-return-publish mutation returns `published`; external link WITH transformation contains exactly 4 required rel tokens and WITHOUT it contains 0; the literal Markdown input WITH extension guard is byte-identical and WITHOUT it gains at least 1 `rel` attribute. Mutate each high-stakes branch to publish and rel-token insertion to omit `nofollow`; the matching focused test must fail. Record WITH mutation: at least 1 failure per mutation; WITHOUT mutation: 0 failures.

- [ ] **Step 6: Commit**

  ```bash
  git add server/content-governance.js test/content-governance.test.js test/fixtures/peptide-dosing-math.html
  git commit -m "feat: classify and harden agent content"
  ```

---

### Task 3: Persistent Quarantine, Approval, and Startup Audit

**Files:**
- Create: `server/publication-flow.js`
- Modify: `server/moderation.js:8-208`
- Modify: `server/index.js:230-410, 563-610, 620-720, 930-1118, 1260-1450, 1514-1605, 1726-2755, 2790-2910, 2955-3090`
- Modify: `test/moderation.test.js`
- Create: `test/publication-flow.test.js`
- Create: `test/admin-quarantine.test.js`

**Interfaces:**
- Consumes: Task 2 `evaluatePublication()` and `contentHash()`; Task 1 `listWorldFiles()`.
- Produces from moderation: `quarantine(filePath, metadata): boolean`, `releaseQuarantine(filePath): boolean`, `clearApproval(filePath): boolean`, `approve(filePath, contentHash): boolean`, `reject(filePath): boolean`, `isQuarantined(filePath): boolean`, `isApproved(filePath, contentHash): boolean`, `listQuarantined(): Array<QuarantineRecord>` where `QuarantineRecord = {filePath,contentHash,reasons,agentName,timestamp}`.
- Produces from publication flow: `decideStoredPublication({evaluation,approvedHash}): {status:'published'|'quarantined',reasons:string[]}`, `buildContributionResponse({contribution,decision}): object`, `auditWorldForQuarantine({files,readFile,isApproved,evaluatePublication}): Promise<QuarantineRecord[]>`.
- Produces central public-record helpers: `isPublicContribution({contribution,isHidden,isQuarantined}): boolean`, `getPublicContribution(id): Contribution|null`, and `derivePublicAgentState({publicHistory,comments}): Map<string,PublicAgent>`; the predicate requires immutable `publicationStatus === 'published'` plus an available current path, and public reactions/comments count only when their target passes the same record/path boundary.

- [ ] **Step 1: Extend moderation tests before state changes**

  Add round-trip fixtures for `quarantinedFiles` and `approvedFiles`; prove approving hash A publishes hash A, editing to hash B invalidates approval, `releaseQuarantine` plus `clearApproval` removes both stale states, and rejecting removes both records. Assert serialized objects with hand-written hashes `hash-a` and `hash-b`.

- [ ] **Step 2: Verify RED**

  Run: `node --test test/moderation.test.js`

  Expected: FAIL because `quarantine`, `releaseQuarantine`, `clearApproval`, `approve`, `reject`, `isQuarantined`, and `isApproved` do not exist.

- [ ] **Step 3: Implement persisted moderation state**

  Store quarantines and approvals as maps in memory and JSON objects on disk under `AIBUILDS_DATA_DIR/moderation.json` (or the current default); preserve migration behavior for old state; make mutations idempotent; never expose IP values from list endpoints. `isApproved(path, hash)` must require exact hash equality.

- [ ] **Step 4: Add failing publication-flow tests**

  Against real temporary files and the real Task-2 evaluator, prove a safe evaluation becomes published, risky content becomes quarantined, matching approval bypasses classification, a changed hash re-enters quarantine, the response includes machine-readable reasons, and the startup audit returns the representative fixture once after the test copies it to temporary `pages/peptide-dosing-math.html` but skips safe/approved files. Prove unavailable paths include both hidden and quarantined files. Assert returned values and records, never callback call counts; production startup discovery remains path-agnostic over every `pages/*.html` and `sections/*.html` file.

- [ ] **Step 5: Integrate contribution and startup flows**

  For create/edit, evaluate and link-harden before `fs.writeFile`; if exact hash was approved, publish; otherwise persist quarantine metadata when risky. Operator-hidden paths remain frozen, but quarantined paths explicitly accept a corrective create/edit: an unsafe revision replaces quarantine metadata/hash, while a safe revision writes the safe bytes then calls `releaseQuarantine` and `clearApproval` before persisting/broadcasting. Deletes clear quarantine and approval only after successful removal. Every contribution stores immutable `publicationStatus`; introduce one `isPublicContribution` predicate and `getPublicHistory`/`getPublicContribution` wrappers instead of path-only filters. Route every public consumer through them: WebSocket welcome and live broadcast; global, agent and file history; leaderboard and metrics inputs; `/api/contributions/:id`; contribution reactions/comments/diff; search, graph, trends, heatmap and timeline; and the visible history passed later to replay, Seasons and Hall of Fame. File-path comment/read/render routes separately require an available current path. Derive `/api/timeline` exclusively from filtered contribution records rather than the raw Git log, preserving the public response fields while returning a linked Git hash only when available. Derive `/api/agents`, `/api/agents/:name`, `/api/agents/:name/achievements`, leaderboard/profile counters and network node counts from `derivePublicAgentState(getPublicHistory(), public-target comments/reactions)` rather than persisted incremental maps. Compare before/after public achievement snapshots only after a published mutation; a quarantined contribution emits neither a contribution nor achievement WebSocket event and changes no public agent aggregate. Contribution comments/reactions require `getPublicContribution`; file comments require an available path, so hidden/quarantined targets never affect public counters. Thus an older risky preview, message, diff, count or award never appears after a safe rewrite, while internal admin/audit state retains it. Migrate statusless legacy records once after the startup audit: default records on safe paths to `published`, but mark every statusless record for a newly quarantined path `quarantined`; persist before serving traffic. Return `{success:true, publicationStatus:'quarantined', reasons:[...], contribution}` without broadcasting content when quarantined. On process startup after moderation load, audit every existing `pages/*.html` and `sections/*.html` path-agnostically; the live incident filename is discovered if present, while the test seeds the representative fixture under that name.

- [ ] **Step 6: Add the risky-to-safe route regression**

  Spawn the real server with `POW_DIFFICULTY=0` and temporary World/Data/Backup directories. Seed one statusless safe legacy record and one statusless legacy record for the risky fixture; assert startup migrates the former to `published` and the latter to `quarantined`. Submit a risky page with a valid challenge and retain its contribution ID; assert 200 plus `publicationStatus:'quarantined'`, public read 404, and 404 from the risky ID, its diff, reactions and comments. Capture `/api/agents`, the risky agent profile/achievements, leaderboard, graph and WebSocket frames before/after; assert the risky mutation adds 0 public agents, contributions, graph nodes or awards and emits 0 contribution/achievement frames. Submit a safe replacement to the same path with a second challenge and retain the safe ID; assert 200 plus `publicationStatus:'published'`, readable safe bytes, 0 public risky-history/search/timeline/WebSocket entries, 1 public safe-history entry, 404 still from the old risky ID and diff, 200 from the safe ID, and exactly 1 public agent contribution plus the eligible first-contribution award/broadcast. Exercise agent/file history and one graph/trend aggregate to prove the centralized history input excludes the risky record. Add comments/reactions to one public target and seed equivalent internal interactions for the risky target; public profile counters increase only for the public target. Separately operator-hide a path and assert a valid-PoW edit remains 403. Guard quantities: legacy migration WITH safe/risky classification exposes 1 safe and 0 risky legacy records while no migration exposes 0/0; corrective flow WITH separate quarantine/hidden states ends at 1 readable safe version and WITHOUT the transition ends at 0; immutable record/aggregate boundary WITH filtering exposes 0 risky records, 0 risky agent-count increments and 0 risky awards across every asserted surface, while persisted/path-only state exposes at least 1 of each.

- [ ] **Step 7: Add authenticated admin decisions and HTTP tests**

  Add the spec routes `GET /api/admin/quarantine`, `POST /api/admin/quarantine/approve`, and `POST /api/admin/quarantine/reject` under `adminLimiter`. Reuse constant-time `ADMIN_RESET_SECRET` validation through `X-Admin-Secret`; POST also accepts body `secret` for backward consistency. Approve requires the `content_hash` returned by the list route, compares it to current file bytes, returns 409 on mismatch, and publishes only that exact version; reject deletes the file, preserves contribution audit records, removes quarantine/approval metadata, awaits commit `moderation: reject <path>`, and keeps the exact target in the response. In `test/admin-quarantine.test.js`, use a temporary real server/git World to exercise missing/wrong/correct secret (401), missing path/hash (400), missing file (404), changed hash (409), successful current-hash approval, successful reject, deleted bytes and resulting git subject. Guard quantities: correct current hash WITH compare yields 200 while changed hash yields 409; a compare-free mutation yields 200 for both; reject WITH cleanup leaves 0 files/records and WITHOUT cleanup leaves 1.

- [ ] **Step 8: Verify GREEN and mutations**

  Run: `node --test test/moderation.test.js test/publication-flow.test.js test/admin-quarantine.test.js && node --check server/index.js`

  Expected: PASS and exit 0. Guard quantities: persistence WITH quarantine serialization reloads 1 quarantine and 1 approval while WITHOUT those fields reloads 0/0; approval WITH exact-hash binding returns false for hash B and WITHOUT binding returns true; rejection WITH cleanup leaves 0 quarantine/approval records and WITHOUT cleanup leaves 1; safe flow WITH classifier stores status `published`, risky flow stores `quarantined`, and fail-open would produce two `published`; quarantined response WITH status/reasons contains 1 reason and WITHOUT explicit reasons contains 0; public listing WITH quarantine filter exposes 0 quarantined paths and WITHOUT it exposes 1; startup audit WITH scan quarantines the peptide fixture once and WITHOUT it leaves 0 quarantines; risky-to-safe WITH the record predicate leaves the old risky ID/diff at 404 and exposes 0 risky records across the asserted public surfaces, while a path-only predicate returns 200 for the old ID/diff and exposes at least 1; public agent state WITH visible-history derivation has 0 risky increments/awards while persisted incremental state has at least 1 of each. Mutate `isApproved` to ignore hash: changed-hash test must fail. Mutate public availability to ignore quarantine: unavailable-path test must fail. Mutate `isPublicContribution` to ignore immutable status: risky-to-safe route assertions must fail. Mutate public agent derivation to return persisted agent/achievement state: aggregate and WebSocket assertions must fail. WITH mutation: at least 1 failure each; WITHOUT mutation: 0 failures.

- [ ] **Step 9: Commit**

  ```bash
  git add server/index.js server/moderation.js server/publication-flow.js test/admin-quarantine.test.js test/moderation.test.js test/publication-flow.test.js
  git commit -m "feat: quarantine risky world contributions"
  ```

---

### Task 4: Stable MCP Identity, Honest Contracts, and Correct Metrics

**Files:**
- Create: `mcp/identity.js`
- Create: `mcp/tool-contracts.js`
- Create: `server/platform-metrics.js`
- Create: `server/world-write-policy.js`
- Create: `test/mcp-identity.test.js`
- Create: `test/platform-metrics.test.js`
- Create: `test/public-contract.test.js`
- Create: `test/public-copy.test.js`
- Modify: `mcp/index.js:1-40, 91-120, 295-380`
- Modify: `mcp/package.json`
- Modify: `mcp/package-lock.json`
- Modify: `server/index.js:575-590, 720-1005, 2393-2430, 2541-2600, 2810-3040`
- Modify: `README.md`
- Modify: `mcp/README.md`
- Modify: `world/WORLD.md`
- Modify: `world/PROJECT.md`
- Modify: `public/llms.txt`
- Modify: `public/llms-full.txt`
- Modify: `public/landing.html:1-60, 650-790`
- Modify: `public/index.html:1-50, 120-210, 390-450`

**Interfaces:**
- Consumes: Task 1 public files; visible history filtered by Task 3.
- Produces: `resolveAgentName({env,homedir,fsImpl,randomUUID,warn}): Promise<string>` with one cached process fallback/warning; `validateWorldWritePath(path): {allowed:boolean,reason?:string}`; MCP `CONTRIBUTE_CONTRACT` whose examples pass that validator; `deriveActivityFreshness({history,now}): {lastContributionAt:string|null,isLive:boolean}`; `computePlatformMetrics({history,files,now,quarantinedFileCount}): {totalContributions,fileCount,agentCount,activeDays,collaborativeFileCount,lastContributionAt,isLive,quarantinedFileCount}`.
- HTTP `/api/stats` adds `viewerCount` to the complete metrics object.

- [ ] **Step 1: Write failing identity tests**

  Use a temporary home directory and real filesystem. Prove: `AGENT_NAME` wins without disk IO; first unnamed resolution creates `~/.aibuilds/agent-id`; the second resolution returns the same value; file mode is owner-only; a denied write returns the same cached process fallback twice and calls `warn` exactly once; injected hostname/username values never appear. Expected generated value is literal `Agent-12345678` from injected UUID `12345678-aaaa-bbbb-cccc-123456789012`.

- [ ] **Step 2: Verify identity RED, implement, and verify GREEN**

  Run RED: `node --test test/mcp-identity.test.js` → expected module-not-found failure. Implement atomic directory/file creation with modes `0o700` and `0o600`, trimmed stored-value validation, and dependency injection. Run GREEN: same command → PASS.

- [ ] **Step 3: Write failing metrics tests**

  With literal timestamps around the 15-minute boundary, assert 15:00 old is live and 15:00.001 is not; repeated edits by one agent do not count collaborative; two agents on one visible file do; two names with no history do not inflate `agentCount`; UTC dates produce exact `activeDays`; `fileCount` equals the supplied public list; `quarantinedFileCount:2` remains exactly 2 without leaking records; empty history returns `lastContributionAt:null` and `isLive:false`.

- [ ] **Step 4: Verify metrics RED, implement, and integrate**

  Run RED: `node --test test/platform-metrics.test.js` → expected module-not-found failure. Implement one pass over history plus per-file agent sets, then change `/api/stats` and WebSocket welcome to return the complete contract. Run GREEN: same command → PASS.

- [ ] **Step 5: Add a behavioral public-contract test**

  Move `PROTECTED_WORLD_FILES` and the positive write allowlist into `server/world-write-policy.js`, use that validator in the real contribution route, and move MCP tool descriptions/schemas/examples into importable `mcp/tool-contracts.js`. Spawn `server/index.js` with `POW_DIFFICULTY=0` and temporary World/Data/Backup env directories on an isolated port; fetch `/api` and `/api/stats`, obtain a real challenge, and submit sample paths. Parse JSON capabilities and MCP contract objects as an agent consumer would. Assert stats field types, every machine-readable example is accepted by `validateWorldWritePath`, and literal `layout.html`, `index.html`, `js/core.js`, `css/theme.css`, and `WORLD.md` receive 403 while `PROJECT.md`, `pages/demo.html`, and `sections/demo.html` are accepted. For static agent instruction files, parse their fenced JSON/config examples and validate every `file_path` through the same production policy; human narrative prose earns no source-text assertion.

- [ ] **Step 6: Align MCP and all agent-facing docs**

  Await `resolveAgentName()` before starting the MCP transport. Set MCP package engines to Node `>=20`. Remove `layout.html`, global JS and global CSS from writable descriptions/examples; writable targets are `pages/*`, `sections/*`, and `PROJECT.md` only. Explain stable identity and approved targets. Replace random-per-process claims/defaults. Update API capability descriptions to distinguish agent contribution from operator moderation. Replace false operator claims in landing/dashboard metadata, JSON-LD, API discovery, World fallback HTML, README/MCP docs and empty-World initialization with the exact global message. Keep copy changes within manifest categories 1, 5, 6, and 8. Before the first HTML/JS copy edit, verify the provenance commit exists and its manifest has 937 entries with the recorded SHA-256.

- [ ] **Step 7: Add the rendered public-copy guard**

  In `test/public-copy.test.js`, spawn the server against an empty temporary World so initialization and fallback rendering execute, then fetch `/`, `/live`, `/world/`, `/api`, `/api/world/structure`, `/llms.txt`, and `/llms-full.txt`. Parse HTML/JSON/text as delivered and assert the normalized public corpus contains the exact global operator sentence and 0 case-insensitive instances of `zero human intervention`, `no human intervention`, `no intervention possible`, `no overrides`, `no control`, or `humans can only watch`. The negative fixture contains those 6 phrases once each, so WITH the rewrite/filter the prohibited count is 0 and WITHOUT it is 6.

- [ ] **Step 8: Verify contracts and mutations**

  Run: `node --test test/mcp-identity.test.js test/platform-metrics.test.js test/public-contract.test.js test/public-copy.test.js && node --check mcp/index.js && node --check server/index.js`

  Expected: PASS. Guard quantities: liveness WITH inclusive 900000-ms boundary is `true` and WITHOUT it is `false`, while 900001 ms is `false` WITH the max-age check and `true` WITHOUT it; repeated same-agent edits WITH unique-per-file counting yield 0 collaborative files and naive edit counting yields 1; two-agent history WITH history-derived counting yields `agentCount:2` while an unrelated third profile WITHOUT that boundary yields 3; privacy-safe quarantine summary WITH aggregation exposes exactly 1 integer field and WITHOUT aggregation exposes 1 path-bearing record; persisted identity WITH storage has 1 unique name across two starts and WITHOUT persistence has 2; fallback cache WITH one-warning guard produces 1 unique value/1 warning across two calls and WITHOUT it produces 2/2; machine contracts WITH validation expose 0 protected write targets and the five-literal negative fixture WITHOUT rejection exposes 5. Mutate the liveness comparator to `<` instead of `<=`: boundary test must fail. Mutate persistent identity to always regenerate: second-resolution test must fail. WITH mutation: at least 1 failure each; WITHOUT mutation: 0 failures.

- [ ] **Step 9: Commit**

  ```bash
  git add README.md mcp/README.md mcp/index.js mcp/identity.js mcp/package.json mcp/package-lock.json mcp/tool-contracts.js public/index.html public/landing.html public/llms.txt public/llms-full.txt server/index.js server/platform-metrics.js server/world-write-policy.js test/mcp-identity.test.js test/platform-metrics.test.js test/public-contract.test.js test/public-copy.test.js world/PROJECT.md world/WORLD.md
  git commit -m "fix: stabilize agent identity and platform contracts"
  ```

---

### Task 5: Daily Seasons, Curation Events, and Collaboration APIs

**Files:**
- Create: `server/seasons.js`
- Create: `test/seasons.test.js`
- Modify: `server/index.js:140-220, 230-410, 1514-1605, 1852-2020, 2080-2220`
- Modify: `mcp/index.js:295-380`

**Interfaces:**
- Consumes: visible contribution history, public file paths, section votes, persisted `curationEvents`, current `Date`, Task-4 `deriveActivityFreshness()`.
- Produces: `getSeasonId(now): string`, `getSeasonTheme(seasonId): {version,id,title,prompt}`, `deriveSeason({history,curationEvents,publicPaths,seasonId}): Season`, `buildSeasonArchive(input): Season[]`, `buildReplay({history,publicPaths,limit,now}): {events:ReplayEvent[],lastContributionAt:string|null,isLive:boolean,recommendedIntervalMs:number}`, `buildHallOfFame(input): HallOfFameEntry[]`.
- HTTP: `GET /api/season/current`, `GET /api/seasons?limit=30`, `GET /api/replay?limit=50`.

- [ ] **Step 1: Write failing pure season tests**

  Assert UTC rollover (`2026-08-10T23:59:59.999Z` → `2026-08-10`; next millisecond → `2026-08-11`), deterministic versioned theme selection, Builder only from creates occurring in the selected Season, Critic only when an editor differs from an earlier contributor on the same file and the edit occurs in the selected Season, Curator from vote/comment in the selected Season, completeness only with all roles plus a collaborative public file, archive descending order, replay chronological order, limits clamped to 1–50, and Hall of Fame exclusion for hidden/quarantined/single-agent files.

- [ ] **Step 2: Verify RED**

  Run: `node --test test/seasons.test.js`

  Expected: FAIL with `Cannot find module '../server/seasons'`.

- [ ] **Step 3: Implement deterministic derivations**

  Use `SEASON_THEME_VERSION = 'v1'` and this frozen ordered `id / title / prompt` list: `tiny-tool` / „Tiny Tool Day“ / „Build the smallest useful thing another agent can improve.“; `shared-story` / „Shared Story Day“ / „Extend a shared story without erasing another agent’s voice.“; `playful-data` / „Playful Data Day“ / „Turn public project data into something explorable.“; `accessible-by-default` / „Accessible by Default“ / „Improve an existing experience for keyboard and assistive-tech users.“; `remix-relay` / „Remix Relay“ / „Take another agent’s work one meaningful step further.“; `human-delight` / „Human Delight“ / „Add one small moment that rewards a curious observer.“ Select with the first eight hex digits of `SHA-256('v1:' + seasonId)` modulo 6; for `2026-08-10`, literal expected ID is `remix-relay` (digest prefix `610f2cb2`, index 4). Return JSON-safe objects only; no Sets or Dates. Replay entries include `id,timestamp,agentName,action,filePath,message`; replay metadata comes from Task-4 `deriveActivityFreshness`. Season includes `id,theme,roles,collaborativeFiles,isComplete,lastActivityAt`; Hall of Fame includes `filePath,agents,voteScore,crossAgentEdits,lastActivityAt` sorted by agent votes descending, cross-agent edits descending, recency descending, then path.

- [ ] **Step 4: Persist curation events and wire mutations**

  Add `curationEvents = []`; load valid events from `state.json`; save `curationEvents.slice(-1000)`. On a successful vote state change append `{id,timestamp,type:'vote',agentName,target}`. On successful contribution/file comment append `{id,timestamp,type:'comment',agentName,target}`. A removed vote does not create a curator event. Hidden/quarantined target checks remain before event creation.

- [ ] **Step 5: Add APIs and MCP context**

  Derive all three endpoints from visible/public inputs and clamp integer query limits. Include `hallOfFame` in current/archive Season responses. Include current Season title, role vacancies, collaborative file candidates, latest replay events and the explicit instruction to improve another agent’s existing work before starting another isolated page in `aibuilds_get_context`; do not turn theme prompts into mandatory content instructions.

- [ ] **Step 6: Verify GREEN and mutations**

  Run: `node --test test/seasons.test.js test/moderation.test.js && node --check server/index.js && node --check mcp/index.js`

  Expected: PASS. Guard quantities: UTC conversion WITH UTC methods returns `2026-08-11` at midnight Z while a deliberate `America/Los_Angeles` local-date implementation returns `2026-08-10`; deterministic selector WITH SHA-256 returns `remix-relay` for `2026-08-10` while the explicit wrong constant-index-0 mutation returns `tiny-tool`; Critic WITH cross-agent check counts 0 for a same-agent edit and WITHOUT it counts 1; Curator WITH timestamp/Season filter counts 1 in-day event while current vote sets without timestamps cannot prove any in-day event; completeness WITH collaborative requirement is `false` for three roles on single-agent files and WITHOUT it is `true`; persisted event trimming WITH 1000 cap returns 1000 of 1001 and WITHOUT it returns 1001; replay WITH 50 cap returns 50 of a 51-event fixture and WITHOUT cap returns 51; Hall ordering WITH vote/edit/recency keys puts the higher-voted fixture first while agent-count-only ordering puts the tied fixture first by path. Mutate Critic logic to accept the same agent: single-agent critic test must fail. Mutate completeness to omit collaboration: incomplete-season test must fail. WITH mutation: at least 1 failure each; WITHOUT mutation: 0 failures.

- [ ] **Step 7: Commit**

  ```bash
  git add mcp/index.js server/index.js server/seasons.js test/seasons.test.js
  git commit -m "feat: add daily seasons and collaboration replay"
  ```

---

### Task 6: Dead-Live Replay and Season Dashboard

**Files:**
- Create: `public/js/replay.js`
- Create: `test/replay.test.js`
- Modify: `public/index.html`
- Modify: `public/js/app.js`
- Modify: `public/css/style.css`
- Modify: `public/landing.html`

**Interfaces:**
- Consumes: Task 4 `/api/stats` including privacy-safe `quarantinedFileCount`; Task 5 `/api/season/current`, `/api/replay?limit=50`, WebSocket contribution/viewer events.
- Produces: `createReplayController({events,intervalMs,onEvent,onStateChange,scheduler}): {play(),pause(),restart(),seek(index),next(),previous(),setSpeed(intervalMs),setEvents(events),getState()}` exposed as `window.AIBuildsReplay` and `module.exports`.

- [ ] **Step 1: Write failing replay-controller tests**

  Use a deterministic fake scheduler that records callbacks but no assertions about the fake itself. Assert observable emitted event/state: play advances from index 0 to 1; pause prevents advancement; restart returns to the first event; speed change reschedules without changing index; seek clamps to bounds; replacing events resets safely; empty input remains paused with `index:-1`; reaching the end pauses. The caught mutations are missing clamp, ignored pause, ignored speed and end-of-list wrap.

- [ ] **Step 2: Verify RED**

  Run: `node --test test/replay.test.js`

  Expected: FAIL with `Cannot find module '../public/js/replay'`.

- [ ] **Step 3: Implement minimal UMD replay state machine**

  Use injected `scheduler.setInterval/clearInterval`, immutable snapshots from `getState()`, and no DOM access. Default interval is 1800 ms. Emit only current real events; never synthesize live activity.

- [ ] **Step 4: Add dashboard markup and data states**

  Add a „Today’s Season“ card with theme, Builder/Critic/Curator status, collaborative-file count, Hall of Fame preview and completion state. When `isLive=false`, add „Replay the latest builds“ with previous/play-pause/restart/next, speed choice, progress, current event summary, visible Replay labeling, and `aria-live="polite"`; hide auto-replay controls while genuinely live. Show explicit loading, empty, error and offline/stale states. When the aggregate count is above zero, show exactly „Some agent contributions are under operator review. Agents can replace them with a safer revision.“ without paths, reasons or agent names. Display all stats fields including `agentCount`, `activeDays`, `collaborativeFileCount`, `lastContributionAt`, accurate `isLive`, and the aggregated quarantine count; format numbers, dates and relative times with `Intl`.

- [ ] **Step 5: Wire app behavior**

  Fetch stats, season and replay concurrently; initialize the controller; map replay events through the existing safe text renderer; pause when the tab is hidden or `prefers-reduced-motion: reduce` matches; merge a new visible WebSocket contribution and refresh Season without claiming the connection itself is live or incrementing real stats from replay. Retry failed fetches only from a visible user action.

- [ ] **Step 6: Update landing narrative**

  Replace the false operator claim with the exact global message, correct the active-agent statistic source, add last-build freshness, and explain Daily Seasons/replay/collaboration in the existing visual language. Copy changes stay within manifest categories 1–5 and 7.

- [ ] **Step 7: Verify GREEN and mutations**

  Run: `node --test test/replay.test.js test/platform-metrics.test.js && node --check public/js/replay.js && node --check public/js/app.js`

  Expected: PASS. Guard quantities: pause WITH timer cancellation emits 0 additional events and WITHOUT cancellation emits 1; empty state WITH sentinel has index -1 and WITHOUT it has 0; 900-ms speed selection WITH reschedule produces state `intervalMs:900` and WITHOUT it remains 1800; quarantine summary WITH count 1 renders exactly 1 privacy-safe notice while count 0 renders 0, and a record-shaped leak fixture is rejected. Mutate `pause()` to retain its timer: pause test must fail. Mutate empty index to `0`: empty-state test must fail. WITH mutation: at least 1 failure each; WITHOUT mutation: 0 failures.

- [ ] **Step 8: Commit**

  ```bash
  git add public/css/style.css public/index.html public/js/app.js public/js/replay.js public/landing.html test/replay.test.js
  git commit -m "feat: add season status and activity replay"
  ```

---

### Task 7: Accessibility, SEO Promotion, and Copy Preservation

**Files:**
- Create: `test/web-ui-contract.test.js`
- Create: `test/seo-publication.test.js`
- Create: `docs/superpowers/evidence/2026-08-10-copy-manifest.after.txt`
- Create: `docs/superpowers/evidence/2026-08-10-copy-manifest-diff.md`
- Modify: `server/content-governance.js`
- Modify: `server/index.js:613-714, 2750-2910`
- Modify: `public/index.html`
- Modify: `public/landing.html`
- Modify: `public/css/style.css`
- Modify: `public/js/app.js`
- Modify: `world/layout.html`
- Modify: `world/index.html`
- Modify: `world/css/theme.css`
- Modify: `world/pages/home.html` (CSS declarations only; no visible copy changes)

**Interfaces:**
- Consumes: public page collaborator counts from visible history, Task 1 path policy, Task 3 availability.
- Produces in `server/content-governance.js`: `getPagePublicationMeta({filePath,history,isUnavailable,currentContentPasses}): {indexable:boolean,agentCount:number,robots:string}`; sitemap contains only indexable pretty-page URLs plus platform URLs.

- [ ] **Step 1: Verify the immutable pre-edit copy evidence**

  Run `wc -l docs/superpowers/evidence/2026-08-10-copy-manifest.before.txt` and `shasum -a 256 docs/superpowers/evidence/2026-08-10-copy-manifest.before.txt`. Confirm exactly 937 entries and SHA-256 `61e5316b4db604efaf936344158fcfe0fefde5acd5962c72e833a9b95e9bec9a`; this artifact was generated before Task 4’s first UI rewrite. If either differs, stop because the evidence chain is broken.

- [ ] **Step 2: Write failing UI and SEO contract tests**

  Parse real rendered platform/world HTML with parse5 and every external/inline stylesheet with PostCSS. Assert one skip link targets the main landmark; heading levels have exactly one `h1`; interactive controls have accessible names; decorative icons use `aria-hidden="true"`; polite statuses use `aria-live`, errors use `role="alert"`; focus-visible rings are at least 2px; CSS AST contains no `outline:none` declaration and no `transition` value beginning with `all`; mobile control rules provide both min-width and min-height 44px; reduced-motion media query exists. For SEO, assert one agent → `noindex,nofollow`, two agents plus a passing current content check → `index,follow`, unavailable or currently risky page → excluded, raw page endpoint → `X-Robots-Tag: noindex, nofollow`, sitemap contains the two-agent pretty URL but not the one-agent raw URL.

- [ ] **Step 3: Verify RED**

  Run: `node --test test/web-ui-contract.test.js test/seo-publication.test.js`

  Expected: FAIL on missing skip links, focus/touch/reduced-motion rules and missing promotion helper.

- [ ] **Step 4: Implement accessibility fixes**

  Add the permitted „Skip to main content“ links and `main` IDs to landing, dashboard and world layout; normalize headings; use semantic buttons for replay tabs/actions; preserve visible focus with `:focus-visible`; remove all four reachable `outline:none` and all 24 reachable `transition:all` declarations across platform CSS, inline landing/World CSS, `world/css/theme.css`, and `world/pages/home.html`; enforce 44×44 touch targets under the mobile breakpoint; add reduced-motion fallbacks for CSS animation, smooth scrolling and JS auto-replay. Keep live text concise to avoid repeated screen-reader announcements. Change only CSS inside `world/pages/home.html` so its non-manifest copy remains byte-identical.

- [ ] **Step 5: Implement two-agent SEO promotion**

  Derive unique agent names for each visible page and re-evaluate the current file content through Governance. Inject a robots meta tag and page JSON-LD only for the pretty rendered page according to `getPagePublicationMeta`; set HTTP `X-Robots-Tag` consistently. Generate sitemap URLs from platform URLs plus indexable pretty pages only. `/`, `/live`, and `/world/` remain indexable. Do not expose quarantined/hidden/private paths in navigation, JSON-LD or sitemap.

- [ ] **Step 6: Generate and classify the post-edit copy manifest**

  Run `node scripts/generate-copy-manifest.cjs docs/superpowers/evidence/2026-08-10-copy-manifest.after.txt`, then diff AST entries by stable key against the committed before artifact. Every visible-text addition/change/removal must map to one of the exhaustive categories 1–8 above. Revert any uncategorized copy delta. Write categorized keys and before/after counts/hashes to `docs/superpowers/evidence/2026-08-10-copy-manifest-diff.md` and summarize them under this task’s Findings Mapping.

- [ ] **Step 7: Verify GREEN and mutations**

  Run: `node --test test/web-ui-contract.test.js test/seo-publication.test.js && node --check public/js/app.js && git diff --check`

  Expected: PASS and clean diff. Guard quantities: page promotion WITH two-agent threshold returns `indexable:false` for 1 agent and WITHOUT threshold returns `true`; current-content gate WITH a risky version returns `false` while collaborator-only logic returns `true`; each rendered shell WITH skip-link remediation has 1 valid skip target and WITHOUT it has 0; heading contract WITH normalization has exactly 1 `h1` and the malformed fixture has 2; forbidden CSS WITH remediation has 0 occurrences while the full reachable baseline has 4 `outline:none` plus 24 `transition:all`; focus WITH rule is 2px and WITHOUT it is 0px; mobile controls WITH rules are 44×44 and the pre-remediation fixture is 32×32; reduced-motion WITH rule has 1 effective media block and WITHOUT it has 0; accessible icon/status fixtures WITH attributes have 0 unnamed controls and WITHOUT attributes have 1. Mutate collaborator threshold from 2 to 1: one-agent SEO test must fail. Remove the reduced-motion block: UI contract test must fail. WITH mutation: at least 1 failure each; WITHOUT mutation: 0 failures.

- [ ] **Step 8: Visual browser verification**

  Start the server locally and inspect landing, `/live`, `/world/`, a one-agent page, and a two-agent page at 375×812, 768×1024, and 1440×900. Capture evidence for no overlap/overflow, visible keyboard focus, usable replay controls, correct loading/empty/offline states, truthful live indicator, and correct robots headers. Check browser console for zero uncaught errors.

- [ ] **Step 9: Commit**

  ```bash
  git add docs/superpowers/evidence/2026-08-10-copy-manifest.after.txt docs/superpowers/evidence/2026-08-10-copy-manifest-diff.md public/css/style.css public/index.html public/js/app.js public/landing.html server/content-governance.js server/index.js test/seo-publication.test.js test/web-ui-contract.test.js world/css/theme.css world/index.html world/layout.html world/pages/home.html
  git commit -m "fix: improve accessibility and staged page indexing"
  ```

---

### Task 8: Full-System Verification, Brain Handoff, and Push

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-08-10-hardening-revival.md`
- Modify outside repository: `/Users/markus/Documents/Brain/02 Projekte/Experimente/AiBuilds.md`
- Modify outside repository: `/Users/markus/Documents/Brain/05 Daily Notes/2026-08-10.md`

**Interfaces:**
- Consumes: all Task 1–7 commits and evidence.
- Produces: verified final branch, durable Brain decision/outcome record, pushed `origin/main`.

- [ ] **Step 1: Run focused and full automated verification**

  Run:

  ```bash
  npm test
  node --check server/index.js
  node --check server/moderation.js
  node --check server/world-files.js
  node --check server/content-governance.js
  node --check server/publication-flow.js
  node --check server/platform-metrics.js
  node --check server/seasons.js
  node --check server/world-write-policy.js
  node --check mcp/index.js
  node --check mcp/identity.js
  node --check mcp/tool-contracts.js
  node --check public/js/app.js
  node --check public/js/replay.js
  node --check scripts/generate-copy-manifest.cjs
  npm audit --omit=dev
  npm --prefix mcp audit --omit=dev
  git diff --check
  ```

  Expected: all tests PASS, all syntax checks exit 0, both audits report 0 vulnerabilities, diff check is empty.

- [ ] **Step 2: Run security and live smoke checks**

  On an isolated local port with `POW_DIFFICULTY=0` and temporary `AIBUILDS_WORLD_DIR`, `AIBUILDS_DATA_DIR`, and `AIBUILDS_BACKUP_DIR`, assert: `/world/.git/HEAD`, encoded dot/traversal variants, nested dot paths, hidden and quarantined paths all return 404; safe world assets return 200; CSP contains every required directive and omits `allow-same-origin`; stats field values agree with independently counted visible history/files; risky test contribution quarantines and does not broadcast; safe test contribution publishes; a mutation without any challenge headers is rejected. The temporary World git repository, state and moderation files are discarded after the process exits; repository World/data files remain byte-identical.

- [ ] **Step 3: Run final mutation report**

  Repeat each task’s named temporary mutation one at a time, recording command, WITH failure count and WITHOUT failure count in this plan. Required final record: every guarded mutation has WITH ≥1 and WITHOUT =0. Restore each production file before the next mutation and confirm `git diff --check`.

- [ ] **Step 4: Request two independent reviews**

  Reviewer A checks spec/contract correctness, security boundaries, governance and API behavior. Reviewer B checks implementation quality, tests/mutations, UI/SEO/a11y and copy-manifest classification. Severity: CRITICAL only for wrong/non-executable code or contract violations; WARN only for a gap no later gate will catch; everything else INFO. Every finding includes a one-sentence minimal fix. Resolve all CRITICAL/WARN findings; if a second round is needed, provide the prior mapping and request a delta-only review. Converge within three rounds or ask Markus to accept/fix the remaining judgment call.

- [ ] **Step 5: Update Brain**

  Append dated implementation outcomes, durable contracts, new endpoints, dependency/security status, test/mutation evidence, review verdicts and remaining INFO notes to `[[AiBuilds]]`; add a concise session outcome to `[[2026-08-10]]`. Record the 30-day experiment thresholds exactly: at least 20 unique contributing agents/week, at least 3 contributions/contributing agent, and at least 30% cross-agent file activity; if missed, freeze AI BUILDS as a finished portfolio experiment instead of expanding scope. Preserve existing Brain content and Wikilinks; do not duplicate the design spec verbatim.

- [ ] **Step 6: Update repository handoff and findings mapping**

  Ensure README documents the final stats/Season/replay/governance contracts, operator boundary, and the same 30-day success/freeze rule. Complete the Findings Mapping below with task commits, test counts, audit result, copy-manifest classification, browser evidence, reviewer verdicts and Brain paths.

- [ ] **Step 7: Final commit and push**

  ```bash
  git add README.md docs/superpowers/plans/2026-08-10-hardening-revival.md
  git commit -m "docs: finalize hardening revival handoff"
  git status --short --branch
  git log --oneline --decorate -10
  git push origin main
  ```

  Expected: clean `main`, local HEAD equals `origin/main`, and the push includes the design commit plus every intermediate implementation commit.

---

## Findings Mapping

### Plan Gate

- Round 1: **FAIL** — 7 CRITICAL, 0 WARN, 3 INFO.
  - PG1 provenance gap → added the mandatory post-PASS/pre-Task-1 provenance commit, reproducible temporary-tool command, unchanged-source check, and commit/tree recording.
  - PG2 missing peptide file → Task 2 now creates `test/fixtures/peptide-dosing-math.html`; Task 3 copies it into a temporary World while production audit remains path-agnostic.
  - PG3 no risky-to-safe lifecycle → approved design and Task 3 now separate operator-hidden freeze from correctable quarantine, clear stale state on safe rewrite, persist per-record publication status, and add a real route regression.
  - PG4 copy-contract contradiction → approved design and exhaustive plan categories 6–7 now explicitly permit the exact privacy-safe quarantine notice, „Skip to main content“, and necessary Accessible Names.
  - PG5 incomplete stylesheet scope → Task 7 now covers `world/css/theme.css` and CSS-only changes in `world/pages/home.html`; baseline corrected to 4 `outline:none` plus 24 `transition:all`.
  - PG6 unreachable dashboard quarantine state → Task 4 adds aggregate-only `quarantinedFileCount`; Task 6 renders one exact privacy-safe notice and rejects record-shaped data.
  - PG7 stale server fallback claims → Task 4 rewrites server-generated/discovery/metadata fallbacks and adds a delivered-response public-copy test with 0/6 guard values, including exact case-insensitive `humans can only watch` coverage.
  - PG8 financial/legal branches (INFO) → Task 2 adds literal fixtures, reason codes, WITH/WITHOUT values and one mutation per branch.
  - PG9 admin HTTP coverage (INFO) → Task 3 adds authenticated real-server tests for 400/401/404/409, exact-hash approval, deletion, cleanup and git subject.
  - PG10 nondeterministic/vacuous values (INFO) → Task 2 injects a throwing parser and literal Markdown delta; Task 4 corrects the negative path set to five; Task 5 defines SHA-256 selection and the exact wrong-selector result.
- Round 2: **FAIL** — 1 CRITICAL, 1 WARN.
  - PG3 residual record leak → Task 3 now defines one central immutable-record-plus-current-path predicate, routes every public record consumer through it, derives timeline from filtered records, and asserts old ID/diff/comment/reaction plus aggregate surfaces remain private after safe rewrite.
  - PG7 incomplete prohibited corpus → Task 4 now includes exact case-insensitive `humans can only watch`; WITH the guard the corpus has 0 of 6 prohibited phrases, while the negative fixture WITHOUT the rewrite has 6 of 6.
- Round 3: **FAIL** — 1 CRITICAL, 0 WARN; PG7 and timeline resolved.
  - PG3 residual aggregate/award side channel → accepted and fixed after the third-round verdict: Task 3 now derives every public agent/profile/leaderboard/network/achievement surface and contribution-triggered award broadcast from visible history plus public-target interactions, with exact risky/safe endpoint and WebSocket regressions and a named mutation.
  - Gate disposition: all three external rounds are exhausted. The remaining finding was a concrete technical mapping, not a judgment call; its exact minimal fix is incorporated above. Per the three-round convergence rule, no fourth paper round is opened. Task 3's RED/GREEN/mutation evidence and both final independent implementation reviews are mandatory before completion.

### Task Evidence

- Task 1: pending.
- Task 2: pending.
- Task 3: pending.
- Task 4: pending.
- Task 5: pending.
- Task 6: pending.
- Task 7: pending.
- Task 8: pending.

### Copy Manifest

- Before: freshly reproduced after review deltas against unchanged UI sources, 937 AST entries; SHA-256 `61e5316b4db604efaf936344158fcfe0fefde5acd5962c72e833a9b95e9bec9a`; provenance commit follows the closed three-round gate and exact final-finding incorporation before Task 1.
- After: pending Task 7 generation and category mapping.

### Final Reviews

- Reviewer A: pending.
- Reviewer B: pending.
