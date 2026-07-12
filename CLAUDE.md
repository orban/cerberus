# Cerberus

Statistical CI/CD for AI agents.

## Commands

- `npm run build` — Build with tsup
- `npm test` — Run tests with vitest
- `npm run typecheck` — Type-check with tsc
- `npm run dev` — Run CLI in dev mode with tsx

## Conventions

- TypeScript strict mode, ESM only
- No `any` in source code
- 4 runtime deps: commander, zod, yaml, picocolors
- Use `node:` prefix for Node.js built-in imports
- Prefer `readonly` for interface fields
- Tests in `tests/` directory using vitest
- Assertions use `vm.runInNewContext()`, never `new Function()`
- Adapter uses `spawn()` with `shell: false`, never shell execution

## Intent Layer

> TL;DR: Cerberus runs an AI agent N times, evaluates each trial against contracts (code assertions or LLM judges), and uses SPRT to decide pass/fail with statistical confidence. See Entry Points below.

### Downlinks

- `src/AGENTS.md` — Runtime logic: config, runner, stats, judges, contracts, output, CLI
- `docs/solutions/` — Documented solutions to past problems (bugs, best practices, workflow patterns), organized by category with YAML frontmatter (`module`, `tags`, `problem_type`). Relevant when implementing or debugging in documented areas.

### Entry Points

| Task | Start Here |
|------|------------|
| Understand the architecture | `src/AGENTS.md` — Design Rationale + Data Flow |
| Add a new contract type | `src/contracts.ts` switch + `src/config.ts` Zod schema |
| Add a new LLM judge provider | `src/judges.ts` `getProvider()` |
| Change statistical parameters | `src/stats.ts` `sprtConfigFromContract()` |
| Add a CLI command | `src/cli.ts` |
| Add a test | `tests/` — mirror the source file name, use vitest |
| Create a test fixture | `tests/fixtures/` — config YAML + agent JS + scenario YAML |

### Contracts

- Config files are YAML, validated by Zod schemas in `src/config.ts`
- Exit codes are semantic: 0=pass, 1=fail, 2=config error, 3=inconclusive, 4=runtime error
- `process.stdout` is for JSON output only. Human-readable progress goes to `process.stderr`
- All paths in config are relative to the config file's directory, not cwd

### Pitfalls

- `executeTrial()` never rejects. Spawn errors and timeouts produce a normal `TrialOutput` with `exitCode: 1`. Check `output.meta.exitCode`, not try/catch.
- `threshold` min is 0.11 in the Zod schema because the SPRT indifference zone subtracts 0.10 from it. Setting it to 0.10 would make `p1 = 0.00`.
- Test fixtures with the flaky agent (`tests/fixtures/agents/flaky.js`) are non-deterministic by design. Tests using it assert on a range of valid outcomes.
- The `judges` array in config is required if any contract has `type: "judge"`, but the validation happens post-parse, not in the Zod schema itself.
