# Change Atlas — manual pilot protocol

**Date:** 2026-07-12
**Facilitator:** Ryan Orban
**Status:** pre-registered before any session runs. Gates below are frozen; edits after the first session go in a dated addendum, not in place.
**Context:** Successor experiment to the PCC falsification (`docs/pcc-validation-report.md`, PR #22 closed unmerged). PCC failed because it assigned semantic judgment to a machine. This pilot tests the inverted thesis before any product code exists.

## Thesis under test

AI has made producing code cheap and producing *convincing* code equally cheap. The bottleneck in reviewing agent-generated PRs is not defect detection by machines — it's the time a human needs to reconstruct enough of a system model to judge the change. A hand-built "Change Atlas" attached to a PR should materially accelerate that reconstruction **without amplifying false confidence**.

Falsifiable form: reviewers with an atlas reach accurate understanding faster than without one, detect seeded defects at least as often, and do not become more confident on the PRs where they're wrong. If the atlas produces faster *conviction* without better *detection*, the thesis is false and the product shouldn't exist.

## Method

**Materials.** 6–8 pull requests, all substantially agent-generated, drawn from a live codebase the reviewers work near but don't fully hold in their heads. The set is salted, known only to the facilitator:

- 2 PRs with seeded defects (realistic, injected by the facilitator, ground truth documented before sessions).
- 1 PR rebuilt from the case-06 laundered-evidence fixture: correct-looking change whose test's expected values mirror the implementation's own expression.
- The remainder clean, as far as the facilitator and codeowner know.

**Reviewers.** 2–3 senior engineers. They're told the study measures review comprehension; they are not told any PR is salted.

**Design.** Within-subject: each reviewer sees each PR once, half with an atlas and half raw, counterbalanced so every PR is reviewed both ways across the panel. Order randomized. Sessions time-boxed at 45 minutes per PR.

**The atlas.** One hand-written markdown document per PR. No tooling. Panels, in fixed order so per-panel usage is comparable:

1. Orientation — what this subsystem does, one screen.
2. Behavioral delta — before/after behavior, stated as claims, not prose summary.
3. Model-invalidation notes — "if you last touched this in Q1, here's what no longer holds."
4. Tests organized by the behavior they exercise, with a differential witness where available (passes on proposed change, fails on a known-bad variant, expected-value source shown).
5. Invariant contact — which changed paths touch things the team treats as invariants.
6. Analogous prior changes and what happened after them.
7. Open questions and explicit assumptions, marked as hypotheses.

Every statement links to code, test, or history. Machine-style inferences (there are none in this pilot — everything is hand-written, but the format marks what *would* be inferred) are visually tagged as hypotheses.

**Measurements per session.**

- Time to accurate explanation: reviewer explains the change back at the point they'd normally start writing review comments; facilitator scores against a ground-truth rubric written before sessions.
- Defect detection: whether seeded defects and the laundered oracle are caught, and at what minute.
- Confidence: before verdict, reviewer states 0–100 confidence that merging is safe. Compared against ground truth on salted PRs — miscalibration is the number that matters.
- Substantive questions asked (count and whether they'd have blocked a real merge).
- Per-panel usage: which panels the reviewer actually consulted (observed, plus exit interview).
- Verdict: would they approve, and did the atlas change the decision they'd have made raw.
- Atlas construction minutes per PR (facilitator's own time — the COGS proxy and the future automation bar).

## Pre-registered gates

This is a signal-finding pilot with n≈3 reviewers; gates are directional and behavioral, not statistical. No p-values will be reported — that lesson is paid for.

- **G1 — Detection (kill-on-fail, immediately).** Seeded-defect detection with atlas ≥ without, and at least one atlas-assisted reviewer catches the case-06 mirror. If atlas-assisted detection is *lower*, or if reviewers who miss the laundered defect report *higher* confidence with the atlas than raw reviewers do, the atlas is a fluency amplifier. Kill; do not iterate.
- **G2 — Comprehension.** Median time-to-accurate-explanation improves ≥40% with atlas. Below that, this is a nice summary, which is commodity.
- **G3 — Pull.** At least one reviewer asks, unprompted, to have an atlas on a future real review. Zero pull kills regardless of G1/G2.
- **Diagnostics (not gates):** per-panel usage distribution; construction cost per atlas. Prediction, registered now: value concentrates in panels 4, 5, and 6; panel 2's flow-model content is where "nice summary" hides.

## Decision rule

- Any kill gate fires → stop. Write the negative result next to the PCC report and keep both.
- G1–G3 pass → **narrow, don't build the vision**: automate only the panels that carried observed usage and lift, one language, one repo shape. Re-run this same protocol with the automated atlas against these same reviewers; the automated version must retain the hand-built effect or the automation, not the thesis, is what failed.
- Mixed → one redesign of the atlas format, one rerun. No second redesign.

## Scope guards

- No product code during the pilot, with one exception: the differential witness runner (execute bound tests at head and against a known-bad variant), because it's purely mechanical, it survived both prior architecture generations, and it's needed to populate panel 4 honestly.
- No LLM writes any atlas content in this pilot. The pilot measures the ceiling of the artifact, not the current quality of generation.
- No dashboards, no PRD. The next document after this one is the results write-up.

**Total budget:** ~2 weeks. Facilitator time dominates (atlas construction, expected 1–3 h per PR). Reviewer time ≤ 6 h each.
