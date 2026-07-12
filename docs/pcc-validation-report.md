# Proof-Carrying Changes — Validation Report

**Date:** 2026-07-11 (revised same day — audit-only correction pass, see below)
**Scope:** Falsification audit of the PCC implementation on `feat/proof-carrying-changes` (HEAD `1530af5`), semantic audit of Cerberus's statistical machinery, and a blind historical replay against Cerberus's own swapped-SPRT-boundary defect.
**Posture:** The implementation was treated as an untrusted hypothesis. No product code was changed; benchmark failures were preserved, not repaired.

**Correction pass (r3).** After external review of the first revision, the audit itself — not the product — received one correction pass:

1. **Scorer**: a case-01 run now scores as a pass only when the refusal cites an evidentiary rule (`needs_evidence_material_claim`, `needs_evidence_invariant`, or `block_critical_claim_without_direct_evidence`). Refusing the historical defect for PR size no longer counts. This flips three case-01 cells from PASS to FAIL relative to the first revision; the underlying product behavior is unchanged.
2. **Matched pair**: cases 05/06 isolate evidence independence with zero confounds (§4.1) — the earlier case-02-vs-case-03 comparison confounded independence with implementation correctness, diff shape, and description text.
3. **Clean rerun**: the scored run below was executed with nothing else touching the case repositories (the first revision's run had a concurrent fixture-integrity checkout in flight; its deterministic cells were 5/5 consistent, but the race is now excluded by construction rather than argued harmless).
4. **Statistics presentation**: run counts are no longer pooled into rates ("65% false-block") — 5 runs of a deterministic cell are one observation repeated, not five samples (§4.4).
5. **Omitted findings**: seven mechanism-level findings from the branch's code review that the first revision left out are now recorded (§6).

Earlier result directories are preserved unmodified; superseded ones carry `SUPERSEDED.md` markers.

---

## 1. Baseline

| item | value |
|---|---|
| branch | `feat/proof-carrying-changes` |
| commit | `1530af5675541fd685d1ab7075a14337c198b3d5` |
| tracked modifications | none |
| untracked files | `.playwright-mcp/`, `docs/blog/figures/_preview.html`, `docs/blog/figures/_single.html`, 10 loose blog-figure PNGs at repo root (pre-existing; unrelated to PCC) |
| build (`npm run build`) | success (tsup, ESM) |
| typecheck (`npm run typecheck`) | 0 errors |
| lint | no lint script exists in `package.json` — not run, not claimed |
| tests (`npm test`) | 186/186 pass across 14 files (~8s) |

**Implementation entry points.** `src/cli.ts` `check` command → `src/pcc/check.ts` `runCheck()` → `git.ts` (change collection) → `detectors.ts` (deterministic risk findings) → `claims.ts` (LLM claim generation with deterministic fallback) → `evidence.ts` (token-overlap claim-to-test mapping) → `policy.ts` (invariants + deterministic verdict) → `report.ts` (markdown/JSON + persistence to `.cerberus/checks/`). Batch replay: `replay.ts` (`--replay`, `--replay-merges`).

**End-to-end invocation (recorded).** `node dist/cli.js check 'ca7cf45..1530af5' --no-llm --json` → verdict `split-required`, exit 3, result persisted to `.cerberus/checks/2026-07-12T01-19-10-692Z.json`. The pipeline runs end to end from the CLI without mocks.

**Historical defect (independently verified, §3).** PR #1 (`ca7cf45`, merged 2026-02-17) shipped `createSPRT` with boundaries `A=(1−β)/α`, `B=β/(1−α)` while the accumulator adds `log(p0/p1)` per success — the boundaries for the opposite likelihood-ratio convention. Fixed in `6dfbf42` (2026-02-24). The contemporaneous test (`tests/stats.test.ts`, "boundaries are correctly calculated from alpha/beta") asserted the implementation's own formulas back at it, so 80/80 tests were green while the actual Type I error ran ~3× the advertised α.

## 2. PRD traceability matrix

Statuses: implemented / partial / stubbed / missing / semantically invalid / externally unvalidated. "Executable evidence" means something that was actually run during this audit, not the existence of a file.

| PRD requirement | production code path | executable evidence | observed behavior | status | material gap |
|---|---|---|---|---|---|
| GitHub event / PR ingestion (§6.2, §15.1) | none — CLI only (`src/cli.ts check`) | `grep octokit\|webhook\|checks.create src/` → no matches | analysis is driven by a local git range, not PR events | **missing** | no GitHub App, no webhook, no PR context; `docs/pcc/github-actions.md` is a usage guide, not integration code |
| Claim generation (§8.2) | `src/pcc/claims.ts` `generateClaims` | benchmark LLM runs (gpt-5.2) + deterministic fallback runs | LLM produces structured claims from redacted hunks; on missing key/parse failure falls back to findings-derived claims + explicit "intent unknown" | **implemented** | fallback claims carry max severity `medium` from warning findings, so deterministic mode rarely produces a *material* claim (see §4) |
| Claim editing / claim history across updates (§8.2, §6.3) | none | — | claims are regenerated per invocation; nothing accepts reviewer edits or preserves history | **missing** | a core PRD workflow (accept/edit claims) has no code path |
| Intended-change vs preserved-invariant separation (§7.2) | `ClaimKind` in `src/pcc/types.ts`; prompt in `claims.ts` | benchmark LLM runs emit both kinds | separation exists and renders in report | **implemented** | deterministic fallback emits only `behavior-change` claims |
| Changed-component / blast-radius analysis (§8.5, §8.1) | `detectors.ts` `clusterKey` (top-level-dir clustering) | `check` on PR-sized range → `split-required`, 4 clusters | clustering by directory prefix + basename affinity; no dependency graph, no downstream-service analysis | **partial** | PRD's repository indexing (code/dependency graph, test-to-code map, ownership) does not exist; "blast radius" is directory arithmetic |
| Claim-to-test mapping (§8.3) | `evidence.ts` `mapEvidence` (token overlap ≥ 2) | benchmark runs; links carry rationale strings | static lexical mapping; strongest-link-per-file dedup | **implemented** (static only) | mapping quality is untested against ground truth; no execution |
| Claim-to-CI mapping (§8.3, §6.2) | none — `execution: "not-verified"` is a hardcoded literal (`types.ts:100`) | benchmark runs show every link `execution: not-verified` | no CI artifacts are read; tests are never run | **missing** | "evidence" is the existence of matching test text, not a result — the PRD's central object (executable evidence) is not executable here |
| Evidence provenance & SHA binding (§9.2, §15.1) | `git.ts` merge-base normalization; `report.ts` records range label | result JSON records `range` | analysis is bound to a resolved range; artifacts carry no content hashes or SHAs | **partial** | an evidence link can't be tied to the exact blob it described; re-running on a moved branch silently rebinds |
| Evidence independence / circularity detection (§8.3, §16.5) | `evidence.ts`: `independent = !(changedInRange && assertionsRewritten && claimTouchesImpl)` | benchmark case-03 (det + LLM); policy unit tests | detects impl+expectation co-modification only when assertion lines were rewritten in the same range and the claim names impl files | **partial** | newly added tests are always "independent" by construction; a claim's `status: supported` ignores independence entirely — only the strict-policy block path consumes it |
| Weakened / self-modified tests (§8.5) | `detectors.ts` `detectTestIntegrity` | unit tests; findings in baseline e2e run | deleted tests, net assertion removal, skip markers → warnings | **implemented** | equal-count assertion rewrites (the case-03 shape) produce no finding |
| Unsupported-claim detection (§10.2) | `evidence.ts` status + `policy.ts` needs-evidence path | benchmark runs | material unsupported claims → `needs-evidence` with per-claim reasons | **implemented** | "supported" = any lexical link, including non-independent ones |
| Permission / migration / API risk (§8.5, §18.5) | `detectors.ts` regex detectors with confidence levels | unit tests (tests/pcc/detectors.test.ts); baseline run findings | path- and content-regex detection, destructive-SQL check, rollback detection | **implemented** | pattern-based only; no semantic analysis; known gaps in secret patterns documented in repo memory |
| Unrelated-change detection / split (§8.4) | `detectors.ts` `detectUnrelatedChanges` | benchmark case-01 → `split-required` | cluster count over threshold → split verdict | **implemented** | crude granularity (top-level dirs); benchmark shows it fires on the *reason-less* dimension of case-01 (size, not evidence) |
| Verdict computation (§9.1) | `policy.ts` `evaluatePolicy` — deterministic precedence: block > split-required > needs-evidence > warnings > pass | all benchmark runs; exit-code mapping in `check.ts` | five PRD verdicts, semantic exit codes, reasons carry rule IDs | **implemented** | precedence quirk: `split-required` masks `needs-evidence` reasons entirely (case-01) |
| Override + rationale recording (§8.6, §11.6) | `check.ts` `parseOverride`; recorded in JSON + markdown | `--override "name: reason"` exercised in repo tests | override recorded with owner, rationale, overridden verdict; exit clamped to 0 | **implemented** | no identity, no audit store beyond the per-run JSON file; anyone can pass any owner string |
| Post-merge outcome tracking (§6.4, §10.2 #11) | none — `replay.ts` is pre-merge batch analysis, not outcome tracking | `grep revert\|incident\|outcome src/pcc/` → only rollback regexes | nothing observes merges, reverts, incidents, or follow-ups | **missing** | the PRD's learning loop (and its defensibility story, §14.3) has no implementation |
| GitHub Check publication (§8.7, §18.6) | none | — | report is stdout markdown/JSON + local file | **missing** | `docs/pcc/github-actions.md` shows exit-code wiring users could build; the product publishes nothing |
| Fail-open vs fail-closed | `check.ts`: advisory/override clamp exit 0; config errors exit 2; runtime errors exit 4; empty range = explicit pass with reason | baseline + benchmark runs; empty-range path unit-tested | gating errors fail closed; advisory mode documented fail-open | **partial** | claim generation fails *open*: on missing API key or LLM error it silently (stderr warning only) degrades to weak deterministic claims, which under the default policy usually means fewer obligations and a greener verdict |
| Repository indexing (§8.1) | `git.ts` `listRepoTestFiles` only | benchmark proxy-evidence links | test-file inventory via `git ls-files` | **missing** (beyond test list) | no dependency graph, no test-to-code map, no history index |
| Team dashboard (§10.2 #12) | none | — | — | **missing** | — |
| Design partners on live PRs, blocking enabled, pilot metrics (§18 #10-12, §12.4) | not implementable as code | — | — | **externally unvalidated** | no code can satisfy these; they must not be claimed |

**Summary.** The implemented core is real and runs end to end: deterministic detectors, static claim/evidence mapping, a deterministic policy engine, override recording, and batch replay. What's missing is concentrated in exactly the places the PRD calls the product's moat: GitHub-native operation, executable evidence (running tests/CI and binding results), claim editing, indexing, and the post-merge learning loop. Nothing here is stubbed or mocked — absent things are genuinely absent, present things genuinely execute.

## 3. Cerberus statistical machinery — semantic audit

**Structural finding first:** `src/pcc/` contains zero references to SPRT, Wilson intervals, or Benjamini-Hochberg (`grep -rn "sprt\|wilson\|benjamini" src/pcc/` → no matches). The PCC merge verdict is computed by a deterministic policy engine over deterministic findings and static evidence links. What PCC reuses from Cerberus is non-statistical infrastructure: YAML+Zod config loading, the provider clients, exit-code semantics, persistence helpers, and git spawn discipline.

That means the central risk named for this audit — heterogeneous evidence (tests, static checks, provenance, LLM output) treated as interchangeable Bernoulli trials — **was not committed**. There is no SPRT over claims, no BH family over adaptively extracted claims, no confidence score laundered into a p-value in the PR-verdict path. The sound boundary ("deterministic evidence and vetoes → policy engine → abstention when evidence is insufficient; Cerberus's statistics reserved for genuinely repeated stochastic observation") is the architecture that was actually built.

Every use of the statistical machinery in the repository, audited per the required schema:

### 3.1 SPRT per contract in `cerberus run` (`src/runner.ts:185-240`)

- **Decision:** does this agent's pass rate on this scenario meet the contract threshold?
- **Random variable / trial:** one agent invocation evaluated against a contract → Bernoulli success/failure.
- **H0 / H1:** H0: p = p0 (agent meets threshold); H1: p = p1 (degraded). The code's "accept" = accept H0.
- **p0 / p1:** p0 = contract `threshold`; p1 = max(0.01, threshold − 0.10). The 0.10 indifference gap is a hardcoded convention, not derived from any cost model.
- **α / β:** α = 1 − `confidence` (Type I: reject a good agent); β = 0.20 hardcoded (Type II: accept a degraded agent). β is not user-visible or documented in config.
- **LR convention:** Λ = P(data|H0)/P(data|H1); success adds log(p0/p1) > 0, so evidence for H0 accumulates upward.
- **Stopping rule:** accept when logΛ ≥ log((1−α)/β); reject when logΛ ≤ log(α/(1−β)); truncated at `trials` → inconclusive (truncation's effect on realized error rates is unquantified).
- **Independence:** trials are sequential invocations of the same scenario. Approximately independent for stateless API calls; provider-side drift, caching, and shared task difficulty violate iid in ways the blog post itself concedes ("it's a mixture, not a single fixed rate"). Adequate as an engineering approximation; not adequate for the advertised error rates to be taken literally.
- **PASS/FAIL/INCONCLUSIVE:** accept → pass; reject → fail; truncation or error-rate abort → inconclusive/fail. Exit codes gate CI.
- **Effect on merge decisions:** none in PCC. `cerberus run` gates agent test suites, not pull requests.
- **Classification: valid only for repeated stochastic evaluation** — which is where it lives. Within that scope it's statistically defensible post-fix, with the caveats above (fixed β, arbitrary indifference gap, composite-vs-simple hypothesis slippage, unmodeled truncation).

### 3.2 Wilson score intervals in `cerberus run` (`src/runner.ts:258`)

- **Decision:** none — reporting only. The CI is attached to results; pass/fail comes from SPRT.
- **Classification: statistically justified** as a descriptive interval for a binomial proportion, with the standard caveat that a CI computed on SPRT-stopped data inherits optional-stopping bias (the interval is computed on whatever n the SPRT stopped at; coverage is not the nominal one). Harmless because nothing gates on it.

### 3.3 Benjamini-Hochberg / Bonferroni in `cerberus run` (`src/runner.ts:339-371`)

- **Decision:** nominally, multiple-testing correction across contracts. Actually: none.
- **The inputs are not p-values.** `applyCorrection` feeds BH hardcoded placeholders — 0.001 if a contract passed, 0.999 if it failed, 0.5 if inconclusive (the code's own comment calls it "a proxy p-value... a simplification"). These are labels, not tail probabilities under any null.
- **The output is unused.** `correctedAlpha` is annotated onto results; suite status is computed purely from per-contract SPRT decisions (`runner.ts:377-385`). No decision changes.
- **Classification: category error, but decorative.** As implemented it's statistical theater: the config option `correction: bh` implies error control across contracts that does not happen. It should either compute real p-values and act on them or be removed. It has no path into PCC.
- The `stats.ts` BH *function itself* is a correct implementation of the procedure (verified against hand-worked examples in `tests/stats.test.ts`); the category error is in `runner.ts`'s inputs, not the formula.

### 3.4 Statistical machinery in `cerberus check` (PCC)

- **Uses found: none.** Audit method: grep for every exported symbol of `stats.ts` across `src/pcc/` and `cli.ts` check path; read of all nine PCC modules.
- **Classification of the reuse that does exist (config/providers/output/errors): reusable infrastructure but not statistical inference.** Correctly so.
- One naming hazard: `EvidenceLink` and `Claim.confidence` carry the *word* confidence (`"llm" | "deterministic" | "unknown"`), and findings carry `confidence: "high" | "low"`. These are provenance labels, not probabilities, and nothing arithmetic is done with them. Keep it that way.

**Verdict on semantic fit.** The no-SPRT interpretation of PCC isn't just more coherent — it's what exists. The right statement of the boundary going forward: Cerberus's sequential statistics are appropriate for *offline calibration of stochastic analyzers* (e.g., measuring whether the LLM claim generator's precision/recall on a labeled corpus meets a threshold — genuinely repeated stochastic trials with preregistered hypotheses) and for agent-suite gating in `cerberus run`. They are not appropriate for aggregating heterogeneous PR evidence, and the implementation, to its credit, doesn't try. The one piece of statistical machinery that should be deleted or done properly is `applyCorrection`'s pseudo-p-value BH pass.

### 3.5 Independent mathematical oracle

The oracle (`benchmarks/pcc/oracle/sprt-oracle.mjs`) shares no code with `src/stats.ts`. It states the LR convention first (Λ accumulates evidence for H0 upward), derives boundaries from Wald's 1945 inequalities in the standard convention and inverts them, uses **asymmetric α/β** (0.05/0.20 and 0.01/0.20) so swapped formulas can't pass accidentally, checks both terminal directions, probes the indifference zone, and runs fixed-seed Monte Carlo (mulberry32, 20,000 reps, cap 2,000 trials) with an independently implemented Wilson interval. Result: `ORACLE_CONFIRMED`, 8/8 checks.

| quantity (α=0.05, β=0.20, p0=.90, p1=.80) | derived (correct) | historical (buggy) |
|---|---|---|
| upper boundary | log(4.75) = 1.5581 | log(16) = 2.7726 |
| lower boundary | log(0.0625) = −2.7726 | log(0.25) = −1.3863 |
| consecutive successes to accept | 14 | 24 |
| consecutive failures to reject | 4 | 3 |
| empirical Type I at p=p0 (95% Wilson CI) | 0.0396 [0.0370, 0.0424] | **0.1540 [0.1491, 0.1591]** |
| empirical Type II at p=p1 | 0.1903 | 0.0508 |

At α=0.01/β=0.20 the buggy Type I is 0.1568 against an advertised 1%. The historical defect is confirmed independently of the fix commit: the buggy boundaries reject genuinely good agents at ~3× (default) to ~16× (99% confidence) the advertised rate. The fix commit's "~16%" claim is accurate. The current `src/stats.ts` boundaries match the derived ones exactly.

## 4. Blind historical replay — methodology

Benchmark home: `benchmarks/pcc/` (fixtures, adapter/runner, hidden oracle, immutable raw results). One command: `npm run build && node benchmarks/pcc/run.mjs`. The runner invokes the real `dist/cli.js check` pipeline — verdict logic is never mocked. No production code was changed to make the benchmark runnable; the only adapter needed was benchmark-side repo construction, because `check` already accepts an explicit range and `--description-file`.

### 4.1 Cases

| case | base tree | head tree | description given to product | expected |
|---|---|---|---|---|
| case-01 | `b92836e` (pre-implementation planning docs) | `ca7cf45` (merged MVP with swapped boundaries) | PR #1 body, verbatim | must NOT pass; correct refusal is evidentiary, not size |
| case-02 | `ca7cf45` + contemporaneous companion test files | corrected boundaries + `tests/error-control.test.ts` (Wald-derived counts, asymmetric α/β, fixed-seed Monte Carlo) | fresh neutral PR text | pass / pass-with-warnings |
| case-03 | corrected tree | swapped boundaries reintroduced + boundary test assertions rewritten to restate the buggy formulas | neutral "align with standard Wald formulation; tests updated; all tests pass" | needs-evidence / block |
| case-04 | corrected tree | input validation added to `wilsonScoreInterval` + independent test with hand-computed reference intervals | fresh neutral PR text | pass / pass-with-warnings |
| case-05 | buggy tree + companion files | corrected boundaries + new `tests/boundary-decision.test.ts` asserting **hand-computed numeric Wald constants** | shared neutral PR text claiming independent derivation (true here) | pass / pass-with-warnings |
| case-06 | identical to case-05 | identical to case-05 except the new test's expected values are `Math.log((1 - config.alpha) / config.beta)` — the implementation's own expression | byte-identical description (the independence claim is false here — laundering) | needs-evidence / block |

**The matched pair (05/06).** `diff -r` between the two fixture trees shows exactly one differing file: `tests/boundary-decision.test.ts`, and only in where its expected values came from. Implementation diff, `stats.test.ts` touch-up, description text, test file path, and test names are identical. Ground-truth evidence independence is the only manipulated variable: case-05's numeric constants were derived from Wald's inequalities and demonstrably fail 2/2 against the buggy implementation (recorded in `results/fixture-integrity/matched-pair-integrity.txt`); case-06's expressions mirror the implementation, so a test authored this way against a buggy implementation would have restated the buggy formulas and passed — the exact provenance failure of case-01's contemporaneous test. Any configuration that accepts 05 and refuses 06 demonstrates evidentiary discrimination; identical treatment demonstrates the checker reads surface structure only.

Each case ran under the embedded advisory-first **default** policy and a **strict** policy (PRD Phase 2 posture: three block rules on, plus invariant `statistical-decision-core` requiring evidence for `src/stats.ts`/`src/runner.ts`), in **deterministic** mode (`--no-llm`) and **LLM** mode (`--model gpt-5.2`), 5 runs per cell in separate processes. 120 invocations total.

### 4.2 Leakage controls

- Case repos are freshly built two-commit git repositories; trees exported with `git archive` (no history). The fix commit, later history, later commit messages, and expected verdicts are not present in any evaluator-visible tree.
- Neutral names throughout: branch `main`, commit subjects are plausible PR titles, fixture IDs are `case-01..04`. Nothing in a visible tree names the benchmark, the defect, or a verdict.
- Expected verdicts live only in `benchmarks/pcc/oracle/expectations.json`, read by the scorer after raw results are written. The oracle directory is never copied into a case repo, and the product only reads the case repo plus the description file.
- The description given for case-01 is the historical PR body (contemporaneous). Descriptions for constructed cases were written fresh; case-03's deliberately launders ("standard Wald formulation", "all tests pass") without naming any expectation.
- Fixture integrity (recorded in `results/fixture-integrity/vitest-logs.txt`): every case's head suite is green (80/80, 85/85, 80/80, 88/88), every constructed base suite is green (80/80 ×3), and case-02's evidence test fails 4/5 against the buggy implementation — i.e. the "independent evidence" genuinely discriminates, and case-03's "all tests pass" laundering claim is genuinely true.
- Fixture revision note: the first two result directories (`01-32-19`, `01-32-43`) used fixture revision r1, whose case-02/04 base trees lacked two contemporaneous companion files (the historical fix's `tests/e2e.test.ts` float tolerance and `timeout-config.yaml` trial count), leaving 3 failing tests in those heads. They're preserved with `SUPERSEDED.md` markers. The r2 run (`2026-07-12T01-36-38-347Z`) had a concurrent fixture-integrity checkout in flight while the benchmark ran; it is preserved but superseded.
- The scored r3 run below was executed cleanly: all fixture-integrity checks (including the matched pair's, in `results/fixture-integrity/matched-pair-integrity.txt`) ran in separate scratch trees before the benchmark started, and nothing touched the case repositories while it ran.

### 4.3 Results (unedited)

Scored run: `benchmarks/pcc/results/2026-07-12T02-16-24-656Z/` (oracle output, per-case construction SHAs, 120 raw invocation records, machine-readable `summary.json`). This is the r3 clean rerun with the corrected scorer; the r2 run (`2026-07-12T01-36-38-347Z`) is preserved for comparison. The matrix below is copied verbatim from the generated `summary.md`:

| fixture | policy | mode | expected | verdicts (n) | consistent | evidentiary reason | cell pass |
|---|---|---|---|---|---|---|---|
| case-01 | default | det | NOT pass/pass-with-warnings | split-required×5 | true | no | FAIL |
| case-01 | default | llm | NOT pass/pass-with-warnings | split-required×5 | true | no | FAIL |
| case-01 | strict | det | NOT pass/pass-with-warnings | split-required×5 | true | no | FAIL |
| case-01 | strict | llm | NOT pass/pass-with-warnings | split-required×4, block×1 | false | yes | FAIL |
| case-02 | default | det | pass/pass-with-warnings | pass×5 | true | no | PASS |
| case-02 | default | llm | pass/pass-with-warnings | needs-evidence×5 | true | no | FAIL |
| case-02 | strict | det | pass/pass-with-warnings | needs-evidence×5 | true | no | FAIL |
| case-02 | strict | llm | pass/pass-with-warnings | block×4, pass-with-warnings×1 | false | no | FAIL |
| case-03 | default | det | needs-evidence/block | pass×5 | true | no | FAIL |
| case-03 | default | llm | needs-evidence/block | needs-evidence×5 | true | no | PASS |
| case-03 | strict | det | needs-evidence/block | needs-evidence×5 | true | no | PASS |
| case-03 | strict | llm | needs-evidence/block | block×5 | true | no | PASS |
| case-04 | default | det | pass/pass-with-warnings | pass×5 | true | no | PASS |
| case-04 | default | llm | pass/pass-with-warnings | pass×3, needs-evidence×2 | false | no | FAIL |
| case-04 | strict | det | pass/pass-with-warnings | needs-evidence×5 | true | no | FAIL |
| case-04 | strict | llm | pass/pass-with-warnings | block×4, pass×1 | false | no | FAIL |
| case-05 | default | det | pass/pass-with-warnings | pass×5 | true | no | PASS |
| case-05 | default | llm | pass/pass-with-warnings | pass×4, needs-evidence×1 | false | no | FAIL |
| case-05 | strict | det | pass/pass-with-warnings | needs-evidence×5 | true | no | FAIL |
| case-05 | strict | llm | pass/pass-with-warnings | pass×3, block×1, pass-with-warnings×1 | false | no | FAIL |
| case-06 | default | det | needs-evidence/block | pass×5 | true | no | FAIL |
| case-06 | default | llm | needs-evidence/block | pass×3, needs-evidence×2 | false | no | FAIL |
| case-06 | strict | det | needs-evidence/block | needs-evidence×5 | true | no | PASS |
| case-06 | strict | llm | needs-evidence/block | pass-with-warnings×1, block×2, pass×2 | false | no | FAIL |

Latency: deterministic mode 87–160ms per check; LLM mode 6.5–24s (gpt-5.2 claim generation dominates). Token cost is not exposed by the product (`costTokens: "not-exposed-by-product"` in summary.json). Deterministic cells were 5/5 consistent everywhere; 8 of 12 LLM cells were not decision-consistent across 5 runs.

### 4.4 Analysis

**The matched pair is decided by noise, not by evidence.** Cases 05 and 06 differ in exactly one thing — whether the new test's expected values were derived from theory or copied from the implementation — and the product cannot see it:

- **No configuration accepts 05 while refusing 06** (0 of 4). default+det passes both 5/5; strict+det refuses both 5/5; in LLM mode the acceptance counts are 4/5 vs 3/5 (default) and 4/5 vs 3/5 (strict) — indistinguishable, and the variation is claim-extraction sampling noise, not evidence analysis.
- **The circular test is certified at the product's highest evidentiary bar.** In every case-06 LLM run, the mirrored test forms links labeled `direct`, `independent: true` — it satisfies `qualifiesForBlock`, the strict policy's block rules, and the `statistical-decision-core` invariant. The laundered variant *passed the strict policy* in 3 of 5 runs. The `independent` label is assigned by structure (a newly added file is independent by construction), so provenance laundering that uses a new file is not merely missed — it is affirmatively certified.
- case-06's one "refusing" cell (strict+det) refuses the independent twin identically (deterministic mode has zero claims, so the invariant is unevidenced for both) — blanket refusal, not detection.

**Case-01 (historical defect): 0 of 4 cells pass under the corrected scorer.** All 20 runs refused it, but 19/20 via `split_required_unrelated_clusters` — cluster arithmetic that would refuse any 40-file PR regardless of its evidence — and the corrected scorer no longer accepts refused-for-the-wrong-reason. Exactly 1 run in 120 cited an evidentiary rule. In LLM runs the model extracted exactly the right claim — "Cerberus uses SPRT to adaptively stop early... with claimed Type I/II error control" (critical) — and the evidence mapper marked it **supported**, lexically satisfied by the very test file that restates the buggy formulas. Verdict precedence then masked everything behind the split recommendation.

**Case-03 vs case-02/04 replicate the same shape with confounds.** default+det passes the laundered change (zero deterministic claims when a description is present and no findings fire → nothing to gate); strict+det refuses all statistical changes identically; LLM cells refuse the laundered change and the good ones alike, via the same lexical-gap rules. The false-block mechanism is structural: one critical claim without a ≥2-token lexical match refuses a PR whose remaining claims all link to genuinely discriminating evidence (case-02), and `it("throws on negative n")` fails to evidence "throws RangeError when n < 0" because the overlap is one token (case-04).

**The purpose-built circularity detector never fired.** Across all 120 runs, zero evidence links were marked non-independent (`grep '"independent": false' raw/*.json` → 0 files), replicating the 80-run r2 result. Case-03's LLM-mode refusals are not circularity detection: its claims formed no links at all, so it was refused by the same lexical-gap mechanism that false-blocks the good changes.

**Outcome accounting.** Presented per configuration cell, not pooled across runs: a deterministic cell's 5 runs are one observation repeated (they were 5/5 identical in every deterministic cell), and LLM cells are 5 samples of a stochastic decision — so "26/40 runs" arithmetic from the first revision overstated the sample and is withdrawn.

| quantity | value |
|---|---|
| must-refuse cells scored PASS (cases 01, 03, 06) | 4 of 12 — and case-06's one refusal also refuses its independent twin |
| must-refuse cells where laundering was *approved* in ≥1 run | 4 of 12 (case-03 default+det 5/5; case-06 default+det 5/5, default+llm 3/5, strict+llm 3/5) |
| must-pass cells scored PASS (cases 02, 04, 05) | 3 of 12 — all three are default+det, the configuration that also approves both laundered changes |
| case-01 runs refused for the correct evidentiary reason | 1 of 20 |
| configurations accepting the independent twin while refusing the circular twin | 0 of 4 |
| evidence links marked non-independent | 0 in 120 runs (0 in 80 r2 runs) |
| LLM decision consistency | 4 of 12 LLM cells consistent; worst cell split across three verdicts |

No `needs-evidence` or `inconclusive` result was counted as a pass anywhere in scoring.

## 5. Competitive overlap

Method: current official documentation only (docs.coderabbit.ai, docs.qodo.ai / qodo-merge docs, docs.github.com, code.claude.com/docs, critique.sh), fetched 2026-07-11. **No competitor product was empirically tested during this audit — every "empirically tested" cell is NOT TESTED.** Marketing language was not counted as capability. Cells: **DOC** = documented capability, **doc-absent** = documentation explicitly disclaims it, **ND** = searched, not documented, **UNK** = couldn't determine.

| capability | Critique | Qodo Merge | CodeRabbit | Copilot code review | Claude Code Review | PCC (implemented behavior) |
|---|---|---|---|---|---|---|
| explicit behavioral claims | ND (structured *findings* with severity/confidence, not change claims) | partial-DOC (ticket-requirement compliance: fully/partially/not compliant) | ND (summaries + title/description/issue checks) | ND | ND (findings with severity; not PR claims) | **yes, runs** — but LLM-only; deterministic fallback emits near-zero claims |
| claim editing | ND | ND | ND | ND | ND | missing |
| claim-to-evidence mapping | ND | partial-DOC (changes scored against ticket requirements) | ND | ND | ND | **yes, runs** — lexical, execution never verified; benchmark shows misses (case-04) |
| independent-evidence analysis | ND | ND | ND | ND | ND | implemented but **non-operative** (0 links flagged in 200 benchmark runs across r2+r3) |
| circular / self-authored test detection | ND | ND | ND | ND | ND | same as above |
| evidence provenance / SHA binding | UNK | UNK | UNK | UNK | UNK (reviews attach to pushes; not documented as evidence binding) | partial (range recorded; no artifact hashes) |
| unsupported-claim refusal | ND | partial-DOC (`Failed compliance check` label) | partial-DOC (issue assessment: PR addresses linked issue) | ND | ND | **yes, runs** (needs-evidence verdict) — miscalibrated per benchmark |
| unrelated-change detection | ND | UNK | DOC ("verify PRs address linked issues **without containing out-of-scope changes**") | ND | ND | yes, runs (directory clustering) |
| deterministic merge policy | ND | partial-DOC (labels consumed by CI rules; checks themselves LLM-evaluated) | partial-DOC (pre-merge checks in error mode; built-in + natural-language custom checks, AI-evaluated) | doc-absent | doc-absent (check run "always completes with a neutral conclusion") | **yes, runs** (fully deterministic rule engine) |
| blocking enforcement | ND | DOC (CI gating on compliance labels) | DOC (error mode + Request Changes Workflow "block merges until resolved or manually overridden") | doc-absent ("will not block merging"; always a Comment review) | doc-absent ("never blocks merging"; DIY gating via machine-readable severity counts) | yes, runs (exit codes; no live install) |
| override audit trail | ND | ND | partial-DOC (manual override/ignore exists; rationale recording not documented) | ND | ND | **yes, runs** (owner + rationale + overridden verdict recorded) |
| historical replay | ND | ND | ND | ND | ND | **yes, runs** (`--replay`, `--replay-merges`) |
| post-merge outcome learning | ND | ND | partial-DOC (learns from reviewer feedback/chat) | ND | partial-DOC (👍/👎 collected post-merge to tune reviewer) | missing |

Reading this honestly in both directions:

- **The vocabulary delta is real and testable.** No competitor documents claim-to-evidence mapping, evidence-independence analysis, circular-test detection, or policy replay against historical PRs. Those four rows plus recorded overrides are a precise, falsifiable delta — not a rebranding of "AI review comments."
- **The delta is currently unearned.** The two rows that constitute the thesis (independence, circularity) exist in code but were non-operative across the entire benchmark (§4.4). A competitor could not reproduce PCC's *intended* behavior from their docs; neither, today, can PCC.
- **The commodity rows are already covered.** Deterministic-ish gating, blocking enforcement, and out-of-scope-change detection are documented, shipping features of CodeRabbit and Qodo with GitHub-native delivery, which PCC lacks entirely (§2: ingestion, Check publication missing). Copilot and Claude Code Review deliberately position as non-blocking commentary — evidence that "non-blocking advisory findings" is the crowded quadrant, and merge authority is the uncontested one, but only with discrimination that survives §4's benchmark.


## 6. Omitted findings (recorded in the correction pass)

Seven mechanism-level defects that the first revision of this report left out. Five were surfaced by the branch's own code review (`docs/residual-review-findings/feat-proof-carrying-changes.md`, run artifact `20260711-173547-cc0ca90b`); two were verified directly against the code for this pass. None was repaired; all are on the falsified baseline.

1. **Self-modifying policy.** `src/cli.ts:100` auto-loads `pcc-policy.yaml` from the current working directory — which, in the documented CI wiring (`docs/pcc/github-actions.md` checks out the PR head), is the PR's own tree. A PR can therefore edit or delete the policy file that gates it: flip block rules off, drop invariants, raise `max_unrelated_clusters`. Compounded by `src/pcc/policy.ts` silently ignoring unknown/mistyped rule keys (issue [#3](https://github.com/orban/cerberus/issues/3)), so a policy neutered by typo loads without complaint. The gate's configuration is attacker-writable in the product's own recommended deployment.

2. **PR-controlled credentialed execution.** The documented workflow runs `npm ci && npm run build` on the checked-out PR head in the same job that holds the LLM API key. Install scripts and build tooling from the PR execute with the secret in the environment. The guide's security-posture section addresses `pull_request_target`/fork exposure but not same-repo PRs — and the laundering scenario this product exists for (§4, case-03/06) is an internal PR. The checker's own credentials are exposed to the change it's judging.

3. **Production replay's future-test leakage.** `src/pcc/git.ts:361` reads the repo test-file inventory from the *current index*, not the analyzed head (issue [#5](https://github.com/orban/cerberus/issues/5)). `--replay-merges` therefore evaluates historical PRs against tests that didn't exist at merge time, inflating proxy evidence — the product's own calibration tool (`docs/pcc/github-actions.md` recommends "tuning on history" with it) leaks future information. The benchmark avoided this only because its case repositories contain no future files; the shipping replay path has no such isolation.

4. **Empty-test bypass.** Evidence links are formed from test *names and paths* (`src/pcc/evidence.ts`), and `execution` is the hardcoded literal `"not-verified"` (`src/pcc/types.ts:100`). An empty test — `it("boundary decision thresholds", () => {})` — with a claim-matching name forms a direct, independent, block-rule-qualifying evidence link. The review flagged this as forgeability by empty name-matching tests (run artifact, `evidence.ts:154` analysis); case-06 (§4) is the semantic sibling: content-free evidence that satisfies every structural check.

5. **Rollback negation bypass.** `src/pcc/detectors.ts:73` satisfies rollback detection when `ROLLBACK_TEXT` (`/\b(rollback|revert|reversal|down[- ]migration)\b/i`) matches the PR *description*. The sentence "no rollback is provided" — or "this change cannot be reverted" — sets `rollback.detected = true` and disarms `block_destructive_migration_without_rollback`. A keyword gate that a negation satisfies is not a gate.

6. **LLM obligation replacement.** `src/pcc/claims.ts:205`: when LLM claim generation succeeds, its claims *replace* the deterministic claims rather than extending them (issue [#10](https://github.com/orban/cerberus/issues/10)). A model that omits a risky claim — through sampling variance or prompt injection via diff content — silently deletes the corresponding obligation. Related: LLM-assigned severity gates the policy (issue [#16](https://github.com/orban/cerberus/issues/16)), so injected text can also downgrade a claim below the material threshold. The deterministic floor the PRD implies does not exist in LLM mode.

7. **Incomplete secret redaction.** Commit subjects are sent to the LLM without passing through redaction (review finding; only hunk content is redacted), and the redaction patterns themselves miss common token formats and unquoted values (`src/pcc/detectors.ts:13`, issue [#11](https://github.com/orban/cerberus/issues/11)). A secret pasted into a commit message reaches the model provider verbatim.

These change the shape of the failure surface, not the decision: items 1, 2, 4, 5, and 6 are additional ways an adversarial PR defeats the gate even where §4's benchmark shows the gate misfiring on honest input.

## 7. Three most consequential failures

1. **The product certifies circular evidence as independent (matched pair, §4.4).** With every visible confound removed, the laundered variant's implementation-mirroring test is labeled `direct, independent: true` in every run, satisfies the strict policy's block rules and the statistical-decision-core invariant, and the laundered change passes the shipping default 5/5 and the strict policy 3/5. The confounded original replicates the shape: case-03's launder passes default+det 5/5. Root causes compound — a newly added test file is "independent" by construction, deterministic mode emits zero claims when a description is present and no detectors fire, and nothing ever executes or inspects the evidence. The product's central promise — "tests pass" is not sufficient when the oracle is circular — is exactly the case it misses, and now demonstrably *cannot* see.

2. **The independence/circularity machinery never influenced a verdict (0 non-independent links in 200 runs across both scored benchmarks).** The one mechanism that distinguishes this product from a diff commenter was inert on the benchmark built around its own motivating incident. Evidence status is decided by ≥2 shared lexical tokens; independence is consulted only after a link forms and only by strict-policy block rules; the historically-shaped laundering pattern (rewriting assertion values inside existing tests) produces no links at all; and the new-file laundering pattern (case-06) produces links the heuristic affirmatively marks independent.

3. **The only configuration that accepts good changes is the one that approves laundering — and the historical PR is refused for size, not evidence (1 evidentiary refusal in 120 runs).** Nine of twelve must-pass cells refused correct, independently evidenced changes; the three that passed are all default+det, which also approves both laundered variants. Mechanism: fine-grained LLM claims plus coarse lexical matching means one unmatched material claim refuses a PR whose other eight claims link to genuinely discriminating evidence (case-02), or whose evidence literally tests the claimed behavior under different vocabulary (case-04). Per the PRD's own guardrails (§12.4: <10% incorrect blocks; §16.2 friction risk), the strict configurations would be disabled by their first design partner within a week — leaving the configuration that launders clean.

## 8. Final decision

**REJECT**

Applying the decision rule mechanically:

- **PROCEED fails decisively.** It requires the historical buggy change refused *for the correct evidentiary reason* (observed: 1 run in 120; every case-01 cell FAILs under the corrected scorer because 19/20 refusals were size-based clustering that would refuse any 40-file PR), and the independently evidenced changes to pass (observed: 9 of 12 must-pass cells refused them).
- **A REJECT disqualifier is empirically demonstrated, now without confounds: the system cannot distinguish independent from circular evidence.** The matched pair (§4.4) isolates ground-truth evidence independence as the only variable, and no configuration accepts the independent variant while refusing the circular one — the circular test is affirmatively certified `independent: true` and passes the strict policy 3/5. The confounded cases replicate the shape: the only configuration that passes good changes also passes both laundered ones; every configuration that refuses laundering also refuses the good changes; the purpose-built independence detector fired zero times in 200 runs across both scored benchmarks. "Blocks everything" additionally holds for the strict policy over the statistical module.
- For the record, the other REJECT triggers did **not** fire: the system never emitted a passing verdict for the historical defect (20/20 refused, albeit for size), its refusals were not future-information leakage or lexical recognition of the bug (leakage controls held), the verdict engine is deterministic rather than LLM commentary, and the pipeline is exercisable end to end from one command.

Why not NARROW: NARROW's premise is that claim/evidence analysis works and only merge authority is premature. The benchmark falsified the analysis layer itself at the decision level, not just the gating layer: evidence status is lexical co-occurrence, execution is never verified, and independence — the load-bearing concept in "proof-carrying" — is demonstrably non-operative. What genuinely works today (deterministic risk detectors, split recommendation, a clean policy engine, override recording, batch replay plumbing, honest abstention labels) is solid engineering, but it is the commodity perimeter of the PRD, not its thesis. Treating the current pipeline as a trustworthy claim-to-evidence judge — even in advisory, needs-evidence-first form — would ship verdict text ("supported", "direct", "independent") that this audit shows to be unearned.

Beyond the benchmark, §6 records seven mechanism-level ways the gate is defeated even on adversarial input it was never benchmarked against: the PR under review controls its own policy file and executes code in the credentialed CI job, content-free and negation-phrased evidence satisfies the detectors, LLM output can silently drop obligations, and the shipping replay calibration leaks future tests.

Consistent with the audit constraints, no failures were repaired and no recommendations were implemented. The raw results, fixtures, hidden oracle, and this report are the complete evidence trail:

- benchmark: `benchmarks/pcc/` (`node benchmarks/pcc/run.mjs`)
- scored run (r3, corrected scorer, clean rerun, 120 records): `benchmarks/pcc/results/2026-07-12T02-16-24-656Z/`
- prior runs preserved: `2026-07-12T01-36-38-347Z/` (r2), two r1 directories with `SUPERSEDED.md`
- independent math oracle: `benchmarks/pcc/oracle/sprt-oracle.mjs` (`ORACLE_CONFIRMED`, 8/8)



