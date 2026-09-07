import { describe, it, expect } from "vitest";
import {
  krippendorffAlpha,
  _coincidenceMatrix,
  type MeasurementLevel,
} from "../src/calibration.js";

// ── Reference matrices ───────────────────────────────────────
//
// Krippendorff's canonical worked example: 3 coders, 15 units, missing values.
// Published values: nominal α = 0.691, interval α = 0.811.
// (Krippendorff, "Computing Krippendorff's Alpha-Reliability"; also the README
// of the `krippendorff` Python package.)

const CANONICAL: readonly (readonly (number | null)[])[] = [
  [null, null, null, null, null, 3, 4, 1, 2, 1, 1, 3, 3, null, 3],
  [1, null, 2, 1, 3, 3, 4, 3, null, null, null, null, null, null, null],
  [null, null, 2, 1, 3, 4, 4, null, 2, 1, 1, 3, 3, null, 4],
];

// Published 4-rater × 12-unit example. Nominal α = 0.743.
// Unit 12 carries a single rating, so it is not a valid (pairable) unit.
const FOUR_RATER: readonly (readonly (number | null)[])[] = [
  [1, 2, 3, 3, 2, 1, 4, 1, 2, null, null, null],
  [1, 2, 3, 3, 2, 2, 4, 1, 2, 5, null, 3],
  [null, 3, 3, 3, 2, 3, 4, 2, 2, 5, 1, null],
  [1, 2, 3, 3, 2, 4, 4, 1, 2, 5, 1, null],
];

const LEVELS: readonly MeasurementLevel[] = ["nominal", "ordinal", "interval"];

// ── Published reference values ───────────────────────────────

describe("krippendorffAlpha: canonical example", () => {
  it("reproduces the published nominal α of 0.691", () => {
    const result = krippendorffAlpha(CANONICAL, "nominal");
    expect(result.defined).toBe(true);
    // Published to 3 decimals, so pinned to 3.
    expect(result.alpha).toBeCloseTo(0.691, 3);
  });

  it("reproduces the published interval α of 0.811", () => {
    const result = krippendorffAlpha(CANONICAL, "interval");
    expect(result.defined).toBe(true);
    expect(result.alpha).toBeCloseTo(0.811, 3);
  });

  it("reproduces the ordinal α cross-check pin", () => {
    // NOT a published value: this is the `krippendorff` Python package's
    // full-precision output on the canonical data, carried over from the
    // leakeval reference implementation as a cross-check on the ordinal
    // difference function (which has no published figure for this example).
    const result = krippendorffAlpha(CANONICAL, "ordinal");
    expect(result.alpha).toBeCloseTo(0.8067214199413153, 12);
  });

  it("defaults to the ordinal level", () => {
    expect(krippendorffAlpha(CANONICAL).alpha).toBeCloseTo(
      krippendorffAlpha(CANONICAL, "ordinal").alpha ?? Number.NaN,
      12,
    );
  });

  it("builds the published coincidence matrix", () => {
    // Isolates a coincidence-matrix bug from a difference-function bug: if this
    // matrix is right and α is wrong, the defect is in delta().
    //
    //         value:  1   2   3   4
    //             1 [  6,  0,  1,  0 ]  → marginal  7
    //             2 [  0,  4,  0,  0 ]  → marginal  4
    //             3 [  1,  0,  7,  2 ]  → marginal 10
    //             4 [  0,  0,  2,  3 ]  → marginal  5
    //
    // n = 26 pairable values over 12 multiply-coded units. The single 1↔3
    // off-diagonal pair comes from unit 8 (coder A = 1, coder B = 3); there is
    // no 1↔2 pair anywhere in the canonical data — every rating of 2 lands on
    // the diagonal. These marginals are what reproduce the published nominal
    // α: 1 − 25·3/243 = 0.6914.
    const { values, matrix, marginals, pairableValues, validUnits } =
      _coincidenceMatrix(CANONICAL);

    expect(values).toEqual([1, 2, 3, 4]);
    expect(matrix).toEqual([
      [6, 0, 1, 0],
      [0, 4, 0, 0],
      [1, 0, 7, 2],
      [0, 0, 2, 3],
    ]);
    expect(marginals).toEqual([7, 4, 10, 5]);
    expect(pairableValues).toBe(26);
    expect(validUnits).toBe(12);
  });

  it("reports valid units, not total columns", () => {
    const result = krippendorffAlpha(CANONICAL, "nominal");
    // 15 columns, but unit 2 is all-missing and unit 1 has a single rating.
    expect(result.validUnits).toBe(12);
    expect(result.observedValues).toBe(27);
    expect(result.pairableValues).toBe(26);
  });
});

describe("krippendorffAlpha: 4-rater example", () => {
  it("reproduces the published nominal α of 0.743", () => {
    const result = krippendorffAlpha(FOUR_RATER, "nominal");
    expect(result.alpha).toBeCloseTo(0.743, 3);
  });

  it("excludes the single-rater unit from the reported sample size", () => {
    const result = krippendorffAlpha(FOUR_RATER, "nominal");
    expect(result.observedValues).toBe(41);
    expect(result.validUnits).toBe(11); // unit 12 has one rating
    expect(result.pairableValues).toBe(40); // 41 − the unpairable rating
  });
});

