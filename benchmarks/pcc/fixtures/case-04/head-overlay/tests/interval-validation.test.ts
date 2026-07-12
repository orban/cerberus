import { describe, it, expect } from "vitest";
import { wilsonScoreInterval } from "../src/stats.js";

// Validation behavior plus hand-computed reference intervals.
// Reference values computed directly from the Wilson score formula
// (center ± spread with z = 1.959964 at 95%, z = 2.575829 at 99%),
// independent of the implementation.

describe("wilsonScoreInterval input validation", () => {
  it("throws on negative n", () => {
    expect(() => wilsonScoreInterval(0, -1, 0.95)).toThrow(RangeError);
  });

  it("throws on negative successes", () => {
    expect(() => wilsonScoreInterval(-3, 10, 0.95)).toThrow(RangeError);
  });

  it("throws when successes exceed n", () => {
    expect(() => wilsonScoreInterval(11, 10, 0.95)).toThrow(RangeError);
  });

  it("throws on non-integer counts", () => {
    expect(() => wilsonScoreInterval(4.5, 10, 0.95)).toThrow(RangeError);
    expect(() => wilsonScoreInterval(4, 10.2, 0.95)).toThrow(RangeError);
  });

  it("throws on confidence outside (0,1)", () => {
    expect(() => wilsonScoreInterval(5, 10, 0)).toThrow(RangeError);
    expect(() => wilsonScoreInterval(5, 10, 1)).toThrow(RangeError);
    expect(() => wilsonScoreInterval(5, 10, 1.2)).toThrow(RangeError);
  });
});

describe("wilsonScoreInterval reference values", () => {
  it("8/10 at 95%: [0.4902, 0.9433] (hand-computed)", () => {
    const ci = wilsonScoreInterval(8, 10, 0.95);
    expect(ci.lower).toBeCloseTo(0.4902, 3);
    expect(ci.upper).toBeCloseTo(0.9433, 3);
  });

  it("90/100 at 99%: [0.7962, 0.9540] (hand-computed)", () => {
    const ci = wilsonScoreInterval(90, 100, 0.99);
    expect(ci.lower).toBeCloseTo(0.7962, 3);
    expect(ci.upper).toBeCloseTo(0.9540, 3);
  });

  it("valid inputs still return clamped bounds", () => {
    const ci = wilsonScoreInterval(20, 20, 0.95);
    expect(ci.upper).toBe(1);
    expect(ci.lower).toBeGreaterThan(0.8);
  });
});
