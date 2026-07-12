# PCC validation benchmark — blind historical replay

Falsification benchmark for the Proof-Carrying Changes (`cerberus check`)
pipeline, built around Cerberus's own historical defect: the original MVP
(PR #1, merged 2026-02-17) shipped SPRT decision boundaries for the wrong
likelihood-ratio convention, inflating the actual Type I error to ~15-16%
while advertising 5% — and its test suite passed, because the boundary test
restated the implementation's own formulas.

## One command

```
npm run build && node benchmarks/pcc/run.mjs
```

Options: `--det-runs N` (default 5), `--llm-runs N` (default 5; requires
`OPENAI_API_KEY`, set 0 to skip), `--model M` (default `gpt-5.2`).

The standalone mathematical oracle can be run on its own:

```
node benchmarks/pcc/oracle/sprt-oracle.mjs
```

## Cases

| case | construction | expected |
|---|---|---|
| case-01 | Historical PR #1: base = pre-implementation planning tree, head = the merged MVP tree with swapped boundaries; original PR description verbatim; contemporaneous tests (80/80 green, boundary test circular) | must NOT pass; the correct refusal cites unsupported statistical claims / unevidenced core invariant, not just PR size |
| case-02 | Boundary correction + independent evidence: Wald-derived decision counts under asymmetric α/β and a fixed-seed Monte Carlo of empirical error rates (verified to FAIL against the buggy implementation) | pass / pass-with-warnings |
| case-03 | Evidence laundering: swapped boundaries reintroduced while the boundary test's assertions are rewritten to restate the buggy formulas; description claims "standard Wald formulation", "all tests pass" | needs-evidence / block |
| case-04 | Clean negative control: correct, independently evidenced input-validation change to the same statistical module | pass / pass-with-warnings |
| case-05 | Matched pair, independent variant: corrected boundaries + new test asserting hand-computed numeric Wald constants | pass / pass-with-warnings |
| case-06 | Matched pair, circular variant: byte-identical to case-05 except the new test's expected values restate the implementation's formula expression | needs-evidence / block |

### The matched pair (case-05 vs case-06)

case-02 vs case-03 confounded evidence independence with implementation
correctness, diff shape, and description text. The matched pair removes every
confound: identical implementation diff, identical `tests/stats.test.ts`
touch-up, identical description (which claims independent derivation — true
for case-05, the laundering claim for case-06), the same new test file path,
and the same test names. The only difference is where the expected values in
`tests/boundary-decision.test.ts` came from: numeric constants derived by hand
from Wald's inequalities (case-05) versus `Math.log((1 - config.alpha) /
config.beta)` copied from the implementation (case-06). The circular variant
could never have caught a wrong formula at authoring time — the exact
provenance failure of the historical defect's contemporaneous test. Any
configuration that accepts case-05 and refuses case-06 demonstrates real
evidentiary discrimination; identical verdicts on both demonstrate the checker
reads surface structure only.

### Scoring

A run passes when its verdict matches the hidden expectation. For cases that
list `evidentiaryRuleIds` (case-01), a refusal counts only if one of those
rules appears in the product's reasons: refusing the historical defect because
the PR is large is refused-for-the-wrong-reason and scores as a failure.
needs-evidence and split-required never score as PASS.

Each case runs under two policies: the product's embedded advisory-first
default, and `fixtures/policies/strict.yaml` (PRD Phase 2 posture: block rules
on, plus a repo invariant requiring evidence for `src/stats.ts` /
`src/runner.ts` changes).

## Leakage controls

- Case repositories are freshly constructed two-commit git repos (via
  `git archive`, which exports trees only) — no future history, no later
  commit messages, no fix commit.
- Neutral repository, branch (`main`), and commit names; nothing in the
  visible trees names the benchmark, the defect, or expected verdicts.
- Expected verdicts live only in `oracle/expectations.json`, which is read by
  the scorer AFTER raw results are persisted, and is never copied into a case
  repository.
- The mathematical oracle (`oracle/sprt-oracle.mjs`) derives the correct
  boundaries from Wald (1945) first principles for Cerberus's actual LR
  convention (stated before derivation), uses asymmetric α/β so swapped
  formulas cannot pass accidentally, tests both terminal directions and
  indifference-zone behavior, and confirms the historical defect by fixed-seed
  Monte Carlo (20,000 reps) with independently implemented Wilson intervals —
  it shares no code with `src/stats.ts`.

## Results layout

Each run writes `results/<timestamp>/`:

- `oracle-results.json` — independent math oracle output
- `construction.json` — per-case SHAs and changed files
- `raw/` — one file per product invocation: full argv, unedited stdout
  (product JSON), stderr, exit code, wall time. Written before any scoring.
- `summary.json` — machine-readable scoring (fixture, expected, actual,
  claims extracted, evidence cited, unsupported obligations, explanation,
  latency, model, pass/fail, pointer to raw)
- `summary.md` — human-readable matrix

Raw results are immutable evidence: do not edit them. Runs made against
superseded fixture revisions carry a `SUPERSEDED.md` marker and are kept.
`results/fixture-integrity/` records that each case tree's own vitest suite
behaves as its PR description claims, and that case-02's evidence test fails
against the buggy implementation (discriminating power).

## Scope

This directory contains benchmark-side code only: fixtures, an adapter/runner
that invokes the real `dist/cli.js check` pipeline, and independent scoring.
It makes no changes to the product and must not be imported by it.
