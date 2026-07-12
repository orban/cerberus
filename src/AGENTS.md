# src

## Purpose
Owns: all runtime logic for Cerberus -- config loading, trial execution, contract evaluation, statistical testing (SPRT + CI), LLM judge orchestration, output formatting, and CLI commands.

Does not own: test fixtures, build config, documentation. Tests live in `../tests/`.

## Design Rationale

- **Problem solved**: AI agents are non-deterministic. A single pass/fail test can't tell you whether an agent works 95% of the time. Cerberus applies statistical hypothesis testing (SPRT) to repeatedly run an agent and decide with controlled error rates whether it meets a pass-rate threshold.
- **Core insight**: Treat agent evaluation as a Bernoulli experiment. SPRT lets you stop early when evidence is clear, so you don't waste trials on obvious pass/fail cases.
- **Constraints**: Zero LLM SDK dependencies (raw `fetch` calls to provider APIs). Only 4 runtime deps total. Assertions run in a V8 sandbox (`vm.runInNewContext`), never arbitrary eval.

## Code Map

### Find It Fast
| Looking for... | Go to |
|----------------|-------|
| CLI commands (run, init) | `cli.ts` |
| YAML config schemas (Zod) | `config.ts` |
| Config types (CerberusConfig, StudyConfig, etc.) | `config.ts` (inferred from Zod) |
| Domain types (TrialResult, SPRTState, SuiteResult) | `types.ts` |
| Trial execution (spawn agent process) | `runner.ts` `executeTrial()` |
| SPRT loop and study orchestration | `runner.ts` `runStudy()` |
| Suite-level runner + multiple-testing correction | `runner.ts` `runSuite()` + `applyCorrection()` |
| Code contract evaluation (vm sandbox) | `contracts.ts` `evaluateCodeContract()` |
| LLM judge panel evaluation | `judges.ts` `evaluateWithPanel()` |
| LLM provider implementations (OpenAI, Anthropic, Google) | `providers.ts` `callOpenAI()`, `callAnthropic()`, `callGoogle()` |
| LLM JSON response parsing (3 fallback strategies) | `providers.ts` `parseJsonResponse()` (wrapped by `judges.ts` `parseVerdict()`) |
| Change Contract analysis (`cerberus check`) | `pcc/check.ts` `runCheck()` |
| Git change collection + range normalization | `pcc/git.ts` `collectChangeSet()`, `resolveRange()` |
| Deterministic risk detectors | `pcc/detectors.ts` `detectRisks()` |
| Claim generation (LLM + deterministic fallback) | `pcc/claims.ts` `generateClaims()` |
| Claim-to-test evidence mapping | `pcc/evidence.ts` `mapEvidence()` |
| Policy schema, verdicts, invariants | `pcc/policy.ts` `evaluatePolicy()` |
| Check report rendering + persistence | `pcc/report.ts` |
| Historical replay batch mode | `pcc/replay.ts` `runReplay()` |
| SPRT math (create, update, boundaries) | `stats.ts` |
| Wilson score confidence intervals | `stats.ts` `wilsonScoreInterval()` |
| BH and Bonferroni corrections | `stats.ts` |
| TTY progress bar + result table | `output.ts` |
| JSON output + result persistence | `output.ts` `writeJsonOutput()`, `persistResult()` |
| Error hierarchy | `errors.ts` |
| Exit codes | `types.ts` `EXIT_CODE` |

### Key Relationships
```
cli.ts → config.ts → runner.ts → contracts.ts → judges.ts
                         ↓
                      stats.ts
                         ↓
                     output.ts
```
- `cli.ts` is the entry point, dynamically imports everything else
- `runner.ts` is the orchestrator -- it calls `config`, `contracts`, `stats`, and `output`
- `contracts.ts` dispatches to either the vm sandbox (code contracts) or `judges.ts` (judge contracts)
- `stats.ts` is a pure math module with no side effects
- `types.ts` and `errors.ts` are shared by all modules

## Public API

### Key Exports
| Export | Used By | Change Impact |
|--------|---------|---------------|
| `loadConfig()` | `cli.ts`, tests | Config shape change breaks all consumers |
| `runSuite()` | `cli.ts`, tests | Main entry point for running studies |
| `evaluateContract()` | `runner.ts` | Single dispatch point for all contract types |
| `SuiteResult` / `StudyResult` / `ContractResult` | `output.ts`, `cli.ts`, tests | Widely referenced result types |
| `EXIT_CODE` | `cli.ts`, `errors.ts` | 5 exit codes: 0=pass, 1=fail, 2=config, 3=inconclusive, 4=runtime |
| `SPRTConfig` / `SPRTState` | `runner.ts`, `stats.ts` | SPRT state machine types |

