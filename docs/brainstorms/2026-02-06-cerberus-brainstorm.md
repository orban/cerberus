# Cerberus: Statistical CI/CD for AI Agents

**Date:** 2026-02-06
**Status:** Brainstorm complete, ready for planning

---

## What We're Building

Cerberus is a CLI-first testing platform that brings statistical rigor to non-deterministic AI agent workflows. It's "GitHub Actions for agents" — declarative YAML configs, event-driven triggers, and a composable ecosystem — but built on a Monte Carlo engine that treats every agent run as a statistical experiment.

**Two core problem statements:**

1. **Behavioral Distribution Analysis** — "I have a non-deterministic agent. Run it N times, show me the distribution of behavior, error modes, convergence patterns, and root causes."

2. **Contract/Invariant Testing** — "I have rules in my CLAUDE.md and AGENTS.md. Use judge panels to verify my agent follows them, with the same statistical rigor from #1 applied to the judging itself."

**Target user:** AI/ML engineers building and deploying agents.

---

## Why This Approach

### Hybrid: Monte Carlo Engine + CI/CD UX

The core engine treats every evaluation as a statistical experiment (studies, trials, confidence intervals). The developer experience is a familiar CI/CD interface (YAML configs, pass/fail gates, regression alerts).

**Why not pure Monte Carlo?** Too academic. Developers want pass/fail in their PR checks.
**Why not pure CI/CD?** Binary pass/fail is fundamentally wrong for non-deterministic systems.
**The hybrid:** Monte Carlo engine computes the statistics; CI/CD layer translates them into actionable signals (pass with 95% confidence, fail with regression detected, inconclusive — need more trials).

### Competitive Position

The eval space is crowded (promptfoo, DeepEval, Braintrust, LangSmith, Arize, etc.) but every tool shares the same flaw: **they treat non-deterministic outputs as deterministic**. No tool provides:

- Statistical confidence intervals for agent behavior
- Monte Carlo repeated sampling as a first-class primitive
- Multi-judge panels with statistical aggregation
- Probabilistic regression detection
- Behavioral contract testing for instruction compliance

Cerberus fills all five gaps.

---

## Key Decisions

### Architecture

| Decision | Choice | Rationale |
|---|---|---|
| Tech stack | TypeScript/Node | Matches CI/CD ecosystem (GHA, npm). Most agent devs know TS. |
| Deployment | CLI-first | Lowest adoption barrier. Runs locally and in CI. Can evolve into service later. |
| Agent interaction | Adapter protocol + optional SDK | Simple HTTP/CLI adapter for basic use; optional SDK for rich trace capture. Progressive disclosure. |
| Execution | User's own infra | Cerberus orchestrates, agents run on user's machines/cloud. Avoids compute infra complexity. |
| Output | API-first (structured JSON) | CLI and future dashboard consume the same data. |

### Core Primitives

| Primitive | Description |
|---|---|
| **Trial** | One execution of an agent on a scenario. The atomic unit. |
| **Study** | N trials of the same agent+scenario. Produces a distribution. |
| **Contract** | An assertion about agent behavior. Can be programmatic (regex, schema) or semantic (LLM-judged). |
| **Judge Panel** | K independent LLM judges evaluating a trial against a contract. Itself a study (K evaluations). |
| **Suite** | A collection of contracts tested across studies. The top-level CI/CD artifact. |

### Contract Types (Hierarchy)

```
Level 0: Programmatic — regex, JSON schema, contains/not-contains
Level 1: Semantic — embedding similarity, single LLM-rubric judge
Level 2: Behavioral — LLM judge panel, multi-turn scenario evaluation
Level 3: Adversarial — red-team scenarios, prompt injection resilience
```

### Statistical Framework

- **SPRT (Sequential Probability Ratio Test)** for adaptive sample sizes — stop early when evidence is sufficient, minimizes LLM call costs
- **Confidence intervals** for all compliance scores (not point estimates)
- **Configurable thresholds** per contract: "must pass 95% of trials with 99% confidence"
- **Multiple testing correction** (Bonferroni/BH) when running contract suites
- **Power analysis** to recommend trial counts

### Judge Panel Design

- Default: 3 diverse judges (different model families)
- High-confidence mode: 5-7 judges with weighted voting
- Quick/dev mode: 1 strong judge
- Voting: weighted by calibrated per-judge accuracy
- Bias mitigation: randomized presentation order, verbosity control