// ── Numeric sort of the value set ────────────────────────────

describe("krippendorffAlpha: value ordering", () => {
  it("ranks the value set numerically, not lexicographically", () => {
    // The tripwire for the highest-probability porting bug: JavaScript's default
    // .sort() is lexicographic, so [1, 2, 10] becomes [1, 10, 2]. That leaves
    // nominal α untouched (delta is rank-independent) and interval α untouched
    // (delta reads the values, not the ranks), but it silently corrupts ordinal
    // α, whose delta sums the marginals lying *between* two ranks.
    //
    // Correct numeric ordering [1, 2, 10] → 0.43125.
    // Lexicographic ordering  [1, 10, 2] → 0.53125.
    const matrix: readonly (readonly (number | null)[])[] = [
      [1, 2, 10, 1, 2, 10, 1, 2],
      [1, 2, 10, 2, 10, 1, 1, 2],
    ];

    expect(_coincidenceMatrix(matrix).values).toEqual([1, 2, 10]);
    expect(krippendorffAlpha(matrix, "ordinal").alpha).toBeCloseTo(0.43125, 10);
  });
});

// ── Binary scales ────────────────────────────────────────────

describe("krippendorffAlpha: binary matrices", () => {
  it("gives the same α at every level on a two-valued scale", () => {
    // The production case. On two values the ordinal delta is a constant, and a
    // constant delta cancels between observed and expected disagreement — so
    // nominal, ordinal and interval must agree exactly. Catches a whole class of
    // delta-indexing bugs.
    const binary: readonly (readonly (number | null)[])[] = [
      [0, 1, 0, 1, 1, 0, 1, null, 0],
      [0, 1, 1, 1, 0, 0, 1, 0, null],
      [0, null, 0, 1, 1, 1, 1, 0, 0],
    ];

    const [nominal, ordinal, interval] = LEVELS.map(
      (level) => krippendorffAlpha(binary, level).alpha,
    );

    expect(nominal).toBeCloseTo(0.5208333333333333, 12);
    expect(ordinal).toBe(nominal);
    expect(interval).toBe(nominal);
  });
});

// ── Degenerate and boundary cases ────────────────────────────

describe("krippendorffAlpha: undefined agreement", () => {
  it("returns undefined agreement when every rating is the same value", () => {
    // NOT 1.0. Zero expected disagreement means α has no denominator: there is
    // no variation to have agreed about.
    const result = krippendorffAlpha([
      [2, 2, 2],
      [2, 2, 2],
    ]);

    expect(result.defined).toBe(false);
    expect(result.alpha).toBeUndefined();
    if (!result.defined) {
      expect(result.reason).toBe("no-expected-disagreement");
    }
    expect(result.validUnits).toBe(3);
  });

  it("returns undefined agreement when no unit is pairable", () => {
    const result = krippendorffAlpha([
      [1, null],
      [null, 2],
    ]);

    expect(result.defined).toBe(false);
    expect(result.alpha).toBeUndefined();
    if (!result.defined) {
      expect(result.reason).toBe("insufficient-pairable-values");
    }
    expect(result.validUnits).toBe(0);
    expect(result.pairableValues).toBe(0);
    expect(result.observedValues).toBe(2);
  });

  it("returns undefined agreement for an all-missing matrix", () => {
    const result = krippendorffAlpha([
      [null, null],
      [null, null],
    ]);

    expect(result.defined).toBe(false);
    if (!result.defined) {
      expect(result.reason).toBe("no-values");
    }
  });

  it("returns undefined agreement for an empty matrix", () => {
    const result = krippendorffAlpha([]);
    expect(result.defined).toBe(false);
    expect(result.validUnits).toBe(0);
  });
});

describe("krippendorffAlpha: exact boundaries", () => {
  it("returns exactly 1.0 for perfect agreement over ≥2 distinct values", () => {
    const perfect: readonly (readonly (number | null)[])[] = [
      [0, 1, 2, 3, 1],
      [0, 1, 2, 3, 1],
    ];

    for (const level of LEVELS) {
      const result = krippendorffAlpha(perfect, level);
      expect(result.defined).toBe(true);
      expect(result.alpha).toBe(1); // observed disagreement is exactly zero
    }
  });

  it("returns negative α unclamped for systematic disagreement", () => {
    // Two raters who invert each other on a binary scale. α = 1 − 7·4/16 = −0.75.
    // Clamping this to 0 would hide a judge that is worse than a coin flip.
    const inverted: readonly (readonly (number | null)[])[] = [
      [0, 1, 0, 1],
      [1, 0, 1, 0],
    ];

    for (const level of LEVELS) {
      expect(krippendorffAlpha(inverted, level).alpha).toBeCloseTo(-0.75, 12);
    }
  });
});

describe("krippendorffAlpha: input validation", () => {
  it("throws on a ragged matrix", () => {
    expect(() =>
      krippendorffAlpha([
        [1, 2],
        [1],
      ]),
    ).toThrow(/ragged/);
  });

  it("throws on a ragged matrix through the coincidence export too", () => {
    expect(() =>
      _coincidenceMatrix([
        [1, 2, 3],
        [1, 2],
      ]),
    ).toThrow(/ragged/);
  });
});
