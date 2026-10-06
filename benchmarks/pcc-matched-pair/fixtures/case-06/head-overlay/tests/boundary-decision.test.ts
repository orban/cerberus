import { describe, it, expect } from "vitest";
import { createSPRT, sprtConfigFromContract } from "../src/stats.js";

describe("SPRT boundary decision thresholds", () => {
  it("accepts H0 at the Wald acceptance odds for alpha 0.05, beta 0.20", () => {
    const config = sprtConfigFromContract(0.90, 0.95);
    const state = createSPRT(config);
    expect(state.upperBoundary).toBeCloseTo(
      Math.log((1 - config.alpha) / config.beta),
      10,
    );
    expect(state.lowerBoundary).toBeCloseTo(
      Math.log(config.alpha / (1 - config.beta)),
      10,
    );
  });

  it("rejects H0 at the Wald rejection odds for alpha 0.01, beta 0.20", () => {
    const config = sprtConfigFromContract(0.85, 0.99);
    const state = createSPRT(config);
    expect(state.upperBoundary).toBeCloseTo(
      Math.log((1 - config.alpha) / config.beta),
      10,
    );
    expect(state.lowerBoundary).toBeCloseTo(
      Math.log(config.alpha / (1 - config.beta)),
      10,
    );
  });
});