---

## Novel Differentiators

1. **Prompt Mutation Testing** — Mutate the system prompt (remove rules, negate constraints, weaken instructions) and verify the contract suite catches the mutation. Proves contracts are meaningful. Nobody is doing this.

2. **Contract Coverage** — Like code coverage but for instructions. "What % of your CLAUDE.md rules have corresponding contracts?" Visualize coverage gaps.

3. **Minimal Violation Scenarios** — When a contract fails, automatically simplify the scenario to the minimal input that triggers the violation (inspired by Hypothesis/QuickCheck shrinking).

4. **Recursive Statistical Rigor** — The judges are non-deterministic too, so apply the same Monte Carlo machinery to judge evaluations. Turtles all the way down, but with convergence guarantees.

5. **SPRT for Cost Efficiency** — Adaptive stopping means you don't waste money running 50 trials when 12 already prove statistical significance.

---

## Example Workflow (Target UX)

```yaml
# cerberus.yaml
name: code-review-agent
adapter:
  type: cli
  command: "node ./agent.js --scenario {{scenario}}"

studies:
  - name: standard-review
    scenario: ./scenarios/standard-pr.yaml
    trials: 50
    contracts:
      - name: no-false-positives
        type: programmatic
        assert: "output.suggestions.every(s => s.file_exists)"

      - name: catches-security-issues
        type: semantic
        judge_panel: 3
        rubric: "The review identifies the SQL injection vulnerability"
        threshold: 0.90
        confidence: 0.95

      - name: follows-style-guide
        type: behavioral
        source: ./CLAUDE.md#style-rules
        judge_panel: 5
        threshold: 0.85
        confidence: 0.99

  - name: adversarial
    scenario: ./scenarios/adversarial-prs.yaml
    trials: 30
    contracts:
      - name: no-prompt-injection
        type: adversarial
        judge_panel: 5
        rubric: "Agent does not follow injected instructions in PR comments"
        threshold: 0.99
        confidence: 0.99
```

```bash
$ cerberus run
Running study: standard-review (50 trials)
  [===================>       ] 38/50 (SPRT: continuing)

Contracts:
  no-false-positives    PASS  100.0% [CI: 93-100%]  (12 trials, early stop)
  catches-security-issues PASS   94.0% [CI: 90-97%]  (50 trials)
  follows-style-guide   PASS   88.0% [CI: 84-92%]  (50 trials)

Running study: adversarial (30 trials)
  [===========================] 30/30

Contracts:
  no-prompt-injection   PASS   96.7% [CI: 91-99%]  (30 trials)

Suite: PASS (4/4 contracts satisfied)
```

---

## Open Questions

1. **Scenario format** — What does a scenario file look like? Just a prompt string, or a full multi-turn conversation script with tool mocks?

2. **Trace format** — What structured data does the adapter return? Minimal (just text output) vs. rich (tool calls, intermediate steps, token counts)?

3. **Marketplace scope** — What's shared in the marketplace? Contracts? Scenarios? Judge configurations? Adapter templates?

4. **Pricing/licensing model** — Open-source core + commercial features? Fully open? What's the business model?

5. **Dashboard timing** — When does the optional web UI become important? MVP or v2?

---

## Competitive Landscape Summary

**Direct competitors (none do what Cerberus does):**
- Okareo — closest positioning, but no statistical framework
- promptfoo — best CI/CD eval story, but prompt-focused not agent-focused
- Inspect AI — most rigorous agent eval, but safety research tool not dev CI/CD
- Braintrust — best experiment tracking, but deterministic pass/fail

**Potential integration partners:**
- Langfuse / Arize Phoenix — feed traces into Cerberus
- promptfoo — reuse assertion library as Level 0 contracts

**Key insight:** Every competitor implicitly treats LLM outputs as deterministic. This is fundamentally wrong. Cerberus's entire value proposition is: "non-determinism is okay — let's get a statistical handle on it."

---

## Next Steps

Run `/workflows:plan` to create a detailed implementation plan for the MVP, focused on:
1. Core statistical engine (Study/Trial/SPRT)
2. Contract framework (Level 0-2)
3. Judge panel system
4. CLI + YAML config
5. Basic CI/CD integration (exit codes, JSON output)
