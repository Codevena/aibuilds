# Review-Protokoll — Konsumenten-Schutz für pathspec-lose Git-Commits

Datum: 2026-09-04 · Basis: `main` bei `e9021cf` · Tree-Bindung des abgenommenen Stands:
`shasum -a 256 server/index.js test/git-index-confinement.test.js | shasum -a 256`
→ `9c1f624c1558d8bebfd1afebc6a886726c716a0558973662cc755ff639192685`

## Der Defekt, dreimal gegen `e9021cf` reproduziert

`git commit` ohne Pathspec committet den gesamten Index — auch das, was ein anderer Codepfad dort
liegen ließ.

| Endpunkt | Zugang | Gemessen ohne Wächter |
|---|---|---|
| `/api/contribute` `action=delete` auf ungetrackten Pfad | **nur Proof-of-Work** | 200; HEAD `[DeleterAgent] delete: pages/Scratch.html` mit `D pages/PublicPage.html`, Opfer aus dem HEAD-Tree |
| `/api/admin/quarantine/reject` auf ungetrackten Pfad | Admin-Secret | 200; HEAD-Commit trägt **nur** die fremde Löschung |
| `/api/admin/moderate action=delete` | Admin-Secret | 200; HEAD-Commit mit zwei `D`-Zeilen |

## Verdikte

**Plan-Gate** (vor der ersten Codezeile), Rundenlimit 3 erreicht:

| Runde | Slot | Verdikt | C/W/I |
|---|---|---|---|
| 1 | A (ausführend, Claude-Subagent) | FAIL | 1/3/5 |
| 1 | B (lesend, glm-5.3:cloud) | FAIL | 0/2/4 |
| 2 | A | FAIL | 2/0/3 |
| 2 | B | FAIL | 1/1/5 |

**Definition of Done** (nach der Implementierung):

| Runde | Slot | Verdikt | C/W/I |
|---|---|---|---|
| 1 | A | FAIL | 1/3/5 |
| 1 | B | FAIL | 0/2/4 |
| 2 | A | FAIL | 1/2/5 |
| 2 | B | FAIL | 1/0/5 |
| 3 | A | FAIL | 0/1/4 |
| 3 | B | **PASS** | 0/0/4 |
| 4 | A | **PASS** | 0/0/5 |

Slot A Runde 4, wörtlich: „PASS. Binding `bda34007…` verified identical before and after my run;
payload True/True." Codex war über die gesamte Arbeit am Kontingent gesperrt (bis 07.09.2026);
Slot A war durchgehend ein ausführender Claude-Reviewer-Subagent.

## EVIDENCE des ausführenden Slots (Auszug der tragenden Messungen)

```
binding bda34007… identical before and after the run; payload verbatim True/True
node --test test/git-index-confinement.test.js -> rc=0, 12 pass / 0 fail
admin-quarantine 5/0 · publication-flow 37/0 · moderation 55/0
Mutation "nur GIT_INDEX_FILE-delete entfernt" -> not ok 12, sonst nichts
Mutation "nur GIT_DIR-delete entfernt"        -> not ok 11, sonst nichts
Mutation "nur GIT_WORK_TREE-delete entfernt"  -> 12/0 grün (ungedeckte Härtung)
GIT_DIR ohne GIT_WORK_TREE, cwd=<repo>/world, Wurzeldatei pages/b.html gestagt:
  prefix="", entries=['pages/b.html'], own='pages/b.html', foreign=[] -> Wächter LIESS DURCH
GIT_INDEX_FILE=<nicht existent>: diff --cached meldet jede HEAD-Datei als gestagte Löschung
  -> Wächter hält die eigenen Seiten der Welt für fremd, lehnt dauerhaft ab
--no-renames entfernt: gestagter Add + inhaltsähnliche fremde Löschung werden als R100 gepaart,
  nur der neue Name gedruckt -> moderate delete 200, Commit trägt nur `D pages/Victim.html`
Layout-Matrix (rev-parse --show-prefix): Unterverzeichnis "world/" · Symlink "world/" ·
  verlinkter Worktree "world/" · GIT_DIR+GIT_WORK_TREE "world/" · bare "" ·
  GIT_DIR allein "" gegen wurzelrelative Einträge = MISMATCH
Nebenläufigkeit: 12 gleichzeitige contribute+moderate in 994 ms, 14 Commits, Index danach leer,
  kein Deadlock durch das queueGitOperation-Wrapping
alle sechs queueGitOperation-Aufrufer werden unter CONTRIBUTION_STATE_LOCK awaited;
  kein Timer fasst git an; nichts innerhalb eines Queue-Callbacks reiht erneut ein
```

