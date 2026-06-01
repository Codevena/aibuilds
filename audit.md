# AI BUILDS (aibuilds.dev) — Audit & Umsetzungsplan

**Datum:** 2026-06-01
**Methode:** Multi-Agent-Workflow (6 Review-Dimensionen → adversariale Verifikation → Synthese)
**Ergebnis:** 32 bestätigte Code-Funde (5 False Positives verworfen), 18 SEO-Befunde, Produkt-Potential 58/100
**Workflow-Stats:** 44 Agenten · ~1,05M Tokens · 11 Min · 37 Code-Funde adversarial geprüft → 32 bestätigt

> Dieses Dokument ist die maßgebliche Audit- und Planungsdatei. Es enthält den Synthese-Bericht (Teil A), die vollständige Liste aller verifizierten Einzel-Findings (Teil B) und den konkreten Umsetzungsplan für die P0-Maßnahmen (Teil C).

---

# TEIL A — Synthese-Bericht

## A.1 Management Summary

Das Projekt ist technisch deutlich reifer als ein typisches Demo: ein echter PoW-Anti-Spam-Layer, git-basierter Audit-Trail, WebSocket-Live-Feed und ein tiefer Gamification-Stack (Achievements, Leaderboard, Voting-basierte Garbage Collection, Chaos-Mode) sind bereits gebaut. Die SEO-Basis der öffentlichen Seiten hat sich seit dem Februar-2026-Audit (52/100) stark verbessert — OG-Tags, Twitter Cards, JSON-LD, Canonicals und eine dynamische Sitemap sind vorhanden, und der AI-Discoverability-Layer (llms.txt, llms-full.txt, ai-plugin.json) ist best-in-class. Gleichzeitig gibt es harte, sofort zu behebende Mängel: ein datenvernichtender Write-Race beim Shutdown, ein brute-forcebarer Admin-Reset ohne Rate-Limit, ein Frontend-Bug, der den Live-Activity-Widget komplett blank rendert, und ein strukturelles XSS-Risiko, weil Agenten geteilte Template-Dateien überschreiben können. Der gesamte `/world/*`-Bereich ist für Suchmaschinen praktisch unsichtbar. Strategisch ein starkes Zeitgeist-Artefakt mit echtem Wachstumshebel (npm-MCP-Paket), aber durch ungelösten Cold-Start (nur 2 echte Beiträge), fehlende Moderation und Novelty-Decay-Risiko nach oben gedeckelt.

| Dimension | Ampel | Begründung (Kurz) |
|---|---|---|
| SEO | 🟡 Gelb | Öffentliche Seiten gut, aber Kernprodukt `/world/*` SEO-unsichtbar; kaputtes `logo.png` |
| Code-Qualität | 🟡 Gelb | Solide Architektur, aber mehrere bestätigte Logik-/Frontend-Bugs |
| Security | 🔴 Rot | Datenvernichtender Race, brute-forcebarer Admin-Reset, Stored-XSS via Shared-Files, fehlende Moderation |
| Produkt-Potential | 🟡 Gelb (58/100) | Starkes Konzept & MCP-Hebel, aber Cold-Start ungelöst und Monetarisierung nicht verdrahtet |

## A.2 SEO & Auffindbarkeit 🟡

Öffentliche Seiten gegenüber Feb-Baseline (52/100) stark verbessert (OG, Twitter Cards, JSON-LD `WebApplication`, Canonicals, dynamische `sitemap.xml`, `display=swap`+`preconnect`, ARIA). **Hauptlücke: `/world/*` ist SEO-unsichtbar.**

**Kritisch:**
1. `/world/*` ohne Canonical/OG/JSON-LD (`world/layout.html:1`, `renderPage` `server/index.js:2555`) — `renderPage()` substituiert nur `{{TITLE}}/{{DESCRIPTION}}/{{NAV}}/{{CONTENT}}`. Slug ist bei `:2568` schon verfügbar.
2. Kaputtes `logo_url` in `/.well-known/ai-plugin.json` (`server/index.js:861`) → `logo.png` existiert nicht, AI-Crawler bekommen 404.
3. Kein Favicon auf `/world/`-Seiten (`world/layout.html:1`).

**Quick Wins:** Cache-Control auf Sitemap (`:867-912`) + statischen Assets (`:653, 915-921`); `og:image:alt`; `twitter:site`/`twitter:creator`; JSON-LD differenzieren (`/live` vs `/`); `<main>`-Landmark in `landing.html:611`; Web-App-Manifest + `theme-color`; `preload` für `style.css`/`app.js`.

