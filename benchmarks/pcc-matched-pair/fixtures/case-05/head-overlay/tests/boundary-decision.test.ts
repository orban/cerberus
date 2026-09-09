import { describe, it, expect } from "vitest";
import { createSPRT, sprtConfigFromContract } from "../src/stats.js";

// Boundary decision thresholds derived from Wald's error-bound inequalities
// (Wald 1945, §3). With the likelihood ratio accumulating evidence for H0,
// accepting H0 once the odds reach (1-alpha)/beta and rejecting once they fall
// to alpha/(1-beta) bounds the error rates by alpha and beta. The expected
// values below were computed by hand from those odds, not from the code:
//
//   alpha 0.05, beta 0.20:  accept at ln(0.95/0.20) = ln(4.75)   =  1.558144618
//                           reject at ln(0.05/0.80) = ln(0.0625) = -2.772588722
//   alpha 0.01, beta 0.20:  accept at ln(0.99/0.20) = ln(4.95)   =  1.599387577
//                           reject at ln(0.01/0.80) = ln(0.0125) = -4.382026635

describe("SPRT boundary decision thresholds", () => {
  it("accepts H0 at the Wald acceptance odds for alpha 0.05, beta 0.20", () => {
    const config = sprtConfigFromContract(0.90, 0.95);
    const state = createSPRT(config);
    expect(state.upperBoundary).toBeCloseTo(1.558144618, 8);
    expect(state.lowerBoundary).toBeCloseTo(-2.772588722, 8);
  });

  it("rejects H0 at the Wald rejection odds for alpha 0.01, beta 0.20", () => {
    const config = sprtConfigFromContract(0.85, 0.99);
    const state = createSPRT(config);
    expect(state.upperBoundary).toBeCloseTo(1.599387577, 8);
    expect(state.lowerBoundary).toBeCloseTo(-4.382026635, 8);
  });
});
