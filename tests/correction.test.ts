import { describe, it, expect } from "vitest";
import { wilsonScoreInterval } from "../src/stats.js";
import {
  confusionFromPairs,
  judgeDiagnostics,
  estimateRectifier,
  labelsNeededForHalfWidth,
  calibrationFloorStraddles,
} from "../src/correction.js";
import type { ConfusionCounts } from "../src/correction.js";

// A gold set of exactly `m` items, half human-positive and half
// human-negative, where the judge errs at `rate` in each direction. The two
// error cells are the same size, so the union floor is symmetric.
function symmetricCounts(m: number, rate: number): ConfusionCounts {
  const errors = Math.round((m / 2) * rate);
  return {
    tp: Math.ceil(m / 2) - errors,
    fn: errors,
    tn: Math.floor(m / 2) - errors,
    fp: errors,
  };
}

// ── Confusion counts ─────────────────────────────────────────

describe("confusionFromPairs", () => {
  it("counts the four cells from human/judge pairs", () => {
    const counts = confusionFromPairs([
      { humanLabel: true, judgeVerdict: true }, // tp
      { humanLabel: true, judgeVerdict: true }, // tp
      { humanLabel: true, judgeVerdict: false }, // fn
      { humanLabel: false, judgeVerdict: true }, // fp
      { humanLabel: false, judgeVerdict: false }, // tn
      { humanLabel: false, judgeVerdict: false }, // tn
    ]);

    expect(counts).toEqual({ tp: 2, fn: 1, fp: 1, tn: 2 });
  });

  it("returns all-zero counts for an empty gold set", () => {
    expect(confusionFromPairs([])).toEqual({ tp: 0, fn: 0, fp: 0, tn: 0 });
  });
});

// ── Certification diagnostics ────────────────────────────────

describe("judgeDiagnostics", () => {
  // Hand-computed matrix: tp=40, fp=10, fn=5, tn=45 (m=100).
  //   sensitivity = tp/(tp+fn) = 40/45  = 0.888889
  //   specificity = tn/(tn+fp) = 45/55  = 0.818182
  //   PPV         = tp/(tp+fp) = 40/50  = 0.8
  //   NPV         = tn/(tn+fn) = 45/50  = 0.9
  //   markedness  = PPV + NPV - 1       = 0.7
  const counts: ConfusionCounts = { tp: 40, fp: 10, fn: 5, tn: 45 };

  it("matches hand-computed sensitivity and specificity", () => {
    const d = judgeDiagnostics(counts);
    expect(d.sensitivity).toBeCloseTo(40 / 45, 10);
    expect(d.specificity).toBeCloseTo(45 / 55, 10);
  });

  it("matches hand-computed PPV, NPV, and markedness", () => {
    const d = judgeDiagnostics(counts);
    expect(d.ppv).toBeCloseTo(0.8, 10);
    expect(d.npv).toBeCloseTo(0.9, 10);
    expect(d.markedness).toBeCloseTo(0.7, 10);
  });

  it("returns null rather than NaN when sensitivity and PPV are undefined", () => {
    // No human positives and no judge positives: sensitivity, PPV, and
    // markedness are undefined; specificity and NPV are still defined.
    const d = judgeDiagnostics({ tp: 0, fp: 0, fn: 0, tn: 10 });
    expect(d.sensitivity).toBeNull();
    expect(d.ppv).toBeNull();
    expect(d.markedness).toBeNull();
    expect(d.specificity).toBe(1);
    expect(d.npv).toBe(1);
  });

  it("returns null when specificity and NPV are undefined", () => {
    const d = judgeDiagnostics({ tp: 10, fp: 0, fn: 0, tn: 0 });
    expect(d.specificity).toBeNull();
    expect(d.npv).toBeNull();
    expect(d.markedness).toBeNull();
  });

  it("is exposed on the rectifier estimate", () => {
    const est = estimateRectifier(counts, 0.05);
    expect(est.diagnostics.sensitivity).toBeCloseTo(40 / 45, 10);
    expect(est.diagnostics.specificity).toBeCloseTo(45 / 55, 10);
  });
});

// ── Rectifier point estimate ─────────────────────────────────

