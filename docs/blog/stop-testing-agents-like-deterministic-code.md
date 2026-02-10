# Stop Testing AI Agents Like Deterministic Code

Your AI agent CI is a coin flip and you don't know it.

Here's what I mean. You wrote an agent. It calls an LLM, maybe several LLMs, uses tools, makes decisions. It works well — you've seen it work. So you write tests. `assert(agent(input) === expected_output)`. Run it in CI. Green. Ship it.

Except the next day it's red. Nobody changed anything. You rerun the pipeline. Green again.

"Flaky test," someone says, and you move on.

That test wasn't flaky. It was *statistically inevitable*. You're testing a stochastic system with deterministic assumptions, and the math guarantees it'll bite you.

---

## The problem with assert

When you write `assert(f(x) === y)`, you're making a very specific claim: *this function always returns this value for this input*. That's valid for `parseInt("42")`. It's not valid for a system that queries a language model.

An AI agent is a Bernoulli process. Each invocation is a trial with some probability *p* of producing a satisfactory result. You don't know *p*. You're trying to figure out if *p* is high enough.

Here's where it gets painful. Say your agent genuinely has a 90% success rate — solid, shippable. You have 10 test cases, each run once. What's the probability of a perfectly clean CI run?

```
P(all 10 pass) = 0.9^10 = 0.349
```

**65% chance of at least one failure.** Not because your agent is broken — because you ran 10 independent Bernoulli trials with p=0.9. Your "flaky" CI isn't flaky. It's working exactly as probability says it should. You just built a testing framework that can't handle that.

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

"But wait," you say. "I can't afford to run every test 50 times. LLM calls cost money."

You don't need 50 runs. Not usually.

The Sequential Probability Ratio Test (SPRT), developed by Abraham Wald during World War II for quality control, is designed for exactly this problem: make a decision with as few observations as possible.

Here's the intuition. You're watching a stream of trial results (pass/fail). After each trial, you ask: "Do I have enough evidence to decide?" If the agent passes 12 out of 12 trials, you probably don't need trials 13 through 50 to be confident it's above a 90% threshold. SPRT formalizes that intuition.

After each trial, you update a log-likelihood ratio:

```
If the trial passed:  logLR += log(p₀ / p₁)
If the trial failed:  logLR += log((1 - p₀) / (1 - p₁))
```

Where p₀ is your threshold (0.90) and p₁ is the alternative (0.80). Then compare against two boundaries:

- **Accept (agent is good enough):** logLR ≥ log((1 - β) / α)
- **Reject (agent is failing):** logLR ≤ log(β / (1 - α))
- **Continue testing:** otherwise

With typical values (α=0.05, β=0.20), the upper boundary is log(16) ≈ 2.77 and the lower is log(0.21) ≈ -1.56.

**A concrete example.** Suppose your agent has a true pass rate of 95%, and you're testing against a 90% threshold:

```
Trial 1:  pass → logLR = +0.118     (continue)
Trial 2:  pass → logLR = +0.235     (continue)
Trial 3:  pass → logLR = +0.353     (continue)
...
Trial 12: pass → logLR = +1.41      (continue)
...
Trial 24: pass → logLR = +2.83      → ACCEPT ✓
```

24 trials instead of 50. A 52% reduction.

Now suppose the agent is actually bad — true rate of 60%:

```
Trial 1:  pass → logLR = +0.118
Trial 2:  fail → logLR = -0.58
Trial 3:  fail → logLR = -1.28
Trial 4:  pass → logLR = -1.16
Trial 5:  fail → logLR = -1.86      → REJECT ✗
```

5 trials. It cuts losses fast.

SPRT is both a statistical tool and a cost optimizer. For clearly passing or clearly failing agents, it saves 50-80% of trial runs. That's real money when each trial is an LLM call.

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
| 90/100 | 90% | [84%, 96%] | [83%, 95%] |

Notice how Wilson is *wider* for small samples and converges to the naive interval as *n* grows. That's exactly the behavior you want — appropriate skepticism.

## The multiple testing trap

Here's a subtler problem. Say you have 10 contracts (test assertions) for your agent, and you set α=0.05 for each. The probability of at least one false positive across all 10 contracts:

```
P(≥1 false positive) = 1 - (1 - 0.05)^10 ≈ 0.40
```

**40% chance of a spurious failure.** Your CI will randomly fail two out of every five runs even when the agent is perfect, just from running multiple tests.

