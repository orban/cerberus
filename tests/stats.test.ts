import { describe, it, expect } from "vitest";
import {
  sprtConfigFromContract,
  createSPRT,
  updateSPRT,
  wilsonScoreInterval,
  _inverseNormalCDF,
} from "../src/stats.js";

// ── inverseNormalCDF ─────────────────────────────────────────

describe("inverseNormalCDF", () => {
  it("returns ~0 for p=0.5", () => {
    expect(_inverseNormalCDF(0.5)).toBeCloseTo(0, 4);
  });

  it("returns ~1.96 for p=0.975 (95% CI)", () => {
    expect(_inverseNormalCDF(0.975)).toBeCloseTo(1.96, 2);
  });

  it("returns ~2.576 for p=0.995 (99% CI)", () => {
    expect(_inverseNormalCDF(0.995)).toBeCloseTo(2.576, 2);
  });

  it("is symmetric: f(p) = -f(1-p)", () => {
    expect(_inverseNormalCDF(0.025)).toBeCloseTo(-_inverseNormalCDF(0.975), 4);
  });

  it("throws for p=0 or p=1", () => {
    expect(() => _inverseNormalCDF(0)).toThrow();
    expect(() => _inverseNormalCDF(1)).toThrow();
  });
});

// ── SPRT config mapping ─────────────────────────────────────

describe("sprtConfigFromContract", () => {
  it("maps threshold=0.90, confidence=0.95 correctly", () => {
    const config = sprtConfigFromContract(0.90, 0.95);
    expect(config.p0).toBe(0.90);
    expect(config.p1).toBe(0.80);
    expect(config.alpha).toBeCloseTo(0.05);
    expect(config.beta).toBe(0.20);
  });

  it("floors p1 at 0.01 for low thresholds", () => {
    const config = sprtConfigFromContract(0.11, 0.95);
    expect(config.p1).toBe(0.01);
  });

  it("handles high confidence (0.99)", () => {
    const config = sprtConfigFromContract(0.95, 0.99);
    expect(config.alpha).toBeCloseTo(0.01);
    expect(config.p0).toBe(0.95);
    expect(config.p1).toBe(0.85);
  });
});

// ── SPRT convergence ─────────────────────────────────────────

describe("SPRT", () => {
  it("accepts quickly with 100% pass rate", () => {
    const config = sprtConfigFromContract(0.90, 0.95);
    let state = createSPRT(config);

    for (let i = 0; i < 100 && state.decision === "continue"; i++) {
      state = updateSPRT(state, config, true);
    }

    expect(state.decision).toBe("accept");
    expect(state.observations).toBeLessThan(30); // should stop well before 100
  });

  it("rejects quickly with 0% pass rate", () => {
    const config = sprtConfigFromContract(0.90, 0.95);
    let state = createSPRT(config);

    for (let i = 0; i < 100 && state.decision === "continue"; i++) {
      state = updateSPRT(state, config, false);
    }

    expect(state.decision).toBe("reject");
    expect(state.observations).toBeLessThan(10); // very clear rejection
  });

  it("continues longer with borderline pass rate", () => {
    const config = sprtConfigFromContract(0.90, 0.95);
    let state = createSPRT(config);
    let observations = 0;

    // Deterministic 85% pass rate (17 pass, 3 fail, repeating)
    // Sits between p0=0.90 and p1=0.80, so SPRT should take many observations
    for (let i = 0; i < 200 && state.decision === "continue"; i++) {
      const success = i % 20 < 17; // 17/20 = 0.85
      state = updateSPRT(state, config, success);
      observations++;
    }

    // Borderline cases take more observations than clear ones
    expect(observations).toBeGreaterThan(10);
  });

  it("does not update after decision is made", () => {
    const config = sprtConfigFromContract(0.90, 0.95);
    let state = createSPRT(config);

    // Force acceptance
    for (let i = 0; i < 100 && state.decision === "continue"; i++) {
      state = updateSPRT(state, config, true);
    }
    expect(state.decision).toBe("accept");
    const obsAtDecision = state.observations;

    // Further updates should be no-ops
    state = updateSPRT(state, config, false);
    expect(state.observations).toBe(obsAtDecision);
  });

  it("boundaries are correctly calculated from alpha/beta", () => {
    const config = sprtConfigFromContract(0.90, 0.95);
    const state = createSPRT(config);

    const A = (1 - config.alpha) / config.beta;
    const B = config.alpha / (1 - config.beta);

    expect(state.upperBoundary).toBeCloseTo(Math.log(A), 10);
    expect(state.lowerBoundary).toBeCloseTo(Math.log(B), 10);
    expect(state.upperBoundary).toBeGreaterThan(0);
    expect(state.lowerBoundary).toBeLessThan(0);
  });
});

// ── Wilson Score CI ──────────────────────────────────────────

describe("wilsonScoreInterval", () => {
  it("computes correct CI for 45/50 at 95% confidence", () => {
    const ci = wilsonScoreInterval(45, 50, 0.95);
    // Wilson score for 45/50 at 95%: lower ≈ 0.786, upper ≈ 0.957
    expect(ci.lower).toBeCloseTo(0.786, 2);
    expect(ci.upper).toBeCloseTo(0.957, 2);
    expect(ci.center).toBeGreaterThan(ci.lower);
    expect(ci.center).toBeLessThan(ci.upper);
    expect(ci.n).toBe(50);
  });

  it("handles 0/n (all failures)", () => {
    const ci = wilsonScoreInterval(0, 20, 0.95);
    expect(ci.lower).toBe(0);
    expect(ci.upper).toBeGreaterThan(0);
    expect(ci.upper).toBeLessThan(0.2); // shouldn't be too wide
  });

  it("handles n/n (all successes)", () => {
    const ci = wilsonScoreInterval(20, 20, 0.95);
    expect(ci.upper).toBe(1);
    expect(ci.lower).toBeGreaterThan(0.8);
  });

  it("handles n=0 (no trials)", () => {
    const ci = wilsonScoreInterval(0, 0, 0.95);
    expect(ci.lower).toBe(0);
    expect(ci.upper).toBe(1);
    expect(ci.n).toBe(0);
  });

  it("wider CI at higher confidence", () => {
    const ci95 = wilsonScoreInterval(45, 50, 0.95);
    const ci99 = wilsonScoreInterval(45, 50, 0.99);
    expect(ci99.upper - ci99.lower).toBeGreaterThan(ci95.upper - ci95.lower);
  });

  it("narrower CI with more observations", () => {
    const ci50 = wilsonScoreInterval(45, 50, 0.95);
    const ci200 = wilsonScoreInterval(180, 200, 0.95);
    expect(ci200.upper - ci200.lower).toBeLessThan(ci50.upper - ci50.lower);
  });
});