### Core Types
```typescript
// The config loaded from cerberus.yaml
interface ValidatedConfig {
  raw: CerberusConfig;      // Zod-validated config
  parsedCommand: ParsedCommand; // Split command + placeholder index
  configDir: string;         // For resolving relative scenario paths
}

// Result of a single trial against one contract
interface ContractVerdict {
  contractName: string;
  status: "pass" | "fail" | "error";
  error?: string;
  reasoning?: string;  // judge contracts only
}

// Final result for one contract across all trials
interface ContractResult {
  contractName: string;
  status: "pass" | "fail" | "inconclusive";
  observedRate: number;
  ci: ConfidenceInterval;     // Wilson score interval
  trialsEvaluated: number;
  sprtStoppedEarly: boolean;
}
```

## External Dependencies
| Service | Used For | Failure Mode |
|---------|----------|--------------|
| OpenAI API | Judge contracts with `gpt-*`/`o1`/`o3`/`o4` models | Throws if `OPENAI_API_KEY` unset; retries once on transient errors |
| Anthropic API | Judge contracts with `claude-*` models | Throws if `ANTHROPIC_API_KEY` unset; same retry logic |
| Google AI API | Judge contracts with `gemini-*` models | Throws if `GOOGLE_API_KEY` unset; same retry logic |
| Child process (agent) | Running the agent under test via `spawn()` | Timeout kills with SIGTERM then SIGKILL after 5s; stdout capped at 1MB |

## Data Flow
```
cerberus.yaml -> loadConfig() -> ValidatedConfig
                                    |
                               runSuite()
                                    |
                    +---- for each study ----+
                    |                        |
                    |  loadScenario()         |
                    |       |                 |
                    |  write scenario to /tmp  |
                    |       |                 |
                    |  +-- trial loop --+     |
                    |  | executeTrial()  |     |
                    |  | (spawn agent)  |     |
                    |  |      |         |     |
                    |  | evaluateContract|     |
                    |  |   +- code: vm  |     |
                    |  |   +- judge: LLM|     |
                    |  |      |         |     |
                    |  | updateSPRT()   |     |
                    |  | (stop early?)  |     |
                    |  +----------------+     |
                    |                        |
                    +------------------------+
                                    |
                          applyCorrection()
                          (BH / Bonferroni)
                                    |
                            SuiteResult
                                    |
                     formatResults() or writeJsonOutput()
                                    |
                         persistResult() -> .cerberus/runs/
```

## Decisions
| Decision | Why | Rejected |
|----------|-----|----------|
| SPRT over fixed-N testing | Early stopping saves trials when evidence is clear; 100% pass rate decides in <10 trials vs running all 50 | Fixed N wastes compute on obvious cases |
| `vm.runInNewContext()` for code assertions | Sandboxed execution prevents user-supplied assertions from accessing `process`, `require`, filesystem | Unsandboxed eval shares scope and has no isolation |
| Raw `fetch()` for LLM APIs | Zero SDK dependencies, all three providers (OpenAI, Anthropic, Google) have simple REST APIs | SDK deps would triple the dependency count |
| Scenario passed as temp JSON file | Agent reads scenario from a file path, not stdin; avoids quoting/escaping issues | Piping via stdin is fragile with `spawn()` |
| Model prefix routing (`gpt-*` -> OpenAI, etc.) | Simple heuristic; no config for provider name needed | Explicit provider field adds config complexity |
| Wilson score CI (not Wald) | Better coverage for small sample sizes and extreme proportions (0% or 100%) | Wald CI is inaccurate at boundaries |
| BH correction as default | Less conservative than Bonferroni for multiple contracts | Bonferroni available but rejects too aggressively |

## Entry Points
| Task | Start Here |
|------|------------|
| Add a new CLI command | `cli.ts` -- add a new `program.command()` block |
| Add a new contract type | `contracts.ts` `evaluateContract()` switch, `config.ts` `ContractSchema` discriminated union |
| Add a new LLM provider | `judges.ts` `getProvider()` + new `call*()` function + `getEnvVar()` |
| Change SPRT parameters | `stats.ts` `sprtConfigFromContract()` (maps threshold/confidence to p0/p1/alpha/beta) |
| Change output format | `output.ts` `formatResults()` for TTY, `writeJsonOutput()` for JSON |
| Change config schema | `config.ts` Zod schemas, then update types everywhere |

## Contracts

