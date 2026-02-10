---
title: "Scale Game Analysis: Cerberus MVP"
type: analysis
date: 2026-02-09
parent: 2026-02-09-feat-cerberus-mvp-statistical-ci-cd-plan.md
---

# Scale Game Analysis: Cerberus MVP

The Scale Game tests a design at extreme scales -- 1000x bigger, 1000x smaller, instant, year-long -- to expose fundamental truths hidden at normal operating points. Applied to the Cerberus plan before a single line of code is written.

---

## 1. Volume -- Trials

**Normal: 50 trials per study.**

### At 1 trial

**What breaks:**
- SPRT is meaningless with a single observation. The log-likelihood ratio after one trial is either `log(p0/p1)` or `log((1-p0)/(1-p1))`. With `p0=0.90, p1=0.80`, a single pass yields `logLR = log(0.90/0.80) = 0.118`. A single fail yields `logLR = log(0.10/0.20) = -0.693`. Neither crosses the SPRT boundaries (`A = log((1-beta)/alpha) = log(0.80/0.05) = 2.77`, `B = log(beta/(1-alpha)) = log(0.20/0.95) = -1.56`). So SPRT will ALWAYS return "inconclusive" after 1 trial for any reasonable threshold/confidence combination. The user gets exit code 3 (inconclusive) every time.
- Wilson score CI for 1/1 at 95% is [0.025, 1.000]. For 0/1 it is [0.000, 0.975]. These are so wide as to be meaningless. The reported CI conveys no information.
- The user has explicitly asked for 1 trial, so they probably want a deterministic pass/fail mode -- which Cerberus does not conceptually support.

**What works:** Execution engine runs fine. One trial, one adapter invocation, one set of contract evaluations.

**Design changes needed:**
- **Minimum trial validation.** The config loader should warn (not error) when `trials < 5`. Below that threshold, SPRT cannot reach a decision for any practical parameter combination. Compute the minimum number of observations needed to reach either SPRT boundary given the configured `p0`, `p1`, `alpha`, `beta`, and reject the config or warn loudly if `trials` is below that minimum.
- **Deterministic fallback mode.** When `trials: 1`, bypass SPRT entirely. Treat it as a simple pass/fail: the trial either passes all contracts or fails. Document this as "deterministic mode." This is important because many users will try `trials: 1` as their first experiment to see if the tool works at all.

### At 10,000 trials

**What breaks:**
- **Memory.** Each `TrialResult` stores the full `TrialOutput` including `_raw` (full stdout). If agent output is 1KB, that is 10MB stored in an array in memory. Manageable. But the plan stores ALL trial results in the `StudyResult`, and then serializes them to `.cerberus/runs/<timestamp>.json`. A 10MB JSON file is fine. But see dimension 7 (output size) -- if agent output is large, this compounds.
- **Time.** At 1 second per agent invocation: 10,000 seconds = 2.8 hours for a single study. At 2 seconds per judge call with 3 judges per trial for behavioral contracts: 60,000 judge calls = 120,000 seconds = 33 hours of sequential LLM judge time. This is absurd but reveals that **parallel trial execution is not a post-MVP nice-to-have; it is load-bearing for any non-trivial trial count.**
- **API cost.** 10,000 trials x 3 judges x 3 contracts = 90,000 LLM API calls. At ~$0.01/call (GPT-4o input+output for a judge prompt), that is $900 per run. With no cost estimation or confirmation, a user could accidentally spend hundreds of dollars.
- **SPRT behavior.** This is the good news. SPRT will stop early for clear-cut cases. A 95% pass rate agent with threshold 0.90 will trigger acceptance in roughly 15-25 trials. A 70% pass rate agent will trigger rejection in roughly 10-15 trials. The 10,000 cap will almost never be reached unless the true rate is very close to the threshold. So SPRT naturally protects against waste -- but only if it can reach a decision for all contracts.
- **Progress bar.** `24/10000` looks absurd and the progress bar resolution (each character = 500 trials) is useless. The ETA calculation needs to handle long durations.

**What works:** SPRT mathematics, Wilson CI (just numbers, scales fine), Bonferroni correction.

