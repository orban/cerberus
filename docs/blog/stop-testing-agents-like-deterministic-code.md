# Stop Testing AI Agents Like Deterministic Code

Your AI agent CI is a coin flip and you don't know it.

Here's what I mean. You wrote an agent. It calls an LLM, maybe several LLMs, uses tools, makes decisions. It works well — you've seen it work. So you write tests. `assert(agent(input) === expected_output)`. Run it in CI. Green. Ship it.

Except the next day it's red. Nobody changed anything. You rerun the pipeline. Green again.

"Flaky test," someone says, and you move on.

That test wasn't flaky. It was *statistically inevitable*. You're testing a stochastic system with deterministic assumptions, and the math guarantees it'll bite you.

---

## The problem with assert

When you write `assert(f(x) === y)`, you're making a very specific claim: *this function always returns this value for this input*. That's valid for `parseInt("42")`. It's not valid for a system that queries a language model.

To be clear: some agent properties *are* deterministic. "The process exits without crashing" or "the output is valid JSON" — you can still hard-assert those. The problem is when you apply the same pattern to inherently stochastic properties like output quality, task completion, or rubric adherence.

An AI agent is approximately a Bernoulli process. Each invocation is a trial with some probability *p* of producing a satisfactory result. You don't know *p*. You're trying to figure out if *p* is high enough. (In practice, *p* varies by task difficulty, prompt phrasing, and model state — it's a mixture, not a single fixed rate. The Bernoulli framing is a useful simplification for the math that follows, not a claim that all trials are identical.)

Here's where it gets painful. Say your agent genuinely has a 90% success rate — solid, shippable. You have 10 test cases, each run once. What's the probability of a perfectly clean CI run?

```
P(all 10 pass) = 0.9^10 = 0.349
```

**65% chance of at least one failure.** Not because your agent is broken — because you ran 10 independent Bernoulli trials with p=0.9. Your "flaky" CI isn't flaky. It's working exactly as probability says it should. You just built a testing framework that can't handle that.

![A 90% pass rate almost guarantees at least one failure](figures/failure-probability.svg)

(This assumes independent trials. Real systems often show overdispersion — if your tests share a common failure mode, failures will cluster rather than distribute uniformly. The math changes, but the fundamental problem doesn't: deterministic assertions on stochastic behavior produce misleading results either way.)

Run those same 10 tests twice each? Now it's p=0.9 across 20 trials. P(at least one failure) = 87%. The more tests you add, the worse it gets.

## The reframe: testing as hypothesis testing

Once you stop thinking of agent tests as *assertions* and start thinking of them as *experiments*, the solution becomes obvious.

You're not asking: "Did this test pass?" You're asking: "Does this agent pass *reliably enough*?"

That's a hypothesis test. Specifically:

- **Null hypothesis (H₀):** The agent's true pass rate meets our threshold (p ≥ 0.90)
- **Alternative hypothesis (H₁):** The agent's pass rate is below threshold (p < 0.80)

The gap between 0.90 and 0.80 is the indifference zone — rates in that range are borderline and we'll need more data to decide. The key insight is that instead of a single binary observation, you're collecting *evidence* across multiple trials.

This immediately changes CI from "run once, pray" to something that can make statistically valid claims about your agent's reliability.

## Adaptive sampling with SPRT

The simplest version of this is fixed-N testing: run each contract 50 times, compute a binomial test, and gate on the result. That works. If you stop here, you're already ahead of `assert`. But 50 runs per contract is expensive, and most of those runs are wasted when the answer is obvious after 10.

You don't need 50 runs. Not usually.

The Sequential Probability Ratio Test (SPRT), developed by Abraham Wald during World War II for quality control, is designed for exactly this problem: make a decision with as few observations as possible.

Here's the intuition. You're watching a stream of trial results (pass/fail). After each trial, you ask: "Do I have enough evidence to decide?" If the agent passes 12 out of 12 trials, you probably don't need trials 13 through 50 to be confident it's above a 90% threshold. SPRT formalizes that intuition.

After each trial, you update a log-likelihood ratio:

```
If the trial passed:  logLR += log(p₀ / p₁)
If the trial failed:  logLR += log((1 - p₀) / (1 - p₁))
```

Where p₀ is your threshold (0.90) and p₁ is the alternative (0.80). Technically, SPRT tests simple hypotheses (p = p₀ vs p = p₁), not the composite "p ≥ threshold" you actually care about. The standard trick is to pick p₁ as a specific "unacceptable" rate below your threshold — the reference implementation uses p₁ = max(0.01, p₀ - 0.10) — and test between those two points. Then compare against two boundaries:

- **Accept (agent is good enough):** logLR ≥ log((1 - α) / β)
- **Reject (agent is failing):** logLR ≤ log(α / (1 - β))
- **Continue testing:** otherwise

With typical values (α=0.05, β=0.20), the upper boundary is log(4.75) ≈ 1.56 and the lower is log(0.0625) ≈ -2.77.

**A concrete example.** Suppose your agent has a true pass rate of 95%, and you're testing against a 90% threshold:

```
Trial 1:  pass → logLR = +0.118     (continue)
Trial 2:  pass → logLR = +0.235     (continue)
Trial 3:  pass → logLR = +0.353     (continue)
...
Trial 7:  pass → logLR = +0.824     (continue)
...
Trial 14: pass → logLR = +1.649     → ACCEPT ✓
```

14 trials instead of 50. A 72% reduction.

Now suppose the agent is actually bad — true rate of 60%:

```
Trial 1:  pass → logLR = +0.118
Trial 2:  fail → logLR = -0.575
Trial 3:  fail → logLR = -1.268
Trial 4:  pass → logLR = -1.150
Trial 5:  fail → logLR = -1.843
Trial 6:  fail → logLR = -2.536
Trial 7:  fail → logLR = -3.229     → REJECT ✗
```

7 trials. It cuts losses fast.

![SPRT random walk — good agent accepted in 14 trials, bad agent rejected in 7](figures/sprt-random-walk.svg)

SPRT is both a statistical tool and a cost optimizer. For clearly passing or clearly failing agents, it saves 60-80% of trial runs. That's real money when each trial is an LLM call. (For borderline agents — true rate near the indifference zone — SPRT can run as long as or longer than fixed-N. That's a feature: it's telling you the answer is genuinely ambiguous.)

## Confidence intervals that mean something

SPRT gives you a go/no-go decision, but you also want to *see* the agent's reliability. "90% pass rate" from 10 runs means something very different than "90% pass rate" from 100 runs. This is where confidence intervals come in.

The naive approach (`p ± z * sqrt(p(1-p)/n)`) has a well-known problem at the boundaries. If your agent passes 10/10 trials, the naive 95% interval is [1.0, 1.0]. Confident that *nothing will ever go wrong*? That's clearly absurd.

Wilson score intervals handle this correctly:

```
center = (p̂ + z²/2n) / (1 + z²/n)
spread = z * sqrt(p̂(1-p̂)/n + z²/4n²) / (1 + z²/n)
```

For 10/10 at 95% confidence, Wilson gives [0.72, 1.00]. Much more honest: you've seen all successes, but the sample is small.

The practical impact:

| Observations | Pass rate | Naive 95% CI | Wilson 95% CI |
|-------------|-----------|-------------|---------------|
| 9/10 | 90% | [71%, 100%] | [60%, 98%] |
| 10/10 | 100% | [100%, 100%] | [72%, 100%] |
| 0/10 | 0% | [0%, 0%] | [0%, 28%] |
| 45/50 | 90% | [82%, 98%] | [79%, 96%] |
| 90/100 | 90% | [84%, 96%] | [83%, 94%] |

![Wilson score intervals vs naive (Wald) intervals](figures/wilson-vs-naive.svg)

Notice how Wilson is *wider* for small samples and converges to the naive interval as *n* grows. That's exactly the behavior you want — appropriate skepticism.

One caveat: if you're reporting Wilson intervals after SPRT early-stopped, the interval is *descriptive*, not inferential — optional stopping changes the coverage properties. Use these CIs for human-readable summaries, not as formal inference on the stopped data.

## The multiple testing trap

Here's a subtler problem. Say you have 10 contracts for your agent, and each has a false rejection rate of α=0.05. In the worst case (agent performing right at the threshold boundary), the probability of at least one spurious rejection across all 10:

```
P(≥1 false rejection) = 1 - (1 - 0.05)^10 ≈ 0.40
```

**Up to 40% chance of a spurious failure.** This is an upper bound under independence — if the agent comfortably exceeds all thresholds, the actual per-contract rejection rate is well below α and the family-wise risk is much lower. But when your agent is near a boundary on even one contract, the compound risk grows fast.

Here, "false rejection" means incorrectly declaring a passing contract as failing. That's the direction that matters in CI gating — spurious red builds.

The classical fix is Bonferroni correction: divide α by the number of tests. With 10 tests, each one uses α=0.005 instead of 0.05. This controls the probability of *any* spurious rejection (FWER), but it's conservative — it makes each individual test harder to pass, increasing the chance you'll fail to detect a real regression.

Benjamini-Hochberg (BH) is a less conservative alternative. Instead of controlling the probability of *any* false rejection, it controls the *proportion* of false rejections among all rejected contracts (false discovery rate). The algorithm:

1. Sort p-values from smallest to largest
2. For the k-th p-value, compare against (k/n) × α
3. Find the largest k that passes; reject all up to that point

BH controls FDR while rejecting more true positives than Bonferroni. If your requirement is strict control over the probability of *any* false rejection, Bonferroni is the right choice. If you're optimizing for overall suite accuracy and can tolerate a controlled proportion of false rejections, BH is better.

Two caveats. First, BH's FDR guarantee assumes independence or positive regression dependence (PRDS) among test statistics. Contracts evaluated on the same agent output may be correlated — "produces valid JSON" and "JSON has required fields" aren't independent. If your contracts are highly correlated, consider Benjamini-Yekutieli (BY) correction, which controls FDR under arbitrary dependence at the cost of being more conservative. Second, the "family" being corrected matters: in the reference implementation, it's contracts within a single study (all assertions evaluated on the same agent run). If your deploy gate checks contracts across *multiple* studies, you'd want the family to span the full pipeline.

If you have a single contract, none of this matters. If you have 15 contracts checking different aspects of your agent's output, it matters a lot.

## What CI/CD should actually look like

With these pieces, we can define what a statistically sound CI pipeline looks like for agents.

**Exit codes that mean something.** Not just 0/1, but:

| Exit code | Meaning |
|-----------|---------|
| 0 | PASS — Evidence the agent meets all thresholds |
| 1 | FAIL — Evidence the agent is below threshold on at least one contract |
| 3 | INCONCLUSIVE — Hit max trials without enough evidence either way |

Inconclusive is important. It's the honest answer when you've burned your trial budget and the data is ambiguous. Treating inconclusive as a failure is a conservative policy choice — it won't cause bad agents to ship, but it biases your inference and may block good agents unnecessarily. Treating it as a pass is irresponsible. In practice, an inconclusive result means: "increase your trial budget or investigate why the agent is borderline."

**Threshold-based gates, not exact matching.** A config like:

```yaml
studies:
  - name: my-agent-quality
    scenario: scenarios/task.yaml
    contracts:
      - name: exits-cleanly
        type: code
        assert: "output.meta.exitCode === 0"
        threshold: 0.95    # Must pass 95% of the time
        confidence: 0.95   # At 95% confidence level
        trials: 50         # Max trials budget

      - name: response-is-valid-json
        type: code
        assert: "output.meta.jsonParsed === true"
        threshold: 0.90
        confidence: 0.95
        trials: 50
```

Each contract specifies *how reliable* the behavior needs to be, not that it must always succeed. A 95% threshold with 95% confidence means: "If this agent truly passes 95% of the time, I'll incorrectly reject it at most 5% of the time (α=0.05). If it truly passes only 85% of the time, I'll correctly reject it at least 80% of the time (β=0.20)." The α side protects good agents from false alarms; the β side controls how often bad agents slip through.

**How do you choose a threshold?** Start with your product's tolerance for user-visible failures. Deterministic properties (valid JSON, clean exit) can be held to 0.95-0.99. Quality properties (good summaries, correct answers) depend on your use case — if you'd accept a 15% failure rate in production, 0.85 is your threshold. When in doubt, start at 0.85 and tighten as you learn your agent's actual distribution from historical runs. Note that very high thresholds (0.99) make the test sensitive to individual failures — a single bad trial can dominate the evidence.

**Result persistence.** Save every run to `.cerberus/runs/` as JSON:

```json
{
  "status": "pass",
  "studies": [{
    "name": "code-review-agent",
    "contracts": [{
      "name": "exits-cleanly",
      "status": "pass",
      "observedRate": 0.96,
      "ci": { "lower": 0.87, "upper": 0.99 },
      "trialsEvaluated": 14,
      "sprtStoppedEarly": true
    }]
  }]
}
```

Over time, this gives you trend data. Is the agent's observed rate drifting down? Are you seeing more inconclusive results? Trend analysis on historical runs is more informative than any single CI check.

## The cost equation

Let's make the SPRT cost savings concrete.

Suppose you have 5 contracts, each with a max budget of 50 trials. A simple agent making a few API calls might cost $0.01-$0.10 per trial. A real agentic workflow (multi-step tool use, code generation, Docker execution) can easily cost $0.50-$5.00 per trial. Fixed-sample testing with a mid-range agent at $1.00/trial:

```
5 contracts × 50 trials × $1.00 = $250 per CI run
```

With SPRT on a clearly passing agent (true rate 96%, threshold 90%), each contract typically stops at ~14 trials:

```
5 contracts × 14 trials (avg) × $1.00 = $70 per CI run
```

**72% cost reduction.** For a clearly failing agent, SPRT also saves — a completely broken agent (0% pass rate) rejects in 4-5 trials, and a moderately bad agent (60% pass rate) typically rejects in 8-15 trials.

| Method | Trials | $0.01/trial | $1.00/trial | $5.00/trial |
|--------|--------|------------|------------|------------|
| Fixed N=50 | 250 | $2.50 | $250 | $1,250 |
| SPRT (passing) | ~70 | $0.70 | $70 | $350 |
| SPRT (failing) | ~75 | $0.75 | $75 | $375 |

The savings scale with trial cost. At $5/trial, SPRT saves $900 per CI run on a passing suite. Run that 10 times a day and you're looking at real money. SPRT doesn't just give you better statistics — it gives you a substantially smaller bill.

## Lessons from building an eval harness

That's the theory. Here's what actually happened when we tried to use it.

We built an A/B testing framework that measures whether giving Claude contextual documentation helps it fix bugs — running agents in Docker, collecting pass/fail outcomes, computing the same Wilson intervals and paired tests described above. Every lesson below is something the statistical machinery couldn't save us from on its own.

### Single runs tell you almost nothing

Early on we ran each task once per condition (baseline vs. treatment), compared the results, and drew conclusions. The AGENTbench paper that inspired the work did the same thing: one run per task, temperature=0, no repetitions, no p-values. With those sample sizes, their reported 2-4% deltas are likely within the margin of random variation — there's no power analysis to say otherwise.

When we started running 3-5 repetitions per condition, the picture changed. A task that passed once under baseline would fail the next three times. A treatment that looked worse in a single run showed a 60% success rate over five runs — better than baseline's 40%. The variance itself turned out to be informative: if adding context makes the agent *more* variable rather than more reliable, the context is probably confusing it rather than helping.

The fix was straightforward: always run with repetitions, report Wilson score confidence intervals on the per-condition success rates, and use McNemar's test for paired comparison. We pair by task and repetition index (trial 1 of condition A pairs with trial 1 of condition B on the same task). The pairing is valid because both conditions share the same nuisance variables — same repository, same pre-fix commit, same Docker image, same prompt. If a result isn't statistically significant, say so.

### You need a taxonomy of failures

Not all failures are equal, and conflating them corrupts your statistics.

We learned this by accident. Our early runs classified timeouts as infrastructure errors and excluded them from the success rate denominator. This inflated reported success rates by 8-12 percentage points. A task where the agent spent 300 seconds actively working (making tool calls, editing files) before running out of time isn't an infrastructure failure — it's a genuine experimental outcome.

We ended up with five error classes:

| Error tag | Meaning | Counted in success rate? |
|-----------|---------|--------------------------|
| *(none)* | Normal trial (pass or fail) | Yes |
| `[timeout]` with tool_calls > 0 | Agent ran out of time while working | Yes (as failure) |
| `[infrastructure]` | Docker crash, network issue | No |
| `[pre-validation]` | Test was broken before agent touched it | No |
| `[empty-run]` | Agent returned instantly, did nothing | No |

One subtlety: timeouts are technically a *censoring* mechanism, not a clear-cut failure. An agent that was making progress when time ran out might have succeeded with a longer budget. Counting all timeouts as failures can penalize slower-but-correct strategies. We accepted this trade-off because the timeout represents a real operational constraint (you don't get infinite time in CI), but if you're doing research rather than CI gating, you might want to analyze timeouts separately.

The broader distinction matters. Per-protocol analysis (excluding infrastructure errors from the denominator) tells you how the agent performs *when it actually runs*. Intent-to-treat analysis (counting everything) tells you how reliable the whole pipeline is. You want both numbers.

### Separate what you're measuring

When comparing conditions, be precise about what goes into each metric. We had two kinds of confounds:

**Setup cost vs. experimental cost.** Our treatments add documentation to the agent's context before it attempts a fix. Generating that documentation takes time and tokens. If you lump generation cost into the fix cost, you're measuring two things at once. We split metrics into *fix-only* (the agent's actual debugging work) and *setup* (one-time indexing overhead). Delta calculations use only fix-only metrics. We only caught this because a treatment was "losing" on tokens solely due to setup cost, not the fix.

**No-ops contaminating failure rates.** An agent can return instantly without doing work (zero tool calls, 0.0 seconds). If you don't detect these and exclude them, they fall through to test execution, fail (nothing was changed), and inflate your failure rate. Detect no-ops by checking for an activity signal (for tool-using agents, `tool_calls == 0`), not wall-clock time.

### Paired tests > unpaired tests

When you're comparing two conditions on the same tasks, use a paired statistical test. McNemar's test looks at *discordant pairs* — cases where condition A passed but B failed, or vice versa. It ignores cases where both passed or both failed, because those tell you nothing about the difference between conditions. With small sample sizes (under ~25 discordant pairs), use the exact binomial form rather than the chi-squared approximation — the asymptotic version is unreliable when counts are low.

This matters more than you'd think. In one eval run, baseline had an 80% success rate and the treatment had 50%. Looks bad for the treatment. But McNemar's p-value was 0.25 — not significant. Why? Only 3 discordant pairs out of 10, and the sample was too small to distinguish the difference from chance. Without the paired test, we would've incorrectly concluded the treatment was harmful.

CI overlap is *not* a valid substitute for a paired test. With small samples and wide intervals, the relationship between CI overlap and statistical significance breaks down — overlapping CIs don't prove equivalence, and non-overlapping CIs don't prove significance when the data is paired. We display CI overlap as a visual heuristic in reports, but significance decisions come from McNemar.

### At scale, everything above compounds

The cost section above covers a range of per-trial costs, but our real trials sat at the high end: 50k-500k tokens each and 5-30 minutes. A single eval run across 7 tasks, 3 conditions, and 5 repetitions consumed 24 million tokens. At that scale, SPRT early stopping, proper error classification, and metric separation aren't academic preferences — they're the difference between a viable evaluation pipeline and a budget crater.

## Try it yourself

If you want to put this into practice, the code behind these ideas is a reference implementation you can read end-to-end:

**[github.com/orban/cerberus](https://github.com/orban/cerberus)** — 1,600 lines of TypeScript, 80 tests.

```bash
git clone https://github.com/orban/cerberus.git
cd cerberus
npm install && npm run build

# Initialize a starter config
npx cerberus init

# Run the test suite
npx cerberus run
```

The config is YAML. You point it at a command that runs your agent, define contracts (either code assertions or LLM-judge evaluations), and set thresholds:

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

      - name: produces-valid-json
        type: code
        assert: "output.meta.jsonParsed === true"
        threshold: 0.90
        confidence: 0.95
        trials: 50
```

Output looks like:

```
Contracts:
  exits-cleanly       PASS  100.0% [CI: 84–100%]  (11 trials, early stop)
  produces-valid-json  PASS   93.3% [CI: 70–99%]   (15 trials, early stop)

Suite: PASS (2/2 contracts satisfied)
```

The implementation is deliberately minimal — 9 source files, 4 runtime dependencies — so you can read the code and understand every decision. See the [README](https://github.com/orban/cerberus) for a file-by-file map of which concepts live where.

---

## Appendix: The math

For readers who want the precise formulations.

### SPRT (Sequential Probability Ratio Test)

For Bernoulli observations with null hypothesis p₀ and alternative p₁:

**Log-likelihood ratio update:**

$$\Lambda_n = \Lambda_{n-1} + \begin{cases} \log(p_0 / p_1) & \text{if trial passed} \\ \log((1 - p_0) / (1 - p_1)) & \text{if trial failed} \end{cases}$$

**Wald boundaries:**

$$A = \frac{1 - \alpha}{\beta}, \quad B = \frac{\alpha}{1 - \beta}$$

**Decision rule:**

$$\begin{cases} \text{Accept } H_0 & \text{if } \Lambda_n \geq \log(A) \\ \text{Reject } H_0 & \text{if } \Lambda_n \leq \log(B) \\ \text{Continue} & \text{otherwise} \end{cases}$$

Where α is the Type I error rate (false rejection) and β is the Type II error rate (false acceptance).

**Default configuration** (from threshold *t* and confidence *c*):
- p₀ = t
- p₁ = max(0.01, t − 0.10)
- α = 1 − c
- β = 0.20

### Wilson score interval

For *k* successes in *n* trials at confidence level (1 − α):

$$\text{center} = \frac{\hat{p} + \frac{z^2}{2n}}{1 + \frac{z^2}{n}}$$

$$\text{spread} = \frac{z \sqrt{\frac{\hat{p}(1-\hat{p})}{n} + \frac{z^2}{4n^2}}}{1 + \frac{z^2}{n}}$$

$$CI = [\text{center} - \text{spread}, \; \text{center} + \text{spread}]$$

Where $\hat{p} = k/n$ and $z = \Phi^{-1}(1 - \alpha/2)$.

Wilson score is preferred over the normal approximation because it:
- Never produces intervals outside [0, 1]
- Gives sensible intervals for k=0 and k=n
- Has better coverage probability for small n

### Benjamini-Hochberg procedure

Given *m* p-values p₁ ≤ p₂ ≤ ... ≤ pₘ and desired FDR level α:

1. Find the largest *k* such that $p_k \leq \frac{k}{m} \cdot \alpha$
2. Reject all hypotheses H₁, H₂, ..., Hₖ

This controls the expected false discovery rate: $E[\text{FDR}] \leq \alpha$.

Compared to Bonferroni ($\alpha' = \alpha/m$), BH is less conservative and rejects more hypotheses while still maintaining rigorous FDR control.
