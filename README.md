# Cerberus

Reference implementation for [Stop Testing AI Agents Like Deterministic Code](docs/blog/stop-testing-agents-like-deterministic-code.md).

Statistical CI/CD for AI agents — using sequential hypothesis testing (SPRT), Wilson score confidence intervals, and Benjamini-Hochberg correction to answer "does this agent work reliably enough?" instead of "did this test pass?"

## Quick start

```bash
npm install
npm run build
npx cerberus init        # scaffold a starter config
npx cerberus run         # run the test suite
```

## What this demonstrates

An agent is a Bernoulli process: each invocation passes or fails with some unknown probability *p*. Cerberus runs trials, accumulates statistical evidence, and makes a rigorous pass/fail/inconclusive decision — stopping early when the evidence is clear.

**Config** → define contracts (assertions) with reliability thresholds:

```yaml
adapter:
  command: "node ./my-agent.js --scenario {{scenario}}"
  timeout: 30000

studies:
  - name: code-review-quality
    scenario: scenarios/review-task.yaml
    contracts:
      - name: exits-cleanly
        type: code
        assert: "output.meta.exitCode === 0"
        threshold: 0.95
        confidence: 0.95
        trials: 50
```

**Output** → pass rates with confidence intervals and early stopping:

```
Contracts:
  exits-cleanly       PASS  100.0% [CI: 89–100%]  (15 trials, early stop)
  produces-valid-json  PASS   95.0% [CI: 78–99%]   (22 trials, early stop)

Suite: PASS (2/2 contracts satisfied)
```

**Exit codes** → `0` pass, `1` fail, `3` inconclusive — designed for CI pipelines.

## File map

Which file implements which concept from the blog post:

| Concept | File | What it does |
|---------|------|-------------|
| SPRT (sequential testing) | [`src/stats.ts`](src/stats.ts) | Log-likelihood ratio, Wald boundaries, accept/reject/continue |
| Wilson score intervals | [`src/stats.ts`](src/stats.ts) | Confidence intervals that work at 0% and 100% |
| Benjamini-Hochberg | [`src/stats.ts`](src/stats.ts) | Multiple testing correction (FDR control) |
| Contract evaluation | [`src/contracts.ts`](src/contracts.ts) | Sandboxed assertion execution via `vm.runInNewContext()` |
| LLM judge panels | [`src/judges.ts`](src/judges.ts) | Multi-provider judge evaluation with majority vote |
| Trial execution | [`src/runner.ts`](src/runner.ts) | SPRT loop, process spawning, error rate monitoring |
| YAML config + validation | [`src/config.ts`](src/config.ts) | Zod schema, threshold/confidence validation |
| Result formatting | [`src/output.ts`](src/output.ts) | Console output, JSON serialization, result persistence |
| Domain types | [`src/types.ts`](src/types.ts) | `SPRTState`, `ConfidenceInterval`, `ContractResult`, exit codes |
| CLI entry point | [`src/cli.ts`](src/cli.ts) | `run` and `init` commands, exit code mapping |
| Error types | [`src/errors.ts`](src/errors.ts) | `CerberusError`, `ConfigError` with typed exit codes |

9 source files, ~1,600 lines. 80 tests in `tests/`.

## Commands

```bash
npm run build      # Build with tsup
npm test           # Run tests with vitest
npm run typecheck  # Type-check with tsc
npm run dev        # Run CLI in dev mode with tsx
```

## License

MIT