**Design changes needed:**
- **Cost estimation.** Before starting a run with semantic/behavioral contracts, estimate total cost assuming max trials and print it. `Estimated max cost: $X.XX (with early stopping, likely $Y.YY)`. Ask for confirmation if cost exceeds a configurable threshold (e.g., `--max-cost 50`).
- **Streaming results to disk.** Do not hold all 10,000 TrialResults in memory. Write each trial result to a JSONL file as it completes. Keep only the running aggregates (successes, failures, SPRT state) in memory. The `StudyResult` in memory should reference the file, not hold the data.
- **Concurrency.** Add a `concurrency` option to studies (default: 1 for MVP). Even MVP should support `concurrency: 5` to make 10,000 trials feasible. This requires the trial runner to use a pool/semaphore pattern rather than a for-loop. The SPRT update must be serialized (it depends on cumulative state), but trial execution can be parallelized.
- **Progress display.** Show ETA, trials/second, and cost-so-far instead of a fixed-width bar when trial count is large.

---

## 2. Volume -- Contracts

**Normal: 3 contracts per study.**

### At 1 contract

**What breaks:** Nothing mechanically. But the multiple testing correction (Bonferroni) divides alpha by 1, which is a no-op. This is correct but should be documented -- users might wonder why correction is mentioned when they have only one contract.

**What works:** Everything. This is the simplest case.

**Design changes needed:** None. This is a degenerate case that works fine.

### At 100 contracts

**What breaks:**
- **Bonferroni correction becomes crippling.** With 100 contracts and alpha=0.05, Bonferroni adjusts to alpha=0.0005 per contract. This means each contract needs an extreme amount of evidence to reach a decision. For SPRT with alpha=0.0005: the acceptance boundary A = log(0.80/0.0005) = 7.38 (compared to 2.77 at alpha=0.05). This requires roughly 3x as many observations per contract to reach a decision. Combined with 100 contracts, the study is practically guaranteed to hit `max_trials` without all contracts reaching a decision.
- **Benjamini-Hochberg is the correct choice here**, not Bonferroni. The plan mentions both but defaults to Bonferroni. At 100 contracts, Bonferroni is far too conservative. BH controls the false discovery rate instead of the family-wise error rate and remains powerful at scale.
- **Output table.** 100 rows in the terminal is unreadable. The result table will scroll off screen. No grouping, filtering, or summary view is planned.
- **Judge calls multiply.** If 50 of those 100 contracts are behavioral (3 judges each) and you run 50 trials, that is 50 x 50 x 3 = 7,500 judge calls. Same cost problem as dimension 1.
- **Contract evaluation per trial.** If each contract evaluation takes 100ms (for programmatic) or 2s (for semantic), evaluating 100 contracts per trial takes 10s-200s per trial. The trial loop serializes contract evaluation within a trial. With 50 trials, that is 500s-10,000s just for contract evaluation.

**What works:** The contract dispatching logic, SPRT per-contract tracking, the type system.

**Design changes needed:**
- **Default to Benjamini-Hochberg.** Make BH the default correction method, with Bonferroni as an opt-in for users who need stricter FWER control. Document when each is appropriate.
- **Parallel contract evaluation within a trial.** After a trial completes, evaluate all 100 contracts in parallel (especially judge-based contracts, which are I/O-bound). This is a simple `Promise.all` over contract evaluations.
- **Contract groups and summary.** Support grouping contracts (e.g., by category tag) and showing a summary view: `Security: 12/15 PASS, Performance: 8/8 PASS, Style: 3/5 PASS`.
- **`--filter` flag.** Allow running a subset of contracts by name or tag pattern.
- **Config validation.** Warn when contract count > 20 with Bonferroni correction. Suggest switching to BH.

---

## 3. Volume -- Studies

**Normal: 2 studies.**

### At 1 study

**What breaks:** Nothing. The suite runner is a simple loop over studies. One iteration is fine.

**What works:** Everything.

**Design changes needed:** None.

### At 50 studies

**What breaks:**
- **Sequential execution time.** Studies run sequentially per the plan. If each study takes 5 minutes (50 trials x 3 contracts), 50 studies take 250 minutes = 4.2 hours. This is a common CI timeout (GitHub Actions defaults to 6 hours).
- **Cross-study multiple testing.** The plan applies correction "across all contracts in a suite." With 50 studies x 3 contracts = 150 contracts, Bonferroni divides alpha by 150. This is statistically correct but practically crippling (see dimension 2 at 100 contracts). The question is: should correction be per-study or per-suite? The answer depends on what the user cares about: per-study correction controls errors within each study independently; per-suite correction controls errors across the entire evaluation.
- **Config file complexity.** 50 studies in a single YAML file is hundreds of lines. No composition, no imports, no reuse of common contract definitions across studies.
- **Result file size.** 50 studies x 50 trials x full output = large JSON. See dimension 1.
- **Progress display.** Need a study-level progress indicator in addition to per-trial progress.

**What works:** SPRT per contract, contract evaluation, adapter invocation.