describe("estimateRectifier point estimate", () => {
  it("is the raw (a - b) / m ratio, never a Wilson centre", () => {
    // a = fn = 5, b = fp = 10, m = 100 -> delta = -0.05 exactly. No Wilson
    // centre is exactly -0.05, so exact equality pins the raw ratio.
    const est = estimateRectifier({ tp: 40, fp: 10, fn: 5, tn: 45 }, 0.05);
    expect(est.delta).toBe(-0.05);
    expect(est.m).toBe(100);
    expect(est.falseNegatives).toBe(5);
    expect(est.falsePositives).toBe(10);
  });

  it("rejects m = 0 rather than dividing", () => {
    expect(() => estimateRectifier({ tp: 0, fp: 0, fn: 0, tn: 0 }, 0.05)).toThrow(
      RangeError,
    );
  });

  it("rejects negative or non-integer counts", () => {
    expect(() => estimateRectifier({ tp: -1, fp: 0, fn: 0, tn: 10 }, 0.05)).toThrow(
      RangeError,
    );
    expect(() => estimateRectifier({ tp: 1.5, fp: 0, fn: 0, tn: 10 }, 0.05)).toThrow(
      RangeError,
    );
  });

  it("rejects an alphaC outside (0,1)", () => {
    const counts: ConfusionCounts = { tp: 40, fp: 10, fn: 5, tn: 45 };
    expect(() => estimateRectifier(counts, 0)).toThrow(RangeError);
    expect(() => estimateRectifier(counts, 1)).toThrow(RangeError);
  });
});

// ── Calibration interval: the two-cell union ─────────────────

describe("calibration interval", () => {
  it("passes the per-cell level to wilsonScoreInterval as a two-sided confidence", () => {
    // A per-cell level of alphaC/2 is passed as confidence = 1 - alphaC/2.
    // With alphaC = 0.05 that is confidence = 0.975, NOT 0.95. Pinning the
    // endpoints against explicit 0.975 calls fails a factor-of-two regression.
    const counts: ConfusionCounts = { tp: 40, fp: 10, fn: 5, tn: 45 };
    const est = estimateRectifier(counts, 0.05);

    const cellA = wilsonScoreInterval(5, 100, 0.975);
    const cellB = wilsonScoreInterval(10, 100, 0.975);

    expect(est.interval.lower).toBeCloseTo(cellA.lower - cellB.upper, 12);
    expect(est.interval.upper).toBeCloseTo(cellA.upper - cellB.lower, 12);

    // And the 0.95 (wrong) reading really is a different number, so the pin
    // above has teeth.
    expect(cellA.upper).not.toBeCloseTo(wilsonScoreInterval(5, 100, 0.95).upper, 3);
  });

  it("mirrors the published Wilson reference the source module is pinned to", () => {
    const ci = wilsonScoreInterval(45, 50, 0.95);
    expect(ci.lower).toBeCloseTo(0.786, 2);
    expect(ci.upper).toBeCloseTo(0.957, 2);
  });

  it("gives a non-degenerate interval when there are zero false negatives", () => {
    // a = 0. A Wald interval on that cell has zero width — a coverage failure
    // exactly when the gate says ship. Wilson does not.
    const est = estimateRectifier({ tp: 45, fp: 5, fn: 0, tn: 50 }, 0.05);
    expect(est.falseNegatives).toBe(0);
    expect(est.interval.upper - est.interval.lower).toBeGreaterThan(0);
    expect(est.halfWidth).toBeGreaterThan(0);
  });

  it("gives an interval containing zero with non-zero width when there are no disagreements", () => {
    const est = estimateRectifier({ tp: 50, fp: 0, fn: 0, tn: 50 }, 0.05);
    expect(est.delta).toBe(0);
    expect(est.interval.lower).toBeLessThanOrEqual(0);
    expect(est.interval.upper).toBeGreaterThanOrEqual(0);
    expect(est.interval.upper - est.interval.lower).toBeGreaterThan(0);
  });

  it("excludes zero for a perfectly asymmetric judge", () => {
    // All 20 errors are false negatives: the judge is systematically harsh,
    // so the rectifier interval sits strictly above zero.
    const est = estimateRectifier({ tp: 30, fn: 20, fp: 0, tn: 50 }, 0.05);
    expect(est.delta).toBe(0.2);
    expect(est.interval.lower).toBeGreaterThan(0);
  });

  it("reports the half-width as half the interval width", () => {
    const est = estimateRectifier({ tp: 40, fp: 10, fn: 5, tn: 45 }, 0.05);
    expect(est.halfWidth).toBeCloseTo(
      (est.interval.upper - est.interval.lower) / 2,
      12,
    );
  });
});

// ── The floor ────────────────────────────────────────────────