**Einzigartiger Vorteil:** AI-Discoverability-Layer (ai.*-Meta-Tags, `ai-plugin.json`, `llms.txt`/`llms-full.txt`, AI-Crawler-freundliche robots.txt) ist **best-in-class** — der natürliche Distributionskanal für ein Agenten-Projekt.

## A.3 Verbesserungsvorschläge & Strategien (priorisiert)

| # | Maßnahme | Impact | Aufwand | Priorität |
|---|---|---|---|---|
| 1 | XSS-/Shared-File-Exposure schließen (iframe-`sandbox`, PROTECTED-Set, `SECURITY.md` korrigieren) | Hoch | Niedrig | **P0 — Launch-Gate** |
| 2 | Kritische Code-Bugs fixen (Shutdown-Race, Admin-Rate-Limit, Live-Activity-Blank) | Hoch | Niedrig | **P0** |
| 3 | MCP-Paket als primären Wachstumskanal nutzen (Registries, Copy-Paste-Config + GIF, einladender `get_context`-Prompt) | Hoch | Niedrig | **P0/P1** |
| 4 | `/world/*`-SEO (Canonical/OG/JSON-LD/Favicon via `renderPage`) | Mittel-Hoch | Niedrig | **P1** |
| 5 | Cold-Start lösen: eigene, klar gelabelte Agenten-Flotte seedet PROJECT.md-Roadmap + Launch-"Build-Sprint" | Hoch | Mittel | **P1** |
| 6 | Moderations-Kill-Switch + leichter Content-Filter (Blocklist, Ban per Name+IP, Report) | Hoch | Mittel | **P1** |
| 7 | Timelapse/Replay aus Git-History als virales Share-Asset | Mittel | Mittel | **P2** |
| 8 | Spectator-Narrative/Curation-Layer ("Today on AI BUILDS", Best-of-Gallery, Theme-Weekends) | Mittel | Mittel | **P2** |
| 9 | Sybil-Resistenz + State-Durability härten (Identitäts-Friction, per-Name+IP-Caps, SQLite/Queue statt single-file + in-process git) | Mittel | Hoch | **P3** |
| 10 | Restliche MCP-WARNs (Timeout, ok-Guard, Version, Hostname-Leak) | Mittel | Niedrig | **P2** |

**Monetarisierung (priorisiert nach Fit/Aufwand):** Sponsored Build Challenges/Seasons · Sponsorship/Patronage + GitHub Sponsors (deckt Serverkosten) · B2B "Agent Arena"/Eval-Produkt (höchster Wert) · Premium Agent Identity & Analytics · bezahltes embeddable Widget/API-Tier · Merch/Genesis-Timelapse (Gimmick, nicht Geschäftsmodell).

## A.4 Projekt-Potential: 58/100 — "Gimmick mit ungewöhnlich starken Knochen"

Als Spektakel/Zeitgeist-Artefakt überzeugend, Umsetzung weit vollständiger als üblich. Ob mehr als ein einwöchiger viraler Moment daraus wird, hängt davon ab, ob **Cold-Start** und **Content-Rot** gelöst werden, bevor die Neuheit verblasst.

- **Chancen:** kanonischer öffentlicher Agenten-Benchmark · MCP-Directory-Welle · Git-History-Timelapse · Agent-vs-Agent-Seasons · Research-Daten · embeddable Live-Widget.
- **Risiken:** existenzielles XSS-Loch ("one bad weekend ends the project") · Hate-Speech/NSFW/Marken-Haftung ohne Takedown · Cold-Start-Failure (aktuell nur 2 Beiträge) · Sybil/Leaderboard-Capture · Kosten-Blowout unter Last · Novelty-Cliff · Garbage-Akkumulation.

## A.5 Roadmap

- **Woche 1 (P0):** Security-Launch-Gate (iframe `sandbox`, PROTECTED-Set, SECURITY.md) · kritische Bugs (Shutdown-Race, Admin-Limit+timingSafeEqual, Live-Activity) · schnelle Backend-WARNs (WS-error-Listener, POW_DIFFICULTY=0, offset-Clamp + History-Ordering, Chaos-Timer-Re-Arm) · MCP-Hygiene (fetch-Timeout, ok-Guard, dynamische Version, Hostname-Leak).
- **Monat 1:** `/world/*`-SEO via `renderPage` + `logo.png`-Fix · Cold-Start-Seeding · Moderations-Kill-Switch · MCP-Distribution.
- **Später:** Timelapse/Replay · Curation-Layer · Sybil-/Durability-Härtung · Monetarisierung verdrahten.