- Assertions run in a frozen sandbox. Only `output`, `scenario`, `Math`, `Array`, `String`, `RegExp`, `Boolean`, `Number`, `JSON` are exposed. No `process`, `require`, `import`, `globalThis`.
- Assertion timeout is 100ms. Infinite loops get killed.
- `spawn()` always uses `shell: false`. Never pass user commands through a shell.
- Agent stdout is capped at 1MB. Exceeding it kills the child process.
- Timeout handling is two-phase: SIGTERM first, then SIGKILL after 5 seconds.
- SPRT state is immutable once `decision !== "continue"`. Further updates are no-ops.
- `p1` is always `threshold - 0.10`, floored at 0.01. The indifference zone is fixed at 10 percentage points.
- Judge panel uses majority vote. A single successful verdict is enough to count (partial panel failures are tolerated).
- Judge prompt randomly swaps rubric/output order to reduce position bias.
- `configDir` is used to resolve relative scenario paths. Always join with `configDir`, not cwd.
- Results are persisted to `.cerberus/runs/` with ISO timestamp filenames.

## Patterns

### Adding a new contract type
1. Add Zod schema in `config.ts` (e.g., `NewContractSchema`)
2. Add it to the `ContractSchema` discriminated union (`z.discriminatedUnion("type", [...])`)
3. Export the inferred type
4. Add a case in `contracts.ts` `evaluateContract()` switch
5. Write the evaluation function
6. Add test fixtures in `../tests/fixtures/`

### Adding a new LLM provider
1. Add a `call*()` function in `providers.ts` that takes `(prompt, model)` and returns the raw string response
2. Add the prefix check in `getProvider()` -- model prefix routes to provider
3. Add the env var check in `getEnvVar()`
4. The judge panel machinery handles retries and verdict parsing automatically; `pcc/claims.ts` picks up the new provider through the same `getProvider()` routing

## Proof-Carrying Changes (pcc/)

`cerberus check` analyzes a git range into a Change Contract. The subsystem lives in `pcc/` and shares `providers.ts`, `errors.ts`, and `EXIT_CODE` with the study runner but nothing else.

Data flow: `cli.ts check` → `pcc/check.ts runCheck()` → `pcc/git.ts collectChangeSet()` (spawned git, all range forms normalized to merge-base(base, head)..head) → `pcc/detectors.ts detectRisks()` (heuristic findings: migrations, permissions, public API, deps/infra, test integrity, secrets, unrelated-change clustering) → `pcc/claims.ts generateClaims()` (LLM-proposed with secret redaction; deterministic fallback on `--no-llm`, missing key, or LLM failure) → `pcc/evidence.ts mapEvidence()` (static token-overlap mapping of claims to tests, `direct` vs `proxy`, independence detection) → `pcc/policy.ts evaluatePolicy()` (Zod-validated YAML policy, advisory-first defaults, five verdicts) → `pcc/report.ts` (markdown/JSON, persisted to `.cerberus/checks/`). `pcc/replay.ts` batches `runCheck` over historical ranges for policy tuning.

Key invariants:
- Evidence is statically mapped -- execution is never verified; every `EvidenceLink` carries `execution: "not-verified"`
- Block rules ship disabled (advisory-first); verdict exit codes: pass/pass-with-warnings 0, needs-evidence/split-required 3, block 1; `--advisory`/`--override` clamp the exit code to 0 but never rewrite the verdict
- Refs are user input: `assertSafeRef()` rejects refs starting with `-`; all git invocations use `spawn(shell: false)` with `--` separators
- Diff content passes `redactSecrets()` before any LLM prompt; `--llm-content minimal` sends no raw hunks

## Boundaries

### Always
- Use `node:` prefix for Node.js built-in imports
- Use `readonly` on interface fields
- Use `vm.runInNewContext()` for user-supplied assertions
- Use `spawn()` with `shell: false`

### Never
- Add `any` to source code
- Import from `tests/` in source files
- Use `process.env` outside `providers.ts` (except `process.env.CI` in `output.ts` and `runner.ts`)
- Let the assertion sandbox access `process`, `require`, or filesystem APIs

## Pitfalls

- `executeTrial()` resolves with a result even on spawn errors or timeouts -- it never rejects. Errors show up as `exitCode: 1` in the trial output, not as thrown exceptions.
- `parseVerdict()` in `judges.ts` tries 3 strategies to extract JSON from LLM responses (direct parse, code block, brace matching). Don't assume LLMs return clean JSON.
- The `applyCorrection()` function in `runner.ts` uses proxy p-values (0.001 for pass, 0.999 for fail, 0.5 for inconclusive) rather than true statistical p-values. This is a documented simplification.
- `threshold` minimum is 0.11 (not 0.10) in the Zod schema because `p1 = threshold - 0.10` must stay above 0.01.
- `configDir` is `dirname(resolve(configPath))`, not cwd. Scenario paths in the config are relative to the config file, not to where you run the command.
- `displayProgress()` writes to stderr, not stdout. stdout is reserved for JSON output when `--json` is used.
- The flaky agent fixture (`../tests/fixtures/agents/flaky.js`) has an ~80% pass rate. Tests using it may occasionally produce different SPRT outcomes.