The classical fix is Bonferroni correction: divide α by the number of tests. With 10 tests, each one uses α=0.005 instead of 0.05. This works but it's overly conservative — it makes each individual test harder to pass.

A better approach is the Benjamini-Hochberg (BH) procedure. Instead of controlling the probability of *any* false positive (family-wise error rate), it controls the *proportion* of false positives among rejected hypotheses (false discovery rate). The algorithm:

1. Sort p-values from smallest to largest
2. For the k-th p-value, compare against (k/n) × α
3. Find the largest k that passes; reject all up to that point

In practice, BH is less conservative than Bonferroni while still providing rigorous control. With 10 contracts, Bonferroni throws out twice as many valid results on average.

This is why the reference implementation defaults to BH correction. If you have a single contract, it doesn't matter. If you have 15 contracts checking different aspects of your agent's output, it matters a lot.

## What CI/CD should actually look like

With these pieces, we can define what a statistically sound CI pipeline looks like for agents.

**Exit codes that mean something.** Not just 0/1, but:

| Exit code | Meaning |
|-----------|---------|
| 0 | PASS — Evidence the agent meets all thresholds |
| 1 | FAIL — Evidence the agent is below threshold on at least one contract |
| 3 | INCONCLUSIVE — Hit max trials without enough evidence either way |

Inconclusive is important. It's the honest answer when you've burned your trial budget and the data is ambiguous. Treating inconclusive as a failure is statistically invalid; treating it as a pass is irresponsible. In practice, an inconclusive result means: "increase your trial budget or investigate why the agent is borderline."

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

Each contract specifies *how reliable* the behavior needs to be, not that it must always succeed. A 95% threshold with 95% confidence means: "I want statistical evidence that this agent passes at least 95% of the time, and I want to be wrong less than 5% of the time."

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
      "trialsEvaluated": 24,
      "sprtStoppedEarly": true
    }]
  }]
}
```

Over time, this gives you trend data. Is the agent's observed rate drifting down? Are you seeing more inconclusive results? Trend analysis on historical runs is more informative than any single CI check.

## The cost equation

Let's make the SPRT cost savings concrete.

Suppose you have 5 contracts, each with a max budget of 50 trials. Each trial invokes an LLM at $0.01 per call (a cheap model — Claude Haiku, GPT-4o-mini). Fixed-sample testing:

```
5 contracts × 50 trials × $0.01 = $2.50 per CI run
```

With SPRT on a clearly passing agent (true rate 96%, threshold 90%), each contract typically stops at ~20-25 trials:

```
5 contracts × 22 trials (avg) × $0.01 = $1.10 per CI run
```

**56% cost reduction.** For a clearly failing agent, SPRT stops even faster — often 5-8 trials — so you fail fast and cheap.

On a more expensive model ($0.10/call):

| Method | Trials | Cost per run | Monthly (10 runs/day) |
|--------|--------|-------------|----------------------|
| Fixed N=50 | 250 | $25.00 | $7,500 |
| SPRT (passing) | ~110 | $11.00 | $3,300 |
| SPRT (failing) | ~30 | $3.00 | $900 |

The savings compound with model cost. SPRT doesn't just give you better statistics — it gives you a smaller bill.

## Try it yourself

The code behind these ideas is available as a reference implementation:

**[github.com/your-org/cerberus](https://github.com/your-org/cerberus)** — 1,600 lines of TypeScript, 80 tests, zero magic.

```bash
# Install
npm install cerberus

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
  exits-cleanly       PASS  100.0% [CI: 89–100%]  (15 trials, early stop)
  produces-valid-json  PASS   95.0% [CI: 78–99%]   (22 trials, early stop)

Suite: PASS (2/2 contracts satisfied)
```

The implementation is deliberately minimal — 9 source files, 4 runtime dependencies — so you can read the code and understand every decision. See the [README](https://github.com/your-org/cerberus) for a file-by-file map of which concepts live where.

---

## Appendix: The math

For readers who want the precise formulations.

### SPRT (Sequential Probability Ratio Test)

For Bernoulli observations with null hypothesis p₀ and alternative p₁:

**Log-likelihood ratio update:**

$$\Lambda_n = \Lambda_{n-1} + \begin{cases} \log(p_0 / p_1) & \text{if trial passed} \\ \log((1 - p_0) / (1 - p_1)) & \text{if trial failed} \end{cases}$$

**Wald boundaries:**

$$A = \frac{1 - \beta}{\alpha}, \quad B = \frac{\beta}{1 - \alpha}$$

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