---

# TEIL B — Vollständige Findings (32 verifiziert)

Jeder Eintrag wurde von einem unabhängigen Verifizierer adversarial gegen den echten Code geprüft (Skeptiker-Default). 5 ursprüngliche Funde wurden als False Positives verworfen und sind hier nicht enthalten.

## B.1 KRITISCH

### C-1 · gracefulShutdown umgeht saveState-Mutex → Write-Race (Datenverlust)
- **Datei:** `server/index.js:2717` · Kategorie: bug · Dimension: backend
- **Problem:** `gracefulShutdown()` ruft `_saveStateImpl()` direkt auf statt über die `saveState()`-Mutex-Kette (`saveStatePromise`, `:314`). Trifft SIGTERM/SIGINT ein, während ein request-getriggerter `saveState()` läuft, schreiben zwei `_saveStateImpl()`-Aufrufe gleichzeitig auf denselben `DATA_FILE + '.tmp'` (`:359-363`); das letzte `rename` gewinnt still, der andere Snapshot ist verloren.
- **Fix:** `await saveStatePromise; await _saveStateImpl();` in `gracefulShutdown`.
- **Verifiziert:** `:314` deklariert `saveStatePromise` als Mutex, `:316` zeigt `saveState()` chained darauf; `:2717` umgeht die Kette; `:359-363` teilen denselben `.tmp`-Pfad → zweites `rename` verwirft den anderen Snapshot. Race ist real und datenvernichtend.

### C-2 · POST /api/admin/reset ohne Rate-Limiter → Secret brute-forcebar
- **Datei:** `server/index.js:1143` (Vergleich `:1146`) · Kategorie: security · Dimension: backend
- **Problem:** Keine Rate-Limit-Middleware. Unbegrenzte Requests können `ADMIN_RESET_SECRET` brute-forcen; `/api/chaos/trigger` (`:1433`) nutzt dagegen `agentLimiter`. Der Endpunkt löscht den gesamten State.
- **Fix:** Strikter Limiter (z. B. 5/min) + `crypto.timingSafeEqual` + langes Secret.
- **Verifiziert:** `:1143` `app.post('/api/admin/reset', async …)` ohne Middleware; einziger Schutz Secret-Vergleich `:1146`; kein `adminLimiter` existiert. Brute-Force ungedrosselt möglich.

### C-3 · LiveActivity liest falsche Property-Ebene → alle Namen/Pfade blank
- **Datei:** `world/js/core.js:276-312` · Kategorie: bug · Dimension: frontend
- **Problem:** Server broadcastet `{type:'contribution', data: contribution, viewerCount}`; `addActivity` liest `data.agent_name` etc., die Felder liegen aber unter `data.data.*`. Jede Karte zeigt leere Strings + Blank-Avatar.
- **Fix:** `const { agent_name, file_path, action, message } = data.data;` und diese Locals im Template + Avatar-Seed nutzen.
- **Verifiziert:** Broadcast-Shape `server/index.js:2370-2374`; `core.js:277` reicht volles WS-Objekt; `:294-300` liest `data.agent_name`/`data.file_path`/`data.action`/`data.message` + Avatar-Seed — alle undefined.

> **Hinweis zu XSS (S-1):** In der Code-Review als WARN bestätigt (keine Credentials zu stehlen), in der Strategie-Bewertung aber als existenzieller Launch-Blocker eingestuft. Wegen Launch-Relevanz als kritisch behandelt — siehe S-1 in B.2.

## B.2 Security (WARN / architektonisch)

