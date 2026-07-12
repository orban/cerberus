# Residual Review Findings — feat/proof-carrying-changes

Source: ce-code-review run `20260711-173547-cc0ca90b` (2026-07-11) on the
Proof-Carrying Changes MVP branch, plan
`docs/plans/2026-07-11-001-feat-proof-carrying-changes-mvp-plan.md`.
The review produced 30 validated findings; 8 were applied on-branch in commit
`fix(review): apply code review findings`. The 20 residual actionable findings
below were each filed as a GitHub issue.

## Residual Review Findings

- **P1** `src/cli.ts:114` — Replay mode ignores --json/--output and other flags silently → [#2](https://github.com/orban/cerberus/issues/2)
- **P1** `src/pcc/policy.ts:31` — Policy YAML silently ignores unknown/mistyped rule keys → [#3](https://github.com/orban/cerberus/issues/3)
- **P1** `src/pcc/report.ts:173` — JSON/persisted output drops RiskFinding evidence snippets → [#4](https://github.com/orban/cerberus/issues/4)
- **P2** `src/pcc/git.ts:361` — Test inventory read from current index, not analyzed head → [#5](https://github.com/orban/cerberus/issues/5)
- **P2** `src/cli.ts:156` — check duplicates run's CerberusError catch block verbatim → [#6](https://github.com/orban/cerberus/issues/6)
- **P2** `src/pcc/check.ts:62` — runCheck --policy file-loading path untested end-to-end → [#7](https://github.com/orban/cerberus/issues/7)
- **P2** `src/pcc/claims.ts:192` — No-API-key claim fallback branch is never tested → [#8](https://github.com/orban/cerberus/issues/8)
- **P2** `src/pcc/claims.ts:204` — No retry-once on LLM failure, unlike judges.ts → [#9](https://github.com/orban/cerberus/issues/9)
- **P2** `src/pcc/claims.ts:205` — LLM claims replace deterministic claims, weakening verdicts → [#10](https://github.com/orban/cerberus/issues/10)
- **P2** `src/pcc/detectors.ts:13` — Secret patterns miss common token formats and unquoted values → [#11](https://github.com/orban/cerberus/issues/11)
- **P2** `src/pcc/detectors.ts:205` — package.json dependency-change branch has zero test coverage → [#12](https://github.com/orban/cerberus/issues/12)
- **P2** `src/pcc/evidence.ts:115` — Repo test-path tokenization redone on every check/replay call → [#13](https://github.com/orban/cerberus/issues/13)
- **P2** `src/pcc/git.ts:49` — gitOrThrow collapses all git failures into exit-2 config errors → [#14](https://github.com/orban/cerberus/issues/14)
- **P2** `src/pcc/git.ts:91` — origin/HEAD base-resolution priority path is untested → [#15](https://github.com/orban/cerberus/issues/15)
- **P2** `src/pcc/policy.ts:85` — LLM-assigned claim severity gates policy, enabling injection downgrade → [#16](https://github.com/orban/cerberus/issues/16)
- **P2** `src/pcc/policy.ts:237` — needs-evidence suppressed by non-qualifying token-overlap evidence → [#17](https://github.com/orban/cerberus/issues/17)
- **P2** `src/pcc/report.ts:28` — Override banner in markdown report never asserted → [#18](https://github.com/orban/cerberus/issues/18)
- **P2** `src/pcc/report.ts:74` — Markdown report renders attacker-influenced text without newline sanitization → [#19](https://github.com/orban/cerberus/issues/19)
- **P2** `src/pcc/report.ts:92` — Affected Invariants rendering branches never exercised → [#20](https://github.com/orban/cerberus/issues/20)
- **P3** `tests/pcc/providers.test.ts:1` — providers.ts test misplaced under tests/pcc/ → [#21](https://github.com/orban/cerberus/issues/21)

Two further findings are human-owned design calls and were deliberately not
filed as downstream work: CLI flag-handling test strategy (`src/cli.ts:92`)
and block-rule evidence forgeability via empty name-matching tests
(`src/pcc/evidence.ts:154` — see the run artifact for the full analysis).

Run artifact: `/tmp/compound-engineering/ce-code-review/20260711-173547-cc0ca90b/`