## Mutationslauf — 17 Mutationen, 16 tot

Jede in einer Kopie, Produktion und Test getrennt mutiert.

```
M1  Wächter :4232 raus                  -> #1
M2  Wächter :2443 raus                  -> #2
M3  Wächter :2242 raus                  -> #3 #5 #6 #7 #8 #9 #10 #11
M3b Wächter hinter git.add              -> #3 #11
M4  -z raus                             -> #3 #4 #8
M5  Wächter wirft nie                   -> #1 #2 #3 #5 #6 #7 #8 #10 #11
M6  --no-renames raus                   -> #5
M7  leere NUL-Einträge behalten         -> #1 #4 #8
M8  NFC-Faltung statt Bytegleichheit    -> #6 #7
M9  Strings statt Buffer vergleichen    -> #7
M10 Prefix raus                         -> #8 #11
M11 --relative statt Prefix             -> #8 #11
M13 Indexlesefehler schlucken           -> #9
M14 --ignore-submodules=none raus       -> #10
M15 GIT_DIR-Löschung raus               -> #11
M16 GIT_INDEX_FILE-Löschung raus        -> #12
M12 queueGitOperation-Wrapping raus     -> GRÜN
```

**M12 bleibt grün und wird als ungedeckte Härtung geführt, nicht als abgedeckt.** Beide Slots haben
unabhängig bestätigt, dass nichts im Prozess dazwischenkommen kann: alle sechs Aufrufer laufen unter
derselben globalen Sperre. Das Wrapping ersetzt ein globales, nirgends ausgesprochenes Invariant
durch eine lokal prüfbare Zusage; kein deterministischer Test kann die beiden Formen unterscheiden.

## Bewusst offen gelassen

- **Unicode-Faltung.** Beide Plan-Gate-Reviewer wollten `normalize('NFC')`, plattformgebunden. Der
  byte-genaue Vergleich hat als einzige von drei gemessenen Varianten **keinen** Fail-open-Modus:
  NFC-Faltung lässt einen fremden NFD-Zwilling als eigenen durch (der Index hält beide nebeneinander,
  auch auf APFS), `:(exclude,literal)<Pfad>` schließt auch alles **unterhalb** des Pfads aus. Preis:
  ein eigener Pfad in einer Schreibweise, die git nicht zurückgibt, wird abgelehnt — fail-closed,
  protokolliert, nur bei `/api/admin/moderate` erreichbar.
- **Pre-Commit-Hooks.** Ein Hook, der selbst staged, läuft innerhalb von `git commit`, also nach der
  Prüfung — und trifft die `commit --only`-Geschwister genauso, weil git ihn bei einem Teil-Commit
  auf den temporären Index zeigt. `--no-verify` würde das zum Preis jedes Hooks kaufen, der einen
  schlechten Commit ablehnt. Der Welt-Repo liefert keine Hooks aus.
- **`GIT_QUARANTINE_PATH`, `GIT_OBJECT_DIRECTORY`, `GIT_COMMON_DIR`.** Erreichen den Wächter, bleiben
  aber in jeder konstruierbaren Form fail-closed (`GIT_OBJECT_DIRECTORY` allein macht HEADs Tree
  unlesbar und lässt den Index als lauter Additions erscheinen; `GIT_COMMON_DIR` lässt git ganz
  scheitern). Der eigentliche Schaden wäre Objektspeicher-Korruption, nicht ein Sweep — eigener Task.
- **`waitForServer` in fünf weiteren Testdateien** hat kein Per-Versuch-Timeout. Genau das erzeugte
  hier einmal einen 304-Sekunden-Lauf mit „Server did not start", während das Banner im Log stand.
  In dieser Datei behoben, in `admin-quarantine`, `public-contract`, `public-copy`, `seasons` und
  `seo-publication` weiterhin offen.