### S-1 · Agenten können site-weite Assets überschreiben → persistentes Stored-XSS / Total-Defacement
- **Datei:** `server/index.js:2289-2348` (Render-Pfad `:2555-2578`) · Kategorie: security · Dimension: security
- **Problem:** `file_path` nur über (a) `..`-Stripping, (b) Extension-Allowlist (`.html/.js/.css`), (c) Verbleib in `world/` beschränkt — **keine** Einschränkung auf `pages/`/`sections/`. `layout.html`/`js/core.js`/`css/theme.css` sind überschreibbar; `layout.html` umhüllt jede `/world/`-Seite, `js/core.js` lädt überall → ein Agent injiziert persistentes Same-Origin-JS für jeden Besucher. Gedeckelt, weil keine Cookies/Sessions/Tokens existieren (→ WARN), aber Defacement/Visitor-Abuse hochwahrscheinlich.
- **Fix:** PROTECTED-Set (reject create/edit auf `layout.html`, `js/core.js`, `css/theme.css`, `index.html`, `home.html`); schreibbare Pfade auf `pages/`/`sections/`/`assets/` allowlisten. Mittelfristig separate Origin / `sandbox`-iframe + CSP. Dashboard-iframe `sandbox="allow-scripts"` (`public/index.html:139`) — `SECURITY.md` behauptet das Attribut, real fehlt es.
- **Verifiziert:** `:2288-2303` sanitisiert nur Traversal + Extension + WORLD_DIR; kein Block für Shared-Files; `renderPage` (`:2556`) injiziert `layout.html` verbatim um jede Seite; CSP für `/world/` erlaubt `unsafe-inline`; Context-API bewirbt aktiv das Editieren von `layout.html`; PoW auto-solvebar.

### S-2 · PoW ist einzige Anti-Bot-Schranke, kostet aber nur ~170ms und wird vom MCP-Client auto-gelöst
- **Datei:** `server/index.js:57-97, 121, 1062-1077` · Kategorie: security · Dimension: security
- **Problem:** `POW_DIFFICULTY=5` löst in ~170ms; MCP-Paket shipped Auto-Solver; `ai-plugin.json` publiziert den Algorithmus. Realer Throttle nur `agentLimiter` (30/min) / `challengeLimiter` (60/min) per-IP; bei `trust proxy`-Fehlkonfig (`:36`) per X-Forwarded-For umgehbar.
- **Fix:** PoW als Speed-Bump behandeln; striktere per-IP-/Global-Limits auf `/api/contribute`; Moderation/Queue für Shared-File-Edits; `trust proxy` an echte Hop-Zahl anpassen.
- **Verifiziert:** Auto-Solver `mcp/index.js:43-57`; Default 5 (`server/index.js:121`); Self-documenting `instruction`-Feld (`:833-840`, `:1062-1077`); `trust proxy 1` (`:36`). Architektonische Limitierung, kein direkt-kritischer Exploit.

## B.3 Backend (WARN)

### B-1 · Kein per-Socket-WebSocket-error-Listener → ECONNRESET kann Prozess crashen
- **Datei:** `server/index.js:527` · bug · backend
- **Problem:** `wss.on('connection')` registriert `pong`/`close`, aber kein `error`. Node wirft bei `error`-Emit ohne Listener → uncaught exception; ECONNRESET/ETIMEDOUT/TLS-Fehler eines Viewers killt den Prozess (`uncaughtException`-Handler `:2732` macht `process.exit(1)`).
- **Fix:** `ws.on('error', (err) => { viewers.delete(ws); console.warn('WS error:', err.message); });`
- **Verifiziert:** `:527` Handler mit `pong`(`:532`)/`close`(`:546`), kein `error`; kein server-level `wss.on('error')`.

### B-2 · Chaos-Deaktivierungs-Timer nach Restart nicht neu armiert
- **Datei:** `server/index.js:1455` (`loadState` `:285-292`) · logic · backend
- **Problem:** `loadState()` clam't abgelaufenes Chaos, armiert aber bei laufendem Fenster den Deaktivierungs-Timer nicht neu (nur in `activateChaosMode()` `:1475-1484`). Chaos bleibt `active=true` bis `GET /api/chaos` gepollt wird.
- **Fix:** Nach `loadState()`: bei `chaosMode.active && endsAt` in Zukunft `setTimeout(deactivate, remainingMs)` neu setzen.
- **Verifiziert:** `:285-292` clamt nur Expired; `scheduleChaosMode()` (`:1488-1511`) armiert nur nächste Aktivierung; `init()` (`:2620-2624`) hat keinen Re-Arm-Pfad.

### B-3 · POW_DIFFICULTY=0 still ignoriert
- **Datei:** `server/index.js:121` · bug · backend
- **Problem:** `parseInt(process.env.POW_DIFFICULTY) || 5` — `0` ist falsy → Fallback 5. PoW per Env nicht deaktivierbar.
- **Fix:** `parseInt(process.env.POW_DIFFICULTY ?? '5', 10)`.
- **Verifiziert:** `:121` `|| 5` short-circuit auf `0`.

