## Summary

Adds input validation to `wilsonScoreInterval` in `src/stats.ts`: negative
counts, `successes > n`, non-integer counts, and confidence outside (0,1) now
throw `RangeError` instead of silently producing NaN-contaminated intervals.
No behavior change for valid inputs.

## Evidence

- `tests/interval-validation.test.ts` (new): rejection cases for each invalid
  input class, plus hand-computed reference intervals (8/10 at 95%, 90/100 at
  99%) computed directly from the Wilson score formula, independent of the
  implementation.

## Test plan

- [x] `npm test` — all tests pass
