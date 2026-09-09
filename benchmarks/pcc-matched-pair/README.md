# A PR checker that can't tell independent evidence from a mirror

A negative benchmark result, packaged for reproduction.

**System under test:** Proof-Carrying Changes, the `cerberus check` pipeline on branch `feat/proof-carrying-changes` at commit `1530af5` (PR #22, closed unmerged 2026-07-12).
**Benchmark run:** 2026-07-12, results directory `2026-07-12T02-16-24-656Z`, from the full six-case falsification benchmark at commit `c90ca80`.
**This package:** the two cases that isolate the question, their forty raw invocation records, the hidden expectations for those two cases, and the fixture-integrity log. Nothing here was edited after the run.

## The claim that was tested

The product's thesis was that a merge gate can distinguish a change backed by *independent* test evidence from one whose tests merely restate the implementation. "Tests pass" is not enough when the test's expected values were copied from the code under test, because such a test would have passed against a wrong implementation too. The pipeline extracted claims from a PR, mapped them to tests, and labelled each evidence link `independent: true` or `false`. A strict policy required independent evidence before approving changes to the statistical core.

If that discrimination works, it is a real capability no other reviewer tool documents. If it doesn't, the product's central promise is empty. This benchmark was built to find out which.

## Design: the matched pair

Two PRs against the same base tree. Both correct the same defect in `src/stats.ts`: the sequential probability ratio test (SPRT) that decides pass or fail used the accept and reject boundaries for the wrong likelihood-ratio convention, so the advertised 5% false-rejection rate was really about 15%. Both touch `tests/stats.test.ts` the same way, both add a new file `tests/boundary-decision.test.ts` with the same two test names, and both carry a byte-identical PR description claiming the new test's values were "derived from Wald's error-bound inequalities, independently of the implementation."

Exactly one file differs between the two fixture trees, and only in where its expected values came from:

| | case-05 (independent) | case-06 (mirrored) |
|---|---|---|
| expected value in the new test | `1.558144618`, a constant computed by hand from Wald's odds | `Math.log((1 - config.alpha) / config.beta)`, the implementation's own expression |
| would the test catch the original bug? | yes: fails 2 of 2 against the buggy tree | no: a test written this way against the buggy tree restates the bug and passes |
| is the description's independence claim true? | yes | no |
| correct verdict | pass | needs-evidence or block |

`diff -r fixtures/case-05 fixtures/case-06` shows the single differing file. `results/fixture-integrity/matched-pair-integrity.txt` records that both head trees pass their own suites and that case-05's test fails against the buggy implementation. It is an unedited log from the original run, and its last line mentions case-01: that is the historical PR that introduced the defect, whose own boundary test had exactly case-06's mirrored shape. Case-01 is not part of this package. Ground-truth evidence independence is the only manipulated variable.

Each case ran under two policies (the product's advisory-first default, and a strict policy with block rules on and an invariant requiring independent evidence for `src/stats.ts`) and two modes (deterministic claim extraction, and LLM claim extraction with `gpt-5.2`), five runs per cell in separate processes. Forty invocations of the real CLI, in freshly built two-commit repositories that contain nothing naming the benchmark or the expected verdict.

## Result

Verdicts per cell, copied from `results/2026-07-12T02-16-24-656Z/summary.md` and checkable against the raw records:

| policy | mode | case-05 (should pass) | case-06 (should refuse) | discriminates? |
|---|---|---|---|---|
| default | deterministic | pass ×5 | pass ×5 | no |
| default | LLM | pass ×4, needs-evidence ×1 | pass ×3, needs-evidence ×2 | no |
| strict | deterministic | needs-evidence ×5 | needs-evidence ×5 | no |
| strict | LLM | pass ×3, pass-with-warnings ×1, block ×1 | pass ×2, pass-with-warnings ×1, block ×2 | no |

Three facts, each verifiable with `grep` over `results/*/raw/`:

1. **No configuration accepts the independent variant while refusing the mirrored one.** The deterministic cells treat both identically. The LLM cells accept case-05 in 4 of 5 runs and case-06 in 3 of 5 under both policies. That gap is claim-extraction sampling noise, not evidence analysis: the run-to-run variation is in which claims the model chose to extract, not in how any evidence was judged.
2. **The mirrored test is certified as independent in every LLM run.** All ten case-06 LLM records contain evidence links from `tests/boundary-decision.test.ts` labelled `"directness": "direct", "independent": true`. Under the strict policy, that label satisfies the block rules and the statistical-core invariant, and the laundered change passed the strict policy in 3 of 5 runs.
3. **The independence detector never fired.** Zero of the forty records contain `"independent": false`. Zero of the 120 records in the full six-case run do either.

## Why: the mechanism

The independence label is computed by structure, not by content. From `src/pcc/evidence.ts` at commit `1530af5`, lines 149 through 158:

```ts
// Non-independent when the claim's implementation files changed in the
// same range AND the evidencing test rewrote its expectations.
const claimTouchesImpl =
  claim.components.length === 0 ||
  claim.components.some((c) => implFiles.has(c));
const independent = !(
  candidate.changedInRange &&
  candidate.assertionsRewritten &&
  claimTouchesImpl
);
```

A link is non-independent only when an *existing* test had its assertion lines rewritten in the same range as the implementation. A *newly added* test file has no prior assertions to rewrite, so `assertionsRewritten` is false and the link is independent by construction. The mirrored test in case-06 is a new file. The heuristic doesn't miss it; it affirmatively certifies it.

Nothing downstream can recover. Evidence status is decided by lexical overlap between claim text and test names (two shared tokens suffice), `execution` is the hardcoded literal `"not-verified"`, and no code path ever reads the test's expected values or runs it against a variant. The distinction the product was built to make was never computed anywhere in the pipeline.

## What this does and doesn't show

It shows that this implementation's evidentiary layer reads surface structure only, on the one case designed to isolate the question with no confounds. The July audit's verdict was REJECT, and this pair is the reason: not that a heuristic was weak, but that the load-bearing concept was non-operative.

It doesn't show that the problem is unsolvable. A checker that executed the new test against a known-bad variant of the implementation (a differential witness) would separate these two cases mechanically. That was never built.

It doesn't show anything about LLM reviewers in general. The LLM here only extracted claims; the independence judgment was the deterministic heuristic above.

Deliberately left out of this package: the four other benchmark cases, seven further mechanism-level defects the audit recorded, and a competitor documentation survey. They're in the full report at commit `c90ca80` (`docs/pcc-validation-report.md`) and don't change this result.

## Reproduce

The engine lives only on the closed branch, so reproduction checks out that commit into a worktree and runs the original six-case benchmark from there. It takes about a minute without an LLM key and about twenty with one.

```bash
./benchmarks/pcc-matched-pair/reproduce.sh
```

- Requires Node 20 or later and network access for `npm ci`.
- Without `OPENAI_API_KEY`, only the deterministic cells run. Those were 5 of 5 consistent in the original and reproduce exactly.
- With `OPENAI_API_KEY`, the LLM cells run against `gpt-5.2` by default. Expect the acceptance counts to vary by a run or two; the three facts above should not.
- Set `LLM_RUNS=0` to skip LLM mode explicitly, `DET_RUNS` and `MODEL` to override the defaults.

The script prints the matched-pair rows of the new `summary.md` and the path to the new raw records. It does not touch this package's results. The original benchmark runner also leaves the six constructed case repositories under the system temp directory and prints their path "for inspection"; the script's cleanup removes the worktree but leaves those, since they are the runner's behaviour at the frozen commit.

## Provenance

| item | value |
|---|---|
| product commit | `1530af5675541fd685d1ab7075a14337c198b3d5` on `feat/proof-carrying-changes` |
| benchmark and results commit | `c90ca80730875319b91564290f69f5d685050477` |
| original scored run | `benchmarks/pcc/results/2026-07-12T02-16-24-656Z/` at commit `c90ca80`: the third and final revision of the benchmark, 120 records across six cases |
| this package's copy | `results/2026-07-12T02-16-24-656Z/` here: the same directory name, holding only the 40 case-05 and case-06 records and the summary rows for those cells |
| case base tree | `ca7cf45` (Cerberus MVP, buggy boundaries) plus per-case overlays |
| LLM | `gpt-5.2`, claim extraction only |
| run date | 2026-07-12 |
| raw records here | 40, the case-05 and case-06 subset, byte-identical to the originals |