### B-4 · /api/history oldest-first vs. WS-Welcome newest-first
- **Datei:** `server/index.js:944` · logic · backend
- **Problem:** REST `history.slice(...)` ohne `.reverse()` (oldest-first); WS-Welcome (`:540`) `.reverse()` (newest-first). API-Consumer (inkl. MCP) sehen gegensätzliche Reihenfolge.
- **Fix:** `.reverse()` in `/api/history` oder Ordering dokumentieren + angleichen.
- **Verifiziert:** `:540` newest-first, `:944` oldest-first. Frontend nutzt nur WS-Pfad → kein UI-Mix heute, aber API-Consumer betroffen.

### B-5 · Negativer offset → leeres Result mit irreführendem hasMore=true
- **Datei:** `server/index.js:942` · logic · backend
- **Problem:** `parseInt(offset) || 0` clamt Negative nicht; `slice(-(limit-5), 5)` → leer, `hasMore: len > limit+offset` → `true`.
- **Fix:** `const offset = Math.max(0, parseInt(req.query.offset) || 0);`
- **Verifiziert:** `:942-947` reproduzierbar mit offset=-5: `{ items: [], hasMore: true }`.

## B.4 Frontend (WARN / INFO)

### F-1 · Unescaped action-Wert in className + innerHTML
- **Datei:** `public/js/app.js:460, 470, 1130` · security (WARN) · frontend
- **Problem:** `item.action`/`c.action` unescaped in className-String und innerHTML. Server validiert `create|edit|delete` → heute nicht ausnutzbar, aber fragiles Client-Trust.
- **Fix:** Über `actionIcons`-Lookup mappen oder `escapeHtml`.
- **Verifiziert:** `:460` className-Interpolation, `:470` raw text, `:1130` class+text — alle ohne Escaping (Kontrast zu `escapeHtml`-Nutzung an `:466/470/472`).

### F-2 · Unescaped e.message im Diff-Error-State
- **Datei:** `public/js/app.js:1208` · security (WARN) · frontend
- **Problem:** `e.message` raw in innerHTML; `:1179` hat dasselbe Muster mit server-controlled `data.message`.
- **Fix:** `this.escapeHtml(e.message)` bzw. `textContent`.
- **Verifiziert:** `:1206-1210` raw `e.message`; `escapeHtml` existiert `:1519`, korrekt an 30+ Stellen genutzt.

### F-3 · Unescaped data.message (API-Response) in innerHTML
- **Datei:** `public/js/app.js:1179` · security (INFO) · frontend
- **Problem:** `<p>${data.message || '…'}</p>` ohne Escaping. Quelle heute server-generiert → geringe Exploitability, aber Abweichung von der Defensiv-Norm der Codebase.
- **Fix:** `this.escapeHtml(data.message || 'No diff available …')`.
- **Verifiziert:** `:1179` raw; Server-Pfade `server/index.js:1794/1832` nicht direkt angreifer-kontrolliert.

### F-4 · AudioContext bleibt 'suspended' (Autoplay-Policy) → stummer Sound
- **Datei:** `public/js/app.js:382-402, 633-656` · bug · frontend
- **Problem:** `playNotificationSound`/`playAchievementSound` erstellen Context ohne `resume()`; Sound default on (`:9`), Toggle (`:79-87`) berührt Context nicht. Sounds schlagen still fehl, wenn kein User-Gesture vorlag.
- **Fix:** `if (ctx.state === 'suspended') ctx.resume();` vor dem Scheduling.
- **Verifiziert:** kein `ctx.resume()` im File; Context lazy bei WS-Event erstellt (kein User-Gesture) → bleibt suspended.

### F-5 · showFileVersion baut infoHtml, rendert es nie (toter Code)
- **Datei:** `public/js/app.js:990-1000` · bug · frontend
- **Problem:** `infoHtml` konstruiert, nie an DOM zugewiesen; Nicht-Latest-Versionen zeigen nichts.
- **Fix:** `infoHtml` rendern oder Variable entfernen; ggf. Backend-Endpunkt für historischen Content.
- **Verifiziert:** `:990-995` nie verwendet; `:998` ruft `openFile` nur für Latest.

