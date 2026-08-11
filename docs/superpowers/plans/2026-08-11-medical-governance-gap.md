# Medical Governance Gap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Quarantine actionable medical dosing arithmetic and remove the currently public peptide calculator from every live public surface after deployment.

**Architecture:** Add one production-shaped fixture and extend the existing pure content classifier with a multi-signal arithmetic branch. Reuse the existing startup audit and moderation quarantine rather than adding incident-specific paths or a second policy store.

**Tech Stack:** Node.js, `node:test`, parse5, existing publication-flow startup audit.

## Global Constraints

- Preserve the existing `high_stakes_medical` machine-readable reason.
- Preserve exact-hash operator approvals.
- Do not hard-code `pages/peptide-dosing-math.html` in production logic.
- A disclaimer never bypasses actionable dosing guidance.
- Keep benign non-instructional vial and syringe measurement content public even when the same quantity pairs are nearby.
- Require an explicit relation for worked mappings and recognize either quantity order.
- Do not treat laboratory `dose-response` terminology as a concrete human dose; allow `is`/`are` only between mapped quantities.
- Use strict TDD and prove the new tests with a disposable mutation.

---

### Task 1: Production-shaped classifier regression

**Files:**
- Create: `test/fixtures/peptide-dosing-arithmetic.html`
- Modify: `test/content-governance.test.js`

**Interfaces:**
- Consumes: `evaluatePublication({ filePath, content })`
- Produces: regression coverage for `status: 'quarantined'` with reason `high_stakes_medical`

- [ ] **Step 1: Add the production-shaped fixture**

Include the live incident's decisive behavior: vial-strength/water concentration formula, dose-to-volume formula, a `0.25 mg -> 0.1 mL -> 10 units` worked example, reconstitution-volume adjustment, U-100 syringe context, and the existing disclaimer pattern.

- [ ] **Step 2: Write the failing classifier tests**

Assert that the new fixture quarantines; reversed mass/volume and units/volume preparation mappings quarantine; and laboratory vial, dose-response, and syringe-calibration paragraphs with the same nearby quantity pairs but no conversion relation publish.

- [ ] **Step 3: Run RED**

Run: `node --test --test-name-pattern='dosing arithmetic|laboratory measurements' test/content-governance.test.js`

Expected: the arithmetic fixture test fails because it is currently published; the negative boundary passes.

### Task 2: Multi-signal medical arithmetic classifier

**Files:**
- Modify: `server/content-governance.js`
- Test: `test/content-governance.test.js`

**Interfaces:**
- Consumes: normalized visible HTML text plus contribution message
- Produces: `hasMedicalDosingInstruction(text): boolean` through the existing classifier boundary

- [ ] **Step 1: Implement the minimal arithmetic branch**

Keep the scheduled-injection regex. Add independently named predicates for strong medical context, concrete quantities, formula evidence, and bidirectional relation-bearing worked conversions, and require the three policy signals for the new branch.

- [ ] **Step 2: Run GREEN**

Run: `node --test test/content-governance.test.js`

Expected: all content-governance tests pass.

- [ ] **Step 3: Refactor only if the focused tests remain green**

Keep bounded regexes and avoid filename-, domain-, or incident-specific policy.

### Task 3: Startup audit regression and mutation evidence

**Files:**
- Modify: `test/publication-flow.test.js`

**Interfaces:**
- Consumes: `auditWorldForQuarantine({ files, readFile, isApproved, evaluatePublication })`
- Produces: a startup quarantine record discovered from the production-shaped bytes

- [ ] **Step 1: Replace the startup-audit risky fixture with the new arithmetic fixture under a neutral path**

Seed and assert the fixture as `pages/arithmetic-regression.html`, not under the production incident filename. Retain the existing assertions for content hash, reason, agent name, timestamp, safe file, outside file, and exact-hash approval. This makes filename-specific production logic fail the test.

- [ ] **Step 2: Run the focused startup audit**

Run: `node --test --test-name-pattern='startup audit discovers' test/publication-flow.test.js`

Expected: PASS only after Task 2.

- [ ] **Step 3: Run an isolated mutation**

In disposable copies, (a) remove the new arithmetic return path while preserving the scheduled-injection rule, (b) replace relation-bearing conversions with raw proximity, and (c) remove reverse-order matching. Run the new classifier tests plus the startup-audit test for each relevant mutant.

Expected: baseline has zero failures and every mutant has at least one targeted failure. Restore or discard the disposable copies and confirm `git diff --check` in the real tree.

### Task 4: Review, verification, documentation, and deployment

**Files:**
- Modify: `/Users/markus/Documents/Brain/02 Projekte/Experimente/AiBuilds.md`
- Modify: `/Users/markus/Documents/Brain/05 Daily Notes/2026-08-11.md`

**Interfaces:**
- Consumes: completed diff and verification evidence
- Produces: reviewed commit on `main`, pushed deployment, and live 404/private-surface evidence

- [ ] **Step 1: Run static and full gates**

Run focused tests, `npm test`, `node --check server/content-governance.js`, root and MCP production audits, and `git diff --check`.

- [ ] **Step 2: Obtain two independent reviews**

One reviewer checks the medical policy/spec boundary; one checks integration, startup behavior, privacy surfaces, test quality, and regressions. Resolve CRITICAL/WARN findings with delta-only re-reviews.

- [ ] **Step 3: Update Brain**

Replace the open P0 note with the exact classifier, tests, reviews, commit/push, and production verification outcome. Append; never overwrite unrelated Brain content.

- [ ] **Step 4: Commit and push**

Stage only the planned repo files and commit with a precise message. Immediately before `git push`, fetch and record `/api/stats.quarantinedFileCount` as the deployment baseline. Push `main` to `origin`, then verify local/remote SHA equality.

- [ ] **Step 5: Verify production**

Poll deployment, then assert raw API and pretty route return 404, `/api/replay` contains no peptide-dosing record, and the post-restart quarantine count is strictly greater than the pre-push baseline from Step 4. If deployment has not completed, continue monitoring rather than claiming completion.
