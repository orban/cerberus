## Summary

Corrects the SPRT decision boundaries in `src/stats.ts`.

The likelihood-ratio accumulator adds `log(p0/p1)` on success, i.e. it accumulates
evidence for H0 (the agent meets its threshold). Under this convention Wald's
boundaries are accept-H0 at `log((1-alpha)/beta)` and reject-H0 at
`log(alpha/(1-beta))`. The previous code used `log((1-beta)/alpha)` and
`log(beta/(1-alpha))`, which are the boundaries for the opposite likelihood-ratio
convention. The practical effect was an inflated false-failure rate for agents
that genuinely meet their threshold.

## Evidence

- `tests/error-control.test.ts` (new): behavioral verification derived from
  Wald's 1945 inequalities rather than from the implementation — exact
  consecutive-success/failure decision counts under symmetric and asymmetric
  alpha/beta, plus a fixed-seed Monte Carlo (mulberry32, 4000 runs) measuring
  empirical Type I error at p = p0 and Type II error at p = p1 against the
  advertised alpha and beta.
- `tests/stats.test.ts`: boundary expectations updated to the corrected formulas.

## Test plan

- [x] `npm test` — all tests pass
- [x] Monte Carlo empirical Type I error is consistent with alpha = 0.05
