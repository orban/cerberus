import { describe, it, expect } from "vitest";
import { sprtConfigFromContract, createSPRT, updateSPRT } from "../src/stats.js";

// Behavioral verification of the SPRT decision boundaries, derived from
// Wald (1945) rather than from the implementation.
//
// The accumulator adds log(p0/p1) per success, so the statistic is
// Λ = P(data|H0)/P(data|H1) and evidence for H0 accumulates upward.
// Wald's boundaries in the standard convention LR* = P(data|H1)/P(data|H0)
// are A* = (1-β)/α (accept H1) and B* = β/(1-α) (accept H0). With Λ = 1/LR*:
//
//   accept H0 (agent meets threshold)  ⇔  Λ ≥ (1-α)/β
//   reject H0 (agent degraded)         ⇔  Λ ≤ α/(1-β)
//
// The counts below follow from those inequalities alone:
//   successes to accept  = ceil( log((1-α)/β) / log(p0/p1) )
//   failures  to reject  = ceil( |log(α/(1-β))| / |log((1-p0)/(1-p1))| )
//
// For threshold 0.90 (p0=.90, p1=.80) and confidence 0.95 (α=.05, β=.20):
//   accept: ceil(1.5581 / 0.11778) = 14      reject: ceil(2.7726 / 0.69315) = 4
// For confidence 0.99 (α=.01, β=.20):
//   accept: ceil(1.5994 / 0.11778) = 14      reject: ceil(4.3820 / 0.69315) = 7

function runStreak(threshold: number, confidence: number, outcome: boolean, max = 100) {
  const config = sprtConfigFromContract(threshold, confidence);
  let state = createSPRT(config);
  for (let i = 0; i < max && state.decision === "continue"; i++) {
    state = updateSPRT(state, config, outcome);
  }
  return state;
}

describe("SPRT error control (derived from Wald's inequalities)", () => {
  it("accepts after exactly 14 consecutive successes at threshold .90, confidence .95", () => {
    const state = runStreak(0.90, 0.95, true);
    expect(state.decision).toBe("accept");
    expect(state.observations).toBe(14);
  });

  it("rejects after exactly 4 consecutive failures at threshold .90, confidence .95", () => {
    const state = runStreak(0.90, 0.95, false);
    expect(state.decision).toBe("reject");
    expect(state.observations).toBe(4);
  });

  it("asymmetric alpha/beta: confidence .99 keeps accept at 14 but hardens reject to 7", () => {
    // α shrinks 5x while β stays at .20 — only the REJECT boundary moves.
    // A swapped-formula implementation moves the accept boundary instead.
    const accept = runStreak(0.90, 0.99, true);
    expect(accept.decision).toBe("accept");
    expect(accept.observations).toBe(14);

    const reject = runStreak(0.90, 0.99, false);
    expect(reject.decision).toBe("reject");
    expect(reject.observations).toBe(7);
  });
});

// Fixed-seed Monte Carlo: empirical error rates against the advertised α/β.
// mulberry32 is deterministic, so this is reproducible evidence, not flake.

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function empiricalRates(pTrue: number, reps: number, seed: number) {
  const rng = mulberry32(seed);
  const config = sprtConfigFromContract(0.90, 0.95);
  let accept = 0;
  let reject = 0;
  for (let r = 0; r < reps; r++) {
    let state = createSPRT(config);
    for (let i = 0; i < 400 && state.decision === "continue"; i++) {
      state = updateSPRT(state, config, rng() < pTrue);
    }
    if (state.decision === "accept") accept++;
    if (state.decision === "reject") reject++;
  }
  return { acceptRate: accept / reps, rejectRate: reject / reps };
}

describe("SPRT empirical error rates (fixed-seed Monte Carlo, 4000 runs)", () => {
  it("Type I: rejects a genuinely good agent (p = p0 = .90) at no more than alpha + margin", () => {
    const { rejectRate } = empiricalRates(0.90, 4000, 12345);
    // advertised alpha = 0.05; allow 3 sigma of sampling noise
    expect(rejectRate).toBeLessThan(0.08);
  });

  it("Type II: accepts a degraded agent (p = p1 = .80) at no more than beta + margin", () => {
    const { acceptRate } = empiricalRates(0.80, 4000, 54321);
    // advertised beta = 0.20; allow 3 sigma of sampling noise
    expect(acceptRate).toBeLessThan(0.23);
  });
});
