## Summary

Statistical CI/CD for AI agents — a reference implementation accompanying [Stop Testing AI Agents Like Deterministic Code](docs/blog/stop-testing-agents-like-deterministic-code.md).

The blog post walks through why `assert(agent() === expected)` is fundamentally wrong for stochastic systems, then builds up the statistical toolkit (SPRT, Wilson score intervals, Benjamini-Hochberg) with worked examples and cost analysis. The code is the proof that it all works.

### What's in this PR

- **Blog post** (346 lines) — conversational essay covering the math, its implications for CI/CD, and cost savings from adaptive sampling
- **README** — repositions the repo as a reference implementation with a concept-to-file map
- **Full implementation** (1,600 lines, 80 tests) — the working code behind the ideas

### Implementation highlights

- **SPRT adaptive early stopping** with Wilson score confidence intervals
- **Two contract types**: code (vm.runInNewContext sandbox) and judge (LLM panel with majority vote across OpenAI, Anthropic, Google)
- **Full CLI** with `cerberus run` (--json, --output, --config) and `cerberus init` scaffolding
- **Safety-first**: spawn with shell:false, frozen sandbox globals, 1MB stdout cap, SIGTERM→SIGKILL timeout cascade
- **Benjamini-Hochberg** multiple testing correction across contracts
- **Result persistence** to `.cerberus/runs/<timestamp>.json`

## Architecture

9 source files, 4 runtime deps (commander, zod, yaml, picocolors):

```
src/stats.ts      — SPRT + Wilson CI + BH/Bonferroni correction
src/runner.ts     — Study/trial orchestration + adapter (spawn + capture)
src/contracts.ts  — Code eval (vm sandbox) + judge delegation
src/judges.ts     — 3 LLM providers + panel aggregation + prompt template
src/config.ts     — Zod schemas + YAML loader
src/output.ts     — Table, JSON, progress, result persistence
src/types.ts      — Shared type definitions + exit codes
src/cli.ts        — Commander entry point (run, init)
src/errors.ts     — CerberusError + ConfigError
```

## Blog post structure

1. **The hook** — 0.9^10 = 0.349, your CI is a coin flip
2. **The problem** — Bernoulli trials, not assertions
3. **The reframe** — hypothesis testing framing
4. **SPRT** — adaptive sampling with early stopping (worked examples)
5. **Wilson score** — honest confidence intervals (comparison table)
6. **Multiple testing trap** — BH correction vs Bonferroni
7. **CI/CD redesign** — exit codes, threshold gates, persistence
8. **Cost equation** — SPRT savings ($7,500 → $3,300/mo worked example)
9. **Try it yourself** — quick start
10. **Appendix** — formal math

## Test plan

- [x] `npm run typecheck` — 0 errors
- [x] `npm run build` — produces dist/cli.js
- [x] `npm test` — 80/80 tests pass
- [x] All math in blog post verified against source (SPRT formulas, Wilson score, BH procedure)
- [x] All code snippets in blog match actual implementation
- [x] All file links in README resolve to existing files
- [x] No source code changes — existing implementation untouched