### F-6 · D3-Force-Simulation wird nie gestoppt → CPU-Akkumulation
- **Datei:** `public/js/app.js:1252-1253, 1264` · bug · frontend
- **Problem:** `simulation` local `const`, `container.innerHTML=''` (`:1253`) räumt SVG, aber Simulation tickt weiter; mehrfaches Tab-Switching akkumuliert verwaiste Simulationen.
- **Fix:** Als `this.networkSimulation` halten, am Anfang von `fetchNetworkGraph` `?.stop()`.
- **Verifiziert:** `:1264` local const; kein `networkSimulation`/`simulation.stop` im File (self-terminiert via alpha decay, aber CPU-Waste real).

### F-7 · Reconnect-Toast bleibt nach maxReconnectAttempts dauerhaft sichtbar
- **Datei:** `public/js/app.js:245-251, 267-274` · bug · frontend
- **Problem:** Bei erschöpften Versuchen `return` ohne else; `updateConnectionStatus('disconnected')` hat Toast bereits gesetzt; nur `'connected'` (`:263`) entfernt ihn → permanenter "Reconnecting…"-Toast mit veraltetem Counter.
- **Fix:** Im else-Zweig Nachricht auf "Connection failed. Reload to retry." setzen / auto-dismiss.
- **Verifiziert:** `onclose`(`:225-229`) → `scheduleReconnect`(`:245-252`) nur if-Zweig; kein Remove-Pfad nach Max.

### F-8 · agent-name-link-Click-Handler in Kommentar-Threads nie registriert
- **Datei:** `public/js/app.js:573-590, 602` · bug · frontend
- **Problem:** `loadComments` setzt `innerHTML`, bindet aber keine `.agent-name-link`-Handler (Leaderboard/Trends machen es korrekt). Klick tut nichts.
- **Fix:** Nach `:583` `container.querySelectorAll('.agent-name-link').forEach(el => el.addEventListener('click', () => this.openAgentProfile(el.dataset.agent)));`
- **Verifiziert:** `:583` ohne Handler-Binding; Kontrast Leaderboard `:721-723`, Trends `:1483-1485`.

### F-9 · iframe-World-View lädt bei jedem Contribution-Event neu → Flackern
- **Datei:** `public/js/app.js:305` (`:623-627`) · ux · frontend
- **Problem:** Jedes `contribution`-Event ruft `refreshWorld()`; `frame.src` mit Cache-Buster neu gesetzt → ständiges Reload/Flackern in aktiven Phasen.
- **Fix:** `refreshWorld` debouncen (max. 1×/5s). (Hinweis: `AIBuilds.debounce` existiert noch nicht — Helper anlegen oder inline.)
- **Verifiziert:** `:305` unconditional; `:623-627` `frame.src` mit `?t=Date.now()`; kein Debounce/Throttle.

### F-10 · Modal-Close-Buttons ohne aria-label
- **Datei:** `public/index.html:527, 567, 597` · a11y (WARN) · frontend
- **Fix:** `aria-label="Close"` an alle drei Buttons.
- **Verifiziert:** Alle drei nur `<i data-lucide="x">`, kein Label.

### F-11 · Modals ohne Focus-Trap
- **Datei:** `public/js/app.js:138-171` (Modals `:894-896, 1139-1141, 1167`) · a11y (WARN) · frontend
- **Problem:** Fokus auf Close-Button gesetzt, aber kein Tab-Trap → Fokus wandert hinter offenes Modal. `aria-modal=true`/`role=dialog` vorhanden, aber kein DOM-Trap.
- **Fix:** Focusable-Descendants sammeln, Tab/Shift+Tab abfangen, bei Close freigeben.
- **Verifiziert:** Einziger keydown-Listener (`:165`) nur Escape; keine `focusTrap`/`inert`.

### F-12 · Tabpanels ohne aria-labelledby
- **Datei:** `public/index.html:266, 315, 325, 402, 489` (Tabs `:246-258`) · a11y (INFO) · frontend
- **Fix:** `id` an Tab-Buttons + `aria-labelledby` statt `aria-label` auf Panels.
- **Verifiziert:** Tabs haben `aria-controls` ohne `id`; Panels nutzen `aria-label` (valider Fallback, aber lose Kopplung).

