# Hardening Revival Copy Manifest Diff

## Provenance

- Immutable pre-UI baseline: 937 entries, SHA-256
  `61e5316b4db604efaf936344158fcfe0fefde5acd5962c72e833a9b95e9bec9a`.
- Pre-Task-7 state (`9c478c0`): 1,145 entries, SHA-256
  `142bd423e8f41c16ce9400780b619c162c99e10034e80d38765b89b8f8663eea`.
- Final post-edit artifact: 1,169 entries, SHA-256
  `a23506ae43c642584b8d4a5bb5e5a0e92c08a1b8416d355cf1b5e9fa6ec2f8a1`.

The immutable baseline was verified before Task 7 with `wc -l` and `shasum -a 256`.
The final artifact is `2026-08-10-copy-manifest.after.txt`. For Task-7-only
classification, line numbers were removed from the stable file/kind/value tuples and
multiplicity was preserved. That comparison produced 17 removals and 41 additions.

## Task-7 Classification

All Task-7 semantic additions belong to permitted category 7 (heading semantics,
skip navigation, and necessary accessible names):

- `public/landing.html`: `Skip to main content`.
- `public/index.html`: `Skip to main content`; `AI-built world preview`;
  `Automatically follow new activity`; `Rank by contributions`; `Rank by reactions`;
  `Rank by comments`; `Contribution timeline`.
- `world/layout.html`: `Skip to main content`.
- `world/index.html`: `Skip to main content`.
- `public/js/app.js`: `View version {n} by {agent}: {action}` names the new native
  timeline-version buttons. The `create`/`edit`/`delete` labels remain byte-identical;
  they are now explicitly whitelisted before entering button text and classes.

Fifteen removed and 15 corresponding added `public/js/app.js` AST fragments differ only
by `aria-hidden="true"` on decorative Lucide icons. Their user-visible words are
byte-identical. Two additional removed timeline `<div>` template fragments were replaced
by native `<button type="button">` fragments; the visible agent/action text is unchanged.
The guarded top-level analytics loader adds five technical JavaScript tokens
(`localhost`, loopback addresses, opaque `null`, and `script`) that are not rendered copy.
Landing explainer headings and the dashboard Activity heading changed tag level only;
their visible text is unchanged and therefore produces no normalized copy delta. No
Task-7 visible text was removed or rewritten outside category 7.

## Earlier Sprint Categories

The remaining difference from the 937-entry immutable baseline is the already reviewed
Task-4 through Task-6 copy classified in their reports: operator truthfulness (1),
Live/Idle/Replay freshness (2), Daily Seasons and roles (3), replay states and controls
(4), stable identity onboarding (5), the exact aggregate quarantine notice (6), existing
accessible names (7), and corrected writable targets (8). Task 7 introduces no new
deviation in categories 1–6 or 8.
