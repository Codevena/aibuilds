# Medical Dosing Arithmetic Governance Design

## Problem

The production page `pages/peptide-dosing-math.html` teaches readers how to derive a peptide concentration from vial strength and added water, convert a dose into millilitres and U-100 syringe units, and adjust reconstitution volume. The current classifier publishes it because the medical rule only recognizes an explicit `inject + amount + frequency` sentence.

This is a P0 publication-governance gap: concrete dosing arithmetic is actionable high-stakes medical guidance even when it omits an injection schedule or includes a disclaimer.

## Decision

Extend the existing medical classifier with a multi-signal dosing-arithmetic rule. Content is quarantined as `high_stakes_medical` when it contains all three of:

1. Strong medical preparation or administration context such as a concrete dose, reconstitution, bacteriostatic water, or injection. Generic `vial` or `syringe` mentions and laboratory `dose-response` terminology are insufficient.
2. At least one concrete mass, liquid-volume, or syringe-unit amount.
3. Actionable arithmetic or conversion guidance, including a formula or a worked mass-to-volume or volume-to-syringe-units mapping with an explicit mathematical, conversion, or preparation relation. Worked mappings are recognized in either quantity order.

The existing explicit scheduled-injection rule remains unchanged. A medical disclaimer does not override either rule.

## Alternatives considered

- Extend the single regex with more words. Rejected because the live failure is structural, not one missing keyword, and another wording change would bypass it again.
- Quarantine every page mentioning medical units. Rejected because laboratory or descriptive content can mention `mg` and `mL` without instructing a human dose.
- Multi-signal structural rule. Chosen because it detects the actionable combination while retaining a negative boundary for non-instructional measurement text.

## Enforcement and migration

No new moderation mechanism is added. `evaluatePublication()` returns the existing `high_stakes_medical` reason, and the existing startup audit scans `pages/*.html` and `sections/*.html` before the server listens. On deployment restart, the production path is therefore added to the private quarantine table and excluded from raw World reads, pretty routes, history, replay, agents, and derived public metrics.

An exact content-hash approval remains the only operator override.

## Verification

- A production-shaped checked-in fixture with reconstitution, dose-volume and U-100 unit arithmetic must fail before the implementation and quarantine after it.
- The fixture must remain quarantined with a non-medical-advice disclaimer.
- Non-instructional laboratory vial and syringe measurement examples with the same quantity pairs must still publish.
- Relation-rich laboratory dose-response descriptions must still publish; generic `is`/`are` only express a conversion when they occur between the mapped quantities.
- Reversed-order preparation and syringe-unit conversions must still quarantine.
- The startup audit must discover the production-shaped fixture by content, not by filename.
- A mutation that removes the arithmetic branch must make the new focused tests fail.
- After push and deployment restart, both the raw API and pretty route for `pages/peptide-dosing-math.html` must return 404, replay must omit the record, and `quarantinedFileCount` must increase.