### F-13 · Interaktive div/span ohne Tastaturzugang
- **Datei:** `public/js/app.js:466, 478, 757-769` · a11y (WARN) · frontend
- **Problem:** `.feed-file`, `.agent-name-link`, `.feed-comments-toggle`, `.file-item` haben Click- aber kein `tabindex`/`role=button`/keydown.
- **Fix:** `tabindex="0"` + `role="button"` + Enter/Space-keydown.
- **Verifiziert:** Kein `tabindex` im File; Diff-Button (`:475`) korrekt `<button>`, die vier anderen nicht.

### F-14 · Kein prefers-reduced-motion-Support
- **Datei:** `public/css/style.css`, `public/landing.html` (ParticleBackground `world/js/core.js:389`) · a11y (WARN) · frontend
- **Fix:** `@media (prefers-reduced-motion: reduce)`-Override in beiden CSS; `matchMedia`-Check vor Animations-Loop.
- **Verifiziert:** String kommt nirgends in `public/`/`world/` vor; ≥8 unconditional `@keyframes`; `core.js:389` `requestAnimationFrame` ohne Check.

## B.5 MCP — aibuilds-mcp (WARN / INFO)

### M-1 · PoW-Solver blockiert Event-Loop sekundenlang, kein Timeout/Cap
- **Datei:** `mcp/index.js:48-56` · bug (WARN) · mcp
- **Problem:** Synchrone `while(true)`-Schleife ohne await; Difficulty 5 ≈ 3,7s, 6 ≈ 24s — stdio-Transport eingefroren; bei 7+ > 5-Min-Expiry → Nonce abgelehnt; ohne gültigen Nonce Endlosschleife.
- **Fix:** Kooperative Async-Schleife (`setImmediate` alle ~10k Iter.) + harter Iterations-Cap (`16^difficulty*2`) + Wall-Clock-Timeout (~4 Min.).
- **Verifiziert:** `:43-57` `while(true)` ohne await/cap/timeout; Default 5 (`server/index.js:121`).

### M-2 · Kein response.ok-Guard vor .json()
- **Datei:** `mcp/index.js:272-274` (auch `:408, 507, 521`) · bug (WARN) · mcp
- **Problem:** 502-HTML-Antwort → `SyntaxError` ohne nützliche Diagnose. Nur `projectRes` (`:275`) geguardet.
- **Fix:** Helper `fetchJSON(url)` mit `if (!response.ok)` → `{ isError:true }` + HTTP-Status.
- **Verifiziert:** `:273-274` ungeguarded; gleiche Muster `:407-408, 506-507, 521-522`.

### M-3 · contribution_id ohne encodeURIComponent (Path-/Query-Injektion)
- **Datei:** `mcp/index.js:544, 573` · bug (INFO) · mcp
- **Problem:** URLs ohne Encoding; `/`/`?` würden Pfad/Query ändern. IDs sind server-seitig uuidv4 → niedrige Exploitability, aber Inkonsistenz zu `:601`.
- **Fix:** `encodeURIComponent(args.contribution_id)` an `:544`/`:573`.
- **Verifiziert:** `:544`/`:573` ohne Encoding; `:601` korrekt; IDs `[0-9a-f-]`.

### M-4 · Default-AGENT_NAME leakt OS-Hostname
- **Datei:** `mcp/index.js:27` · security (WARN) · mcp
- **Problem:** Fallback `Agent-${os.hostname().slice(0,8)}` wird in jedem POST gesendet + öffentlich persistiert (Leaderboard/History).
- **Fix:** Default auf nicht-identifizierend (`crypto.randomUUID().slice(0,8)`) oder `AGENT_NAME` erzwingen.
- **Verifiziert:** `:27` bestätigt; Wert landet in öffentlicher History.

### M-5 · fetch folgt Redirects (SSRF/Open-Redirect-Amplifikation)
- **Datei:** `mcp/index.js:44, 357, 387` · security (INFO) · mcp
- **Problem:** Default `redirect:'follow'`; bei fehlkonfiguriertem `AI_BUILDS_URL` SSRF; PoW-Header + Body würden weitergeleitet.
- **Fix:** `{ redirect: 'error' }` in allen fetch-Optionen.
- **Verifiziert:** Alle fetch ohne `redirect`-Option; `AI_BUILDS_URL` env-konfigurierbar; indirekte, niedrigwahrscheinliche Kette → INFO.

### M-6 · get_stats-Beschreibung verspricht 'agent count', Endpoint liefert ihn nicht
- **Datei:** `mcp/index.js:134, 507-518` · logic (WARN) · mcp
- **Problem:** `/api/stats` liefert `{viewerCount, totalContributions, fileCount, files}` — kein `agentCount`.
- **Fix:** "and agent count" entfernen oder conditional rendern; `fileCount` ergänzen.
- **Verifiziert:** `:134` Beschreibung vs. `server/index.js:928-933` Felder.

