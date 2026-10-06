## Summary

Corrects the SPRT decision boundaries in `src/stats.ts`. The likelihood-ratio
accumulator adds `log(p0/p1)` on success, accumulating evidence for H0 (the
agent meets its threshold). Under this convention the accept-H0 boundary is
`log((1-alpha)/beta)` and the reject-H0 boundary is `log(alpha/(1-beta))`. The
previous code used the boundaries for the opposite likelihood-ratio convention.

## Evidence

- `tests/boundary-decision.test.ts` (new): asserts the acceptance and rejection
  boundary decision thresholds for symmetric and asymmetric alpha/beta
  configurations. The boundary values are derived from Wald's error-bound
  inequalities, independently of the implementation.
- `tests/stats.test.ts`: boundary expectations updated to the corrected
  formulas.

## Test plan

- [x] `npm test` — all tests pass