**Design changes needed:**
- **Configurable correction scope.** Add `correction_scope: study | suite` to config. Default to `study` (correction within each study). Document the tradeoff.
- **Study-level parallelism.** If studies use different scenarios and adapters, they can run in parallel. Add `parallel_studies: true` option. For MVP, default to sequential but design the runner to support future parallelism (return promises, do not rely on shared mutable state between studies).
- **Config composition.** Support `studies: !include studies/*.yaml` or similar pattern to split config across files. This is a post-MVP feature but the config loader should be designed to accommodate it (separate study validation from suite validation).
- **Suite-level progress.** Show `Study 3/50: standard-review [24/50 trials]` with overall ETA.

---

## 4. Volume -- Judge Panel

**Normal: 3 judges.**

### At 1 judge

**What breaks:**
- **No consensus mechanism.** Majority vote with 1 judge is just that judge's opinion. There is no tie-breaking, no disagreement detection, no robustness against a single model's biases. A behavioral contract with 1 judge is functionally identical to a semantic contract. The type distinction becomes meaningless.
- **Single point of failure.** If that judge's API is down, the contract cannot be evaluated. The plan says "require at least 1 judge to succeed" -- with 1 judge, there is zero tolerance for failure.

**What works:** The invocation logic, prompt template, verdict parsing.

**Design changes needed:**
- **Minimum judge validation.** Warn when a behavioral contract has `judge_panel < 2`. It offers no advantage over a semantic contract. Consider auto-downgrading to semantic with an info message.
- **Document the distinction.** Make it crystal clear: semantic = 1 judge, behavioral = N judges with consensus. If you configure 1 judge for behavioral, you get semantic with extra overhead.

### At 20 judges

**What breaks:**
- **API cost.** 20 judges x 50 trials x 3 behavioral contracts = 3,000 judge calls per study. At $0.01/call, that is $30/study. But with expensive models (Claude Opus, GPT-4), it could be $0.10/call = $300/study.
- **Latency.** Judges are invoked in parallel (per the plan), so latency is max(judge_latencies), not sum. With 20 judges, the slowest judge determines the pace. At 20 judges, the probability that at least one is slow (>10s) is high. P(at least one > 10s) = 1 - P(all < 10s)^20. If each judge has a 5% chance of being >10s, the probability is 1 - 0.95^20 = 64%.
- **Rate limiting.** 20 parallel API calls to the same provider will almost certainly hit rate limits. If 10 judges are OpenAI models, that is 10 concurrent calls. OpenAI's rate limits for GPT-4o are typically 500 RPM for tier-1 users, so 10 calls is fine. But across 50 trials, that is 10 x 50 = 500 calls in quick succession, possibly within a minute.
- **Majority vote with even numbers.** 20 judges can tie 10-10. The plan does not specify tie-breaking. This is a latent bug.
- **Aggregation quality.** Research on LLM-as-judge shows diminishing returns past ~5 judges for most tasks. 20 judges adds cost and latency without proportional quality improvement. However, it can improve reliability (resilience to individual failures).

**What works:** The panel orchestration (it is just a `Promise.all` over N judges). The prompt template. The verdict parsing.

**Design changes needed:**
- **Tie-breaking rule.** Specify: ties default to FAIL (conservative). Or: require odd panel sizes. Or: use confidence-weighted voting where ties are broken by average confidence score.
- **Per-provider rate limiting.** Group judges by provider. Apply a per-provider concurrency limit (e.g., max 5 concurrent calls to OpenAI). Use a semaphore pattern per provider.
- **Maximum panel size.** Cap at 7 (the plan already says 1-7). Document why: diminishing returns, cost, latency. If a user wants 20, they must override with `--force`.
- **Cost estimation per-judge.** Show estimated cost breakdown by judge model in the pre-run summary.

---

## 5. Speed -- Agent Response Time

**Normal: ~1s.**

### At 0ms (instant)

**What breaks:**
- **Process spawn overhead dominates.** `child_process.spawn` has ~50-100ms overhead per invocation on most systems. With 50 trials, that is 2.5-5 seconds of pure spawn overhead. This is fine, but the `_duration` field will report 50-100ms instead of 0ms. The user's agent might genuinely take 0ms (e.g., a script that reads a file and prints it), but the reported duration includes Cerberus overhead.
- **Temp file I/O.** Each trial writes a scenario temp file and reads the agent's output. At 50 trials/second, this is fine for local disk but could be slow on network filesystems.
- **stdout buffering.** If the agent writes to stdout and exits immediately, the child process pipe might not flush before the process exits. This is a known Node.js issue with `spawn` and short-lived processes. The plan captures stdout via pipe events -- if the process exits before the `data` event fires, stdout could be empty.