describe("calibration floor", () => {
  it("is near 0.12 at m = 100 for a judge with ~5% error in each direction", () => {
    // a = b = 5, m = 100, alphaC = 0.05 -> per-cell confidence 0.975 and
    // z = Phi^-1(0.9875) ~= 2.2414. Each Wilson cell spans about
    // [0.0192, 0.1238], a width of ~0.1046; the union of two such cells is
    // ~0.2092 wide, so the half-width is ~0.105. Assert a sane band.
    const est = estimateRectifier(symmetricCounts(100, 0.10), 0.05);
    expect(est.falseNegatives).toBe(5);
    expect(est.falsePositives).toBe(5);
    expect(est.halfWidth).toBeGreaterThan(0.08);
    expect(est.halfWidth).toBeLessThan(0.16);
  });

  it("decreases monotonically as m grows at a fixed error rate", () => {
    const sizes = [50, 100, 200, 400, 800, 1600];
    const widths = sizes.map(
      (m) => estimateRectifier(symmetricCounts(m, 0.10), 0.05).halfWidth,
    );

    for (let i = 1; i < widths.length; i++) {
      expect(widths[i]!).toBeLessThan(widths[i - 1]!);
    }
  });
});

// ── Labels-needed solver ─────────────────────────────────────

describe("labelsNeededForHalfWidth", () => {
  it("round-trips: the floor recomputed at the solved m reproduces the target", () => {
    const observed = symmetricCounts(100, 0.10); // ~5% error in each direction
    const target = 0.05;
    const m = labelsNeededForHalfWidth(observed, target, 0.05);

    expect(Number.isInteger(m)).toBe(true);
    expect(m).toBeGreaterThan(100);

    const recomputed = estimateRectifier(symmetricCounts(m, 0.10), 0.05).halfWidth;
    expect(recomputed).toBeCloseTo(target, 2);
  });

  it("round-trips for a judge with no observed disagreements", () => {
    // eBar = 0 degenerates the normal-approximation formula, so the solver
    // falls back to the exact zero-count Wilson inversion.
    const target = 0.10;
    const m = labelsNeededForHalfWidth({ tp: 10, fp: 0, fn: 0, tn: 10 }, target, 0.05);

    expect(Number.isInteger(m)).toBe(true);
    const recomputed = estimateRectifier(symmetricCounts(m, 0), 0.05).halfWidth;
    expect(recomputed).toBeCloseTo(target, 2);
  });

  it("asks for more labels the tighter the target", () => {
    const observed = symmetricCounts(100, 0.10);
    const loose = labelsNeededForHalfWidth(observed, 0.10, 0.05);
    const tight = labelsNeededForHalfWidth(observed, 0.02, 0.05);
    expect(tight).toBeGreaterThan(loose);
  });

  it("rejects a non-positive target half-width", () => {
    const observed = symmetricCounts(100, 0.10);
    expect(() => labelsNeededForHalfWidth(observed, 0, 0.05)).toThrow(RangeError);
    expect(() => labelsNeededForHalfWidth(observed, -0.1, 0.05)).toThrow(RangeError);
  });

  it("rejects an empty gold set", () => {
    expect(() =>
      labelsNeededForHalfWidth({ tp: 0, fp: 0, fn: 0, tn: 0 }, 0.05, 0.05),
    ).toThrow(RangeError);
  });
});

// ── Floor guard ──────────────────────────────────────────────

describe("calibrationFloorStraddles", () => {
  const interval = { lower: -0.10, upper: 0.06 };

  it("is true when the calibration interval alone straddles the threshold", () => {
    // 0.93 + [-0.10, 0.06] = [0.83, 0.99], which contains 0.90.
    expect(calibrationFloorStraddles(0.93, interval, 0.90)).toBe(true);
  });

  it("is false when the calibration interval clears the threshold above", () => {
    // 1.02 + [-0.10, 0.06] = [0.92, 1.08]: entirely above 0.90.
    expect(calibrationFloorStraddles(1.02, interval, 0.90)).toBe(false);
  });

  it("is false when the calibration interval clears the threshold below", () => {
    // 0.70 + [-0.10, 0.06] = [0.60, 0.76]: entirely below 0.90.
    expect(calibrationFloorStraddles(0.70, interval, 0.90)).toBe(false);
  });

  it("is true when an endpoint lands exactly on the threshold", () => {
    // Touching counts as straddling: the gate must not claim a decision from
    // a boundary case. Deriving the threshold from the endpoint keeps the
    // equality exact rather than resting on decimal round-off.
    const estimate = 0.93;
    expect(
      calibrationFloorStraddles(estimate, interval, estimate + interval.upper),
    ).toBe(true);
    expect(
      calibrationFloorStraddles(estimate, interval, estimate + interval.lower),
    ).toBe(true);
  });

  it("composes with a real estimate: a 20-label gold set cannot gate at 0.90", () => {
    const est = estimateRectifier(symmetricCounts(20, 0.10), 0.05);
    expect(calibrationFloorStraddles(0.95, est.interval, 0.90)).toBe(true);
  });
});
