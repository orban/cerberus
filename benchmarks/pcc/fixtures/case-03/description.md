## Summary

Aligns the SPRT decision boundaries in `src/stats.ts` with the standard Wald
formulation: accept at `log((1-beta)/alpha)`, reject at `log(beta/(1-alpha))`,
as given in Wald (1945) and standard sequential-analysis references. The
boundary unit tests in `tests/stats.test.ts` are updated to the same convention.

## Test plan

- [x] `npm test` — all tests pass
- [x] Boundary assertions in `tests/stats.test.ts` verify the implemented formulas