**What works:** Everything else. Fast agents are the happy path.

**Design changes needed:**
- **Separate agent duration from overhead.** Report `_duration` as the agent process wall clock time, but also track `_overhead` (spawn + teardown + contract evaluation). This helps users understand if their agent or Cerberus is the bottleneck.
- **Handle empty stdout from fast exits.** Use `spawn` with `{stdio: ['pipe', 'pipe', 'pipe']}` and collect all data before processing. Wait for both `close` event AND stdout `end` event before declaring the trial complete. Use `child_process.execFile` or collect with `concat-stream` pattern to avoid the race condition.

### At 60 seconds

**What breaks:**
- **Default timeout.** The plan says "default 60s timeout." A 60-second agent will be killed right at the boundary. This is a classic off-by-one: is it `>= 60s` or `> 60s`? At exactly the timeout boundary, behavior is nondeterministic depending on system load. The timeout should have a small grace period or the agent should be killed at `timeout + 1s`.
- **Total run time.** 50 trials x 60s = 50 minutes per study, plus contract evaluation time. Manageable but slow. The progress display needs a good ETA.
- **User perception.** 60 seconds of apparent silence per trial. The progress bar updates once per trial. The user sees nothing for a full minute, then one tick. They will think Cerberus is hung.

**What works:** SPRT, contract evaluation, result storage.

**Design changes needed:**
- **Per-trial activity indicator.** Show that the agent is still running: `Trial 12/50: running (42s elapsed)...` with a spinner. Update at least every second.
- **Configurable timeout with sensible default.** Default should be 30s, not 60s. Most agents that take >30s have a problem. Make it easy to override: `timeout: 120` in the study config.

### At 10 minutes

**What breaks:**
- **Default timeout kills legitimate agents.** Complex agents (RAG pipelines, multi-tool agents) can legitimately take 10 minutes. The 60s default will kill them every time, causing 100% trial failures and study abort.
- **SPRT interaction.** If every trial fails due to timeout, the error rate check (`max_error_rate: 20%`) will abort the study immediately. The user gets "ERROR: too many trial failures" instead of "your timeout is too low." The error message is confusing.
- **Resource leaks.** If the agent spawns subprocesses or opens connections, killing it with SIGTERM may not clean up. Zombie processes accumulate. After 50 kills, there could be 50 zombie subprocesses consuming resources.

**What works:** Nothing, if the timeout is too low. Everything, if the timeout is set correctly.

**Design changes needed:**
- **Timeout error messages.** When a trial is killed by timeout, the error message should explicitly say: `Trial killed after 60s (timeout). If your agent needs more time, set 'timeout' in your study config.`
- **Graceful shutdown.** Send SIGTERM, wait 5 seconds, then SIGKILL. This gives agents a chance to clean up.
- **Process group kill.** Use `spawn` with `{detached: true}` and kill the entire process group with `process.kill(-pid, signal)` to catch subprocesses.
- **Adaptive timeout suggestion.** If the first 3 trials all timeout, suggest a higher timeout value based on the observed pattern.

---

## 6. Speed -- LLM Judge Response Time

**Normal: ~2s.**

### At 30 seconds (rate-limited)

**What breaks:**
- **30-second judge timeout.** The plan specifies "timeout (30s per judge call)." If the provider is rate-limited and the response takes 30s, the judge call times out and is retried once. On the retry, it may still be rate-limited. The judge is then skipped. If all judges are on the same rate-limited provider, all judges are skipped, and the contract evaluation fails.
- **Cascading delays.** Judges are called in parallel, but if the slowest judge takes 30s, every trial takes at least 30s for behavioral/semantic contracts. 50 trials x 30s = 25 minutes per behavioral contract per study.
- **Retry storm.** The plan says "retry once, then skip with warning." With 50 trials and 3 judges, that is 150 judge calls. If 50% are rate-limited and retried, that is 225 total calls, making the rate limiting worse. This is a positive feedback loop.

**What works:** Programmatic contracts (no judges). The retry-once logic is simple and correct in isolation.