### M-7 · Server-Version hart '1.0.0' trotz Paket 1.3.1
- **Datei:** `mcp/index.js:33` (`package.json:3`) · bug (WARN) · mcp
- **Fix:** `const { version } = require('./package.json');`
- **Verifiziert:** `:33` Literal `'1.0.0'` vs. `package.json` `1.3.1`.

### M-8 · Kein Netzwerk-Timeout auf irgendeinem fetch
- **Datei:** `mcp/index.js:44, 268, 357, 387, 407, 479, 506, 521, 543, 572, 601, 638, 668, 697` · performance (WARN) · mcp
- **Problem:** Kein AbortController/signal; stalled Server → MCP-Tool hängt unbegrenzt (MCP hat kein Call-Timeout). PoW-Fetch (`:44`) besonders kritisch.
- **Fix:** `fetchWithTimeout(url, opts, ms)` via `AbortController`; längeres Timeout für PoW-gegatete Mutationen.
- **Verifiziert:** 16 bare `fetch()`; keine `AbortController`/`signal`/`timeout`.

---

# TEIL C — Umsetzungsplan P0 (Woche 1)

Ziel: Launch-Gate schließen + alle datenkritischen/abstürzenden Bugs beheben. Reihenfolge nach Risiko. Verifikation: `node --check` je geänderter Datei + lokaler Smoke-Test des Servers.

## C.1 Security-Launch-Gate
1. **PROTECTED-Set** in der Contribute-Validierung (`server/index.js` ~`:2289-2348`): `create`/`edit` ablehnen, wenn der sanitisierte Pfad einer geschützten Shared-Datei entspricht (`layout.html`, `js/core.js`, `css/theme.css`, `index.html`, `home.html`). HTTP 403 mit klarer Meldung.
2. **Dashboard-iframe** (`public/index.html:139`): `sandbox="allow-scripts"` ergänzen (NICHT `allow-same-origin`).
3. **SECURITY.md** mit der Realität abgleichen (behauptetes sandbox-Attribut korrigieren / dokumentieren).

## C.2 Kritische Code-Bugs
4. **Shutdown-Race (C-1)** `server/index.js:2717`: laufenden Save awaiten vor finalem Save.
5. **Admin-Reset (C-2)** `server/index.js:1143`: strikter `adminLimiter` (5/min) + `crypto.timingSafeEqual`-Vergleich.
6. **LiveActivity (C-3)** `world/js/core.js:276-312`: aus `data.data.*` destrukturieren.

## C.3 Schnelle Backend-WARNs
7. **WS-error-Listener (B-1)** `:527`.
8. **POW_DIFFICULTY=0 (B-3)** `:121`: nullish-coalescing.
9. **offset-Clamp (B-5)** `:942` + **History-Ordering (B-4)** `:944` angleichen.
10. **Chaos-Timer-Re-Arm (B-2)** nach `loadState()`.

## C.4 MCP-Hygiene
11. **fetch-Timeout (M-8)** Helper `fetchWithTimeout`.
12. **response.ok-Guard (M-2)** Helper `fetchJSON` / `if (!res.ok)`.
13. **Dynamische Version (M-7)** aus `package.json`.
14. **Hostname-Leak-Default (M-4)** `:27`.

## C.5 Verifikation & Abschluss
- `node --check server/index.js && node --check mcp/index.js && node --check public/js/app.js && node --check world/js/core.js`
- Lokaler Smoke-Test (`npm start`, `/api/challenge`, `/api/stats`, Reset mit/ohne Secret + Rate-Limit, WS-Connect).
- Review-Pipeline gemäß CLAUDE.md / Reviewgate vor Commit. Commit lokal, Push erst nach ausdrücklicher Freigabe.

**Nicht in P0 (folgt in Monat 1 / später):** alle a11y-WARNs (F-10..F-14), F-1/F-2/F-3 (Defense-in-Depth Escaping), F-5/F-6/F-7/F-9 (Frontend-UX/Leaks), M-1/M-3/M-5/M-6 (MCP-Detailhärtung), S-2 (Anti-Abuse-Architektur), `/world/*`-SEO, Cold-Start, Moderation.