**Design changes needed:**
- **Exponential backoff with jitter.** Replace "retry once" with a proper retry strategy: exponential backoff starting at 1s, max 3 retries, with jitter to avoid thundering herd. Respect `Retry-After` headers from providers.
- **Per-provider rate limiter.** Implement a token bucket or sliding window rate limiter per provider. Before sending a judge call, check the limiter. If over limit, delay the call. This prevents the retry storm.
- **Longer judge timeout.** 30s is too aggressive. Some models (especially Anthropic's larger models) can take 30-60s under load. Default should be 60s for judge calls.
- **Circuit breaker pattern.** If a provider fails 5 times in a row, stop calling it for the remainder of the study. Do not keep retrying a dead provider. Mark it as "circuit open" and fall back to remaining judges.

### At total judge failure (all judges timeout)

**What breaks:**
- **Contract evaluation fails.** The plan says "require at least 1 judge to succeed (error if all fail)." If all judges fail, the semantic/behavioral contract for that trial is an error. The trial is not counted as pass or fail -- it is an error.
- **Error rate accumulation.** If all judges fail consistently (e.g., all API keys are expired), every trial with a semantic/behavioral contract will error. The `max_error_rate: 20%` threshold will be hit immediately, aborting the study.
- **Silent degradation.** If 2 of 3 judges fail but 1 succeeds, the contract is evaluated by a single judge. The user may not notice they are getting single-judge opinions instead of panel consensus. The statistical properties change significantly.

**Design changes needed:**
- **Pre-flight judge health check.** Before starting the study, make a trivial test call to each judge (e.g., "respond with the word 'ready'"). If a judge fails the health check, warn immediately and do not include it in the panel. Fail fast if no judges are available.
- **Minimum panel quorum.** Add a configurable `min_quorum` (default: 2 for panels of 3+). If fewer than `min_quorum` judges succeed for a trial, treat it as an error rather than using the reduced panel. This prevents silent degradation to single-judge mode.
- **Distinguish judge errors from trial errors.** A trial where the agent succeeded but judges failed is fundamentally different from a trial where the agent crashed. Track these separately: `judge_errors` vs. `trial_errors`. The `max_error_rate` should apply to trial errors only. Judge errors should have their own threshold (e.g., `max_judge_error_rate`).

---

## 7. Size -- Agent Output

**Normal: ~1KB JSON.**

### At 0 bytes (empty stdout)

**What breaks:**
- **JSON parsing.** `JSON.parse("")` throws. The plan says non-JSON stdout is captured as `_raw`. Empty string is not valid JSON. So `output` would be `{ _raw: "", _stderr: "...", _exitCode: 0, _duration: 100 }` with no parsed fields.
- **Programmatic contracts.** An assertion like `output.suggestions.length > 0` will throw `TypeError: Cannot read properties of undefined (reading 'length')`. The plan says "runtime errors in assertion = fail (not abort) with error message in verdict." This is correct, but the error message will be cryptic.
- **Semantic/behavioral contracts.** The judge receives empty output. The judge prompt says "Here is the agent's output: " followed by nothing. Judges may hallucinate, say the output is missing, or follow their rubric and fail the trial. Behavior is unpredictable and model-dependent.

**What works:** Adapter captures empty stdout correctly. Exit code and stderr are still available. The trial completes without crashing.

**Design changes needed:**
- **Empty output detection.** If stdout is 0 bytes and exit code is 0, this is suspicious. Warn: `Trial N: agent produced no output (empty stdout). This usually indicates a problem with the adapter command.`
- **Null-safe output access.** Provide helper functions for contract assertions: `output.get("suggestions", [])` or similar. Or wrap assertion evaluation in a more descriptive error handler: instead of `TypeError: Cannot read properties of undefined`, produce `Assertion error: 'output.suggestions' is undefined. Agent output was empty.`
- **Judge prompt handling.** If agent output is empty, prepend to the judge prompt: "Note: the agent produced no output." This gives judges clear context rather than silent absence.

### At 100MB

**What breaks:**
- **Memory.** Each trial stores `_raw` (the full stdout) in the `TrialResult`. 50 trials x 100MB = 5GB in memory. Node.js will OOM crash (default heap is ~1.5GB for Node 20).
- **JSON parsing.** `JSON.parse` on a 100MB string is slow (~2-5 seconds) but will succeed if the string is valid JSON. However, the parsed object could be another 200MB+ in memory (JSON parse expands strings due to object overhead).
- **Judge prompts.** The judge prompt includes the agent output. Sending 100MB to an LLM API will be rejected (context limits are typically 128K-200K tokens, roughly 500KB-800KB of text). The API call fails immediately.
- **Result persistence.** Writing 50 x 100MB = 5GB to `.cerberus/runs/<timestamp>.json` is slow and wastes disk.
- **Pipe buffering.** `child_process.spawn` uses 64KB pipe buffers by default. 100MB of stdout through a pipe works fine (Node.js handles this with streaming), but the plan collects all stdout into a single string -- this means 100MB is held in memory per trial concurrently.

**What works:** The adapter's stdout pipe will stream correctly. The process will not hang. Small programmatic contracts that check `_exitCode` or `_raw.includes("keyword")` will work (though `.includes` on 100MB is slow).

**Design changes needed:**
- **Output size limit.** Configurable `max_output_size` (default: 1MB). If stdout exceeds this, truncate and warn. Store the full output on disk if needed for debugging, but do not keep it in memory or pass it to judges.
- **Streaming stdout capture.** Do not collect stdout into a single string. Stream it to a temp file, then read only what is needed. For programmatic contracts, provide a streaming interface or read the file. For judge prompts, read only the first N characters.
- **Judge output truncation.** Before building judge prompts, truncate agent output to a configurable limit (default: 10KB, max: 100KB). Document this: "Judge prompts include at most 10KB of agent output. To evaluate larger outputs, use programmatic contracts."
- **Result storage.** Store large outputs as separate files referenced by the result JSON, not inline.

---

## 8. Size -- Config File

**Normal: ~50 lines YAML.**

### At 5,000 lines

**What breaks:**
- **YAML parsing performance.** The `yaml` library can parse 5,000 lines in <100ms. Not a problem.
- **Zod validation performance.** Validating a deeply nested object with 50 studies x 100 contracts = 5,000 contract schemas. Zod validation is O(n) for arrays, so this is fine (~10ms).
- **Error messages.** If there is a validation error on line 4,800, the Zod error path will be something like `studies[48].contracts[23].threshold`. This is useful but not user-friendly. The user needs to know the line number in the YAML file, not the Zod path.
- **Config readability.** 5,000 lines of YAML is unmaintainable. Users will make mistakes, duplicate definitions, have inconsistencies.
- **Editor support.** Most editors handle 5,000-line YAML files fine, but YAML's indentation sensitivity makes it error-prone at scale.

**What works:** Everything mechanical -- parsing, validation, type safety.

**Design changes needed:**
- **Zod error to YAML line mapping.** When reporting validation errors, include the approximate YAML line number. The `yaml` library provides source map information that can be used for this.
- **Config composition.** Support importing/referencing other files:
  ```yaml
  studies:
    - !include studies/security.yaml
    - !include studies/performance.yaml
  contracts:
    shared: !include contracts/common.yaml
  ```
  This is the only real solution to config scale. Without it, users will avoid Cerberus for large-scale evaluations or build external templating.
- **Config validation command.** `cerberus validate` to check config without running. Useful for CI and for large configs where a run is expensive.
- **Schema documentation.** Publish a JSON Schema for `cerberus.yaml` so editors provide autocomplete and inline validation.

---

## 9. Failure Rate

**Normal: ~10% failure (90% pass rate).**

### At 0% failure (100% pass)

**What breaks:** Nothing breaks, but SPRT behavior is interesting.
- With `p0=0.90, p1=0.80`, a 100% pass rate will cross the acceptance boundary very quickly. After roughly 8-12 trials (all passes), the log-likelihood ratio accumulates enough evidence to accept H0. This is the best case for SPRT -- it saves 38-42 trials.
- Wilson CI for 12/12 at 95% is [0.735, 1.000]. This is somewhat wide because N is small. The lower bound (73.5%) is well above the rejection threshold of 80%, which is consistent with the SPRT acceptance.

**What works:** Everything. This is SPRT's sweet spot.

**Design changes needed:**
- **Display early stop reason.** When SPRT stops early, explain why: `Contract 'no-false-positives' stopped early at 12/50 trials: strong evidence of pass rate >= 90% (observed: 100%, CI: [73.5%-100%])`. The current plan's output format shows `(12 trials, early stop)` but does not explain the statistical reasoning. Users unfamiliar with SPRT will be confused about why only 12 trials were run.

### At 100% failure (0% pass)

**What breaks:** Nothing mechanically, but the UX matters.
- SPRT will reject H0 (accept H1: agent has degraded) very quickly, roughly 5-8 trials.
- Wilson CI for 0/8 at 95% is [0.000, 0.369]. The upper bound (36.9%) is well below the threshold of 90%.
- Exit code 1 (fail). Correct.

**What works:** SPRT early stopping is maximally efficient here.

**Design changes needed:**
- **Failure diagnostics.** When all trials fail, the user needs to know WHY. Showing "0.0% pass rate" is not helpful. Show the first few failure reasons:
  ```
  Contract 'catches-security-issues' FAIL 0.0% [CI: 0-37%] (8 trials, early stop)
    Trial 1: Judge verdict: FAIL - "Agent did not mention SQL injection"
    Trial 2: Judge verdict: FAIL - "Agent suggested unsafe query construction"
    Trial 3: (and 5 more similar failures)
  ```
  This requires storing and summarizing per-trial failure reasons, which the current plan supports (judge reasoning is in `ContractVerdict`) but does not surface in the output.
- **Fast-fail mode.** Optional: if the first N trials all fail, stop immediately without waiting for SPRT. Useful in CI where you want fast feedback. SPRT will naturally do this (5-8 trials), but a user might want to set `fast_fail: 3` to stop after 3 consecutive failures.

### At 50% failure (borderline)

**What breaks:**
- **SPRT indecision.** With `p0=0.90, p1=0.80`, a 50% pass rate is far below both hypotheses. SPRT will reject H0 (accept degradation) relatively quickly because 50% is far from 90%. Roughly 5-10 trials.
- **The interesting borderline is at 85%.** This is between `p0=0.90` and `p1=0.80`. At 85% true pass rate, SPRT will oscillate. The log-likelihood ratio will hover near zero, drifting slowly. It may take all 50 trials (or more) without reaching either boundary. The user gets exit code 3 (inconclusive).
- **Inconclusive is a UX problem.** In CI, inconclusive is neither green nor red. The plan maps it to exit code 3. Most CI systems treat non-zero as failure. So "inconclusive" effectively means "fail" in CI. This is a critical design issue: the user's agent is performing at 85% (decent but not meeting the 90% threshold), but CI treats it the same as a catastrophic failure.

**What works:** The statistical reasoning is correct. SPRT correctly identifies that there is insufficient evidence.

**Design changes needed:**
- **Inconclusive handling in CI.** Add `--inconclusive-as` flag: `--inconclusive-as pass` (treat inconclusive as exit 0) or `--inconclusive-as fail` (treat inconclusive as exit 1, the default). This lets users decide their policy.
- **Increase trial count suggestion.** When a study ends inconclusive, suggest: `Contract 'follows-style-guide' inconclusive after 50 trials (observed: 85%, CI: [72%-93%]). Try increasing 'trials' to 200 for more statistical power at this pass rate.` Calculate the required N to distinguish p0=0.90 from the observed rate with the configured alpha/beta.
- **Indifference zone documentation.** Document that pass rates between `p1` and `p0` (the "indifference zone" of 80%-90%) are expected to produce inconclusive results. This is a feature, not a bug -- SPRT cannot and should not make strong claims about rates in the indifference zone. Users need to understand this.

---

## 10. Duration -- Full Suite

**Normal: ~5 minutes.**

### At 10 hours

**What breaks:**
- **CI timeouts.** GitHub Actions: 6 hours default, 72 hours max. GitLab CI: 1 hour default. CircleCI: 10 minutes default. A 10-hour Cerberus run will be killed by most CI systems. The user gets no results.
- **API key expiration.** Some providers rotate short-lived tokens. A 10-hour run might span a token refresh window.
- **Network interruptions.** Over 10 hours, the probability of at least one network blip is high. A single failed judge call triggers a retry, but sustained network issues over hours will cause cascading failures.
- **No checkpointing.** If the process is killed at hour 9, all 9 hours of work are lost. There is no way to resume.
- **Terminal disconnection.** If running interactively (not CI), the user's SSH session or terminal may disconnect. The process continues but output is lost.
- **Memory leaks.** Even small leaks (e.g., event listeners not cleaned up, growing arrays) become visible over 10 hours. The process may slowly consume memory until OOM.

**What works:** The core logic has no time-dependent assumptions. SPRT, contract evaluation, and result recording are all stateless per-trial.

**Design changes needed:**
- **Checkpointing and resume.** After each trial, write a checkpoint to `.cerberus/checkpoints/<run-id>.json` containing: current SPRT state per contract, trial count, aggregate stats, and a pointer to the JSONL file of completed trial results. On `cerberus run --resume`, load the checkpoint and continue from where it stopped.
- **SIGTERM/SIGINT handling (Ctrl+C).** Trap SIGINT (Ctrl+C). On first SIGINT: finish the current trial, write a checkpoint, print partial results, exit with a special code (e.g., exit code 5 for "interrupted"). On second SIGINT: immediately abort. This is critical for interactive use.
- **Partial results on interrupt.** Even without a full checkpoint/resume system, print partial results when interrupted. The user invested hours -- they deserve to see what was collected.
- **Estimated time remaining.** Calculate and display ETA based on moving average of trial duration. Update every trial.
- **Background/detached mode.** Support `cerberus run --detach` that runs in the background and writes results to disk. The user can check progress with `cerberus status`. This is post-MVP but the architecture should not preclude it.
- **Timeout budget.** Add a `max_duration` config option at the suite level. If the total run time exceeds this, gracefully stop: finish the current trial, write results, exit. This prevents accidental 10-hour runs.

---

## Cross-Cutting Design Changes Summary

The Scale Game reveals several themes that cut across multiple dimensions:

### 1. Streaming Architecture (Dimensions 1, 7, 10)
The plan assumes in-memory accumulation of all trial results. This breaks at high trial counts, large outputs, and long durations. **Change:** Design a streaming architecture from the start. Trial results go to disk (JSONL) as they complete. In-memory state is limited to running aggregates.

### 2. Concurrency (Dimensions 1, 2, 3, 5)
Sequential execution is a bottleneck at every scale dimension. **Change:** Build the trial runner with a concurrency parameter from day one. Default to 1 for safety, but the architecture must support N. Use a semaphore/pool pattern, not a for-loop. Parallelize contract evaluation within a trial (independent I/O-bound operations).

### 3. Cost Awareness (Dimensions 1, 4, 6)
The plan has no cost estimation, confirmation, or limits. At scale, this is a financial hazard. **Change:** Add cost estimation before runs start. Add `--max-cost` flag. Track running cost during execution. Show cost in results summary.

### 4. Graceful Degradation (Dimensions 5, 6, 7, 10)
Every external dependency (agent process, LLM APIs, network) can fail in ways the plan does not fully address. **Change:** Add circuit breakers for judge providers. Add pre-flight health checks. Add checkpointing. Handle SIGINT. Distinguish judge errors from trial errors.

### 5. Benjamini-Hochberg Default (Dimensions 2, 3)
Bonferroni correction is too conservative for anything beyond ~10 contracts. **Change:** Default to BH. Make Bonferroni opt-in.

### 6. User Communication (Dimensions 1, 5, 9, 10)
At extreme scales, the user needs more information: ETAs, cost estimates, failure diagnostics, early stop explanations, resume instructions. **Change:** Invest heavily in the progress and reporting system. Show trial-level activity, per-contract SPRT state, running cost, and ETA.

---

## Priority Ranking of Design Changes

Changes are ranked by: how many scale dimensions they address, how likely real users are to hit them, and how hard they are to retrofit.

| Priority | Change | Dimensions | Effort |
|---|---|---|---|
| **P0 (must have for MVP)** | SIGINT handling with partial results | 10, all | Low |
| **P0** | Output size limit and truncation | 7, 1 | Low |
| **P0** | BH as default correction method | 2, 3 | Low |
| **P0** | Empty output handling | 7 | Low |
| **P0** | Graceful process kill (SIGTERM then SIGKILL) | 5 | Low |
| **P0** | Timeout error messages mentioning config fix | 5 | Low |
| **P0** | Tie-breaking rule for even judge panels | 4 | Low |
| **P1 (should have for MVP)** | Streaming trial results to disk (JSONL) | 1, 7, 10 | Medium |
| **P1** | Cost estimation before run | 1, 4, 6 | Medium |
| **P1** | Per-trial activity indicator for slow agents | 5, 10 | Low |
| **P1** | Pre-flight judge health check | 6 | Low |
| **P1** | `min_trials` validation against SPRT parameters | 1, 9 | Low |
| **P1** | Inconclusive handling (`--inconclusive-as`) | 9 | Low |
| **P1** | Failure diagnostics (show first N failure reasons) | 9 | Medium |
| **P1** | Circuit breaker for judge providers | 6 | Medium |
| **P1** | Judge output truncation for prompts | 7 | Low |
| **P1** | Early stop explanation in output | 9 | Low |
| **P2 (nice to have)** | Trial concurrency (`concurrency: N`) | 1, 2, 3 | Medium |
| **P2** | Checkpointing and resume | 10 | High |
| **P2** | Per-provider rate limiting | 4, 6 | Medium |
| **P2** | Config composition (`!include`) | 3, 8 | Medium |
| **P2** | `cerberus validate` command | 8 | Low |
| **P2** | Contract groups and summary view | 2 | Medium |
| **P2** | Suite-level `max_duration` | 10 | Low |
| **P2** | `--filter` for contract subset | 2 | Low |
| **P2** | Deterministic mode for `trials: 1` | 1 | Low |
| **P3 (post-MVP)** | Zod error to YAML line mapping | 8 | Medium |
| **P3** | Study-level parallelism | 3 | High |
| **P3** | Background/detached mode | 10 | High |
| **P3** | JSON Schema for config editor support | 8 | Low |
| **P3** | Adaptive timeout suggestion | 5 | Low |
