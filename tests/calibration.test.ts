import { describe, it, expect } from "vitest";
import {
  krippendorffAlpha,
  certifyJudge,
  goldSetAgreement,
  CERTIFICATION_PASS_ALPHA,
  CERTIFICATION_MARGINAL_ALPHA,
  _coincidenceMatrix,
  type MeasurementLevel,
} from "../src/calibration.js";
import {
  confusionFromPairs,
  estimateRectifier,
  labelsNeededForHalfWidth,
  type GoldLabelledVerdict,
} from "../src/correction.js";
import { MINIMUM_GOLD_SET_SIZE } from "../src/config.js";
import type {
  GoldSet,
  GoldSetEntry,
  GoldSetLoadResult,
  GoldSetMarkingReason,
} from "../src/types.js";

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

// ── Certification verdict and floor guard (U5) ───────────────
//
// KTD5 puts the bands directly on judge-vs-human α. Every gold set below is
// built from a 2x2 shape so its α is known in closed form: with one human
// label and one judge verdict per unit, nominal α over n units is
// `1 - (2n - 1) * d / (n0 * n1)`, where `d` counts disagreements and `n0`/`n1`
// are the fail/pass marginals of the coincidence matrix. Each band test pins
// the α it lands on as well as the verdict, so a band moving and the statistic
// moving cannot be confused.

interface GoldSetShape {
  /** Human says pass, judge says pass. */
  readonly bothPass: number;
  /** Human says fail, judge says fail. */
  readonly bothFail: number;
  /** Human says pass, judge says fail. */
  readonly falseNegatives: number;
  /** Human says fail, judge says pass. */
  readonly falsePositives: number;
}

interface BuiltGoldSet {
  readonly goldSet: GoldSet;
  readonly load: GoldSetLoadResult;
  readonly judgeVerdicts: ReadonlyMap<string, boolean>;
  readonly pairs: readonly GoldLabelledVerdict[];
}

const PROVENANCE = "random-sample-of-trial-population";

function buildGoldSet(shape: GoldSetShape): BuiltGoldSet {
  const entries: GoldSetEntry[] = [];
  const judgeVerdicts = new Map<string, boolean>();
  const pairs: GoldLabelledVerdict[] = [];

  const add = (humanLabel: boolean, judgeVerdict: boolean): void => {
    const scenario = `scenario-${entries.length}`;
    entries.push({ scenario, label: humanLabel ? "pass" : "fail" });
    judgeVerdicts.set(scenario, judgeVerdict);
    pairs.push({ humanLabel, judgeVerdict });
  };

  for (let i = 0; i < shape.bothPass; i++) add(true, true);
  for (let i = 0; i < shape.bothFail; i++) add(false, false);
  for (let i = 0; i < shape.falseNegatives; i++) add(true, false);
  for (let i = 0; i < shape.falsePositives; i++) add(false, true);

  const goldSet: GoldSet = { provenance: PROVENANCE, entries };
  return { goldSet, load: { marked: false, goldSet }, judgeVerdicts, pairs };
}

function mark(built: BuiltGoldSet, reason: GoldSetMarkingReason): GoldSetLoadResult {
  return { marked: true, reason, message: `marked as ${reason}`, goldSet: built.goldSet };
}

// A threshold far outside any calibration band these gold sets produce, so the
// floor guard stays silent and a test can isolate the α verdict.
const NO_STRADDLE_THRESHOLD = 0.999;
const ALPHA_C = 0.05;

function certify(
  built: BuiltGoldSet,
  overrides: {
    load?: GoldSetLoadResult;
    threshold?: number;
    judgedRate?: number;
  } = {},
) {
  return certifyJudge({
    goldSet: overrides.load ?? built.load,
    judgeVerdicts: built.judgeVerdicts,
    threshold: overrides.threshold ?? NO_STRADDLE_THRESHOLD,
    alphaC: ALPHA_C,
    ...(overrides.judgedRate === undefined ? {} : { judgedRate: overrides.judgedRate }),
  });
}

describe("certifyJudge: verdict bands", () => {
  it("certifies a high-agreement judge as pass", () => {
    // d = 4 over n = 100, marginals 100/100: α = 1 − 199·4/10000 = 0.9204.
    const built = buildGoldSet({
      bothPass: 48,
      bothFail: 48,
      falseNegatives: 2,
      falsePositives: 2,
    });
    const result = certify(built);

    expect(result.agreement.alpha).toBeCloseTo(0.9204, 10);
    expect(result.verdict).toBe("pass");
    expect(result.gatingEligible).toBe(true);
    expect(result.ineligibilityReasons).toEqual([]);
    expect(result.goldSetSize).toBe(100);
  });

  it("covers AE5: a marginal verdict yields gating-ineligible with a certification reason", () => {
    // d = 16 over n = 100, marginals 100/100: α = 1 − 199·16/10000 = 0.6816.
    const built = buildGoldSet({
      bothPass: 42,
      bothFail: 42,
      falseNegatives: 8,
      falsePositives: 8,
    });
    const result = certify(built);

    expect(result.agreement.alpha).toBeCloseTo(0.6816, 10);
    expect(result.agreement.alpha!).toBeGreaterThanOrEqual(CERTIFICATION_MARGINAL_ALPHA);
    expect(result.agreement.alpha!).toBeLessThan(CERTIFICATION_PASS_ALPHA);
    expect(result.verdict).toBe("marginal");
    expect(result.gatingEligible).toBe(false);
    expect(result.ineligibilityReasons).toContain("certification");
  });

  it("covers AE2: a fail verdict yields gating-ineligible", () => {
    // d = 30 over n = 100, marginals 100/100: α = 1 − 199·30/10000 = 0.403.
    const built = buildGoldSet({
      bothPass: 35,
      bothFail: 35,
      falseNegatives: 15,
      falsePositives: 15,
    });
    const result = certify(built);

    expect(result.agreement.alpha).toBeCloseTo(0.403, 10);
    expect(result.verdict).toBe("fail");
    expect(result.gatingEligible).toBe(false);
    expect(result.ineligibilityReasons).toContain("certification");
  });

  it("yields contestable for a gold set below the minimum unit count", () => {
    // 10 units of flawless agreement. The judge is not weak; there is simply
    // not enough of a gold set to say so.
    const built = buildGoldSet({
      bothPass: 5,
      bothFail: 5,
      falseNegatives: 0,
      falsePositives: 0,
    });
    expect(built.goldSet.entries.length).toBeLessThan(MINIMUM_GOLD_SET_SIZE);

    const result = certify(built);

    expect(result.verdict).toBe("contestable");
    expect(result.gatingEligible).toBe(false);
    expect(result.ineligibilityReasons).toContain("certification");
    expect(result.goldSetSize).toBe(10);
  });

  it("yields contestable when too few gold-set units carry a judge verdict", () => {
    // 24 human labels, but the judge only ruled on 15 of them: the units that
    // certify anything are the paired ones.
    const built = buildGoldSet({
      bothPass: 12,
      bothFail: 12,
      falseNegatives: 0,
      falsePositives: 0,
    });
    const partial = new Map(
      [...built.judgeVerdicts].slice(0, 15) as readonly (readonly [string, boolean])[],
    );

    const result = certifyJudge({
      goldSet: built.load,
      judgeVerdicts: partial,
      threshold: NO_STRADDLE_THRESHOLD,
      alphaC: ALPHA_C,
    });

    expect(result.goldSetSize).toBe(24);
    expect(result.agreement.pairedUnits).toBe(15);
    expect(result.verdict).toBe("contestable");
  });

  it("reaches all four verdict values", () => {
    const verdicts = new Set([
      certify(
        buildGoldSet({ bothPass: 48, bothFail: 48, falseNegatives: 2, falsePositives: 2 }),
      ).verdict,
      certify(
        buildGoldSet({ bothPass: 42, bothFail: 42, falseNegatives: 8, falsePositives: 8 }),
      ).verdict,
      certify(
        buildGoldSet({ bothPass: 35, bothFail: 35, falseNegatives: 15, falsePositives: 15 }),
      ).verdict,
      certify(
        buildGoldSet({ bothPass: 5, bothFail: 5, falseNegatives: 0, falsePositives: 0 }),
      ).verdict,
    ]);

    expect(verdicts).toEqual(new Set(["pass", "marginal", "fail", "contestable"]));
  });
});

describe("certifyJudge: band edges", () => {
  it("lands pass just above α = 0.800", () => {
    // d = 10 over n = 100, marginals 100/100: α = 1 − 199·10/10000 = 0.801.
    const built = buildGoldSet({
      bothPass: 45,
      bothFail: 45,
      falseNegatives: 5,
      falsePositives: 5,
    });
    const result = certify(built);

    expect(result.agreement.alpha).toBeCloseTo(0.801, 10);
    expect(result.agreement.alpha!).toBeGreaterThan(CERTIFICATION_PASS_ALPHA);
    expect(result.verdict).toBe("pass");
  });

  it("lands marginal just below α = 0.800", () => {
    // d = 11 over n = 100, marginals 99/101: α = 1 − 199·11/9999 = 0.78108.
    const built = buildGoldSet({
      bothPass: 45,
      bothFail: 44,
      falseNegatives: 6,
      falsePositives: 5,
    });
    const result = certify(built);

    expect(result.agreement.alpha).toBeCloseTo(1 - 2189 / 9999, 12);
    expect(result.agreement.alpha!).toBeLessThan(CERTIFICATION_PASS_ALPHA);
    expect(result.agreement.alpha!).toBeGreaterThanOrEqual(CERTIFICATION_MARGINAL_ALPHA);
    expect(result.verdict).toBe("marginal");
  });

  it("lands fail just below α = 0.667", () => {
    // d = 17 over n = 100, marginals 99/101: α = 1 − 199·17/9999 = 0.66167.
    const built = buildGoldSet({
      bothPass: 42,
      bothFail: 41,
      falseNegatives: 9,
      falsePositives: 8,
    });
    const result = certify(built);

    expect(result.agreement.alpha).toBeCloseTo(1 - 3383 / 9999, 12);
    expect(result.agreement.alpha!).toBeLessThan(CERTIFICATION_MARGINAL_ALPHA);
    expect(result.verdict).toBe("fail");
  });

  it("agrees with a directly computed α on the same gold set", () => {
    const built = buildGoldSet({
      bothPass: 45,
      bothFail: 45,
      falseNegatives: 5,
      falsePositives: 5,
    });

    const direct = goldSetAgreement(built.goldSet.entries, built.judgeVerdicts);
    expect(direct.defined).toBe(true);
    expect(certify(built).agreement.alpha).toBe(direct.alpha);
  });
});

describe("certifyJudge: undefined α", () => {
  it("passes a gold set with zero disagreements and perfect agreement", () => {
    // Every unit is a pass, so expected disagreement is zero and α is
    // undefined. That is the healthy-suite case, not a weak judge.
    const built = buildGoldSet({
      bothPass: 24,
      bothFail: 0,
      falseNegatives: 0,
      falsePositives: 0,
    });
    // This gold set anchors at a judged rate of 1.0, so the shared
    // no-straddle threshold sits inside its floor. Use one well below the band
    // instead, to isolate the α verdict from the floor guard.
    const result = certify(built, { threshold: 0.5 });

    expect(result.agreement.alpha).toBeNull();
    expect(result.agreement.undefinedReason).toBe("no-expected-disagreement");
    expect(result.agreement.disagreements).toBe(0);
    expect(result.verdict).toBe("pass");
    expect(result.gatingEligible).toBe(true);
  });

  it("gives α = 1 and pass when both labels appear and nothing disagrees", () => {
    const built = buildGoldSet({
      bothPass: 12,
      bothFail: 12,
      falseNegatives: 0,
      falsePositives: 0,
    });
    const result = certify(built);

    expect(result.agreement.alpha).toBe(1);
    expect(result.verdict).toBe("pass");
  });
});

describe("certifyJudge: marked gold sets", () => {
  it("refuses gating for a marked gold set whatever its verdict", () => {
    const built = buildGoldSet({
      bothPass: 48,
      bothFail: 48,
      falseNegatives: 2,
      falsePositives: 2,
    });
    const result = certify(built, { load: mark(built, "unprovenanced") });

    expect(result.verdict).toBe("pass");
    expect(result.gatingEligible).toBe(false);
    expect(result.ineligibilityReasons).toContain("marked-gold-set");
    expect(result.markingReason).toBe("unprovenanced");
  });

  it("handles a malformed marking that carries no gold set at all", () => {
    const result = certifyJudge({
      goldSet: { marked: true, reason: "malformed", message: "not YAML" },
      judgeVerdicts: new Map(),
      threshold: 0.8,
      alphaC: ALPHA_C,
    });

    expect(result.goldSetSize).toBe(0);
    expect(result.verdict).toBe("contestable");
    expect(result.gatingEligible).toBe(false);
    expect(result.rectifier).toBeNull();
    expect(result.floorHalfWidth).toBeNull();
  });
});

describe("certifyJudge: floor guard (R10)", () => {
  // 20 labels, one error each way: α = 1 − 39·2/(18·22) = 0.80303, so the
  // judge certifies `pass` and only the floor can refuse it.
  const straddling = buildGoldSet({
    bothPass: 10,
    bothFail: 8,
    falseNegatives: 1,
    falsePositives: 1,
  });

  it("covers AE7: refuses to gate before trial 1 with a labels-needed figure", () => {
    const result = certify(straddling, { threshold: 0.7 });

    expect(result.verdict).toBe("pass");
    expect(result.agreement.alpha).toBeCloseTo(1 - 78 / 396, 12);
    expect(result.floorStraddlesThreshold).toBe(true);
    expect(result.gatingEligible).toBe(false);
    expect(result.ineligibilityReasons).toContain("calibration-floor");

    expect(result.labelsNeeded).not.toBeNull();
    expect(Number.isInteger(result.labelsNeeded)).toBe(true);
    expect(result.labelsNeeded!).toBeGreaterThan(result.goldSetSize);
  });

  it("reports the labels needed to bring the floor under the threshold gap", () => {
    const result = certify(straddling, { threshold: 0.7 });
    const counts = confusionFromPairs(straddling.pairs);
    const rectifier = estimateRectifier(counts, ALPHA_C);
    const centre =
      result.anchorRate! + (rectifier.interval.lower + rectifier.interval.upper) / 2;
    const gap = Math.abs(centre - 0.7);

    expect(result.labelsNeeded).toBe(labelsNeededForHalfWidth(counts, gap, ALPHA_C));
  });

  it("anchors the band on the judge's own gold-set pass rate before trial 1", () => {
    // 10 true positives + 1 false positive out of 20 units.
    expect(certify(straddling, { threshold: 0.7 }).anchorRate).toBeCloseTo(0.55, 12);
  });

  it("lets the caller override the anchor with an observed judged rate", () => {
    const result = certify(straddling, { threshold: 0.7, judgedRate: 0.2 });
    expect(result.anchorRate).toBe(0.2);
    expect(result.floorStraddlesThreshold).toBe(false);
    expect(result.gatingEligible).toBe(true);
    expect(result.labelsNeeded).toBeNull();
  });

  it("gates when the floor clears the threshold", () => {
    const result = certify(straddling, { threshold: 0.999 });

    expect(result.floorStraddlesThreshold).toBe(false);
    expect(result.gatingEligible).toBe(true);
    expect(result.labelsNeeded).toBeNull();
  });

  it("anchors on the raw judged rate, not on the corrected estimate", () => {
    // The tripwire for applying `delta` twice. This judge errs in one direction
    // only — 2 false negatives, no false positives — so `delta` = +0.10 and the
    // raw judged rate (0.50) and the corrected estimate (0.60) are far enough
    // apart to disagree about a threshold between the two bands:
    //
    //   anchored on judged 0.50 (correct):    [0.323, 0.837] → straddles 0.35
    //   anchored on corrected 0.60 (wrong):   [0.423, 0.937] → clears 0.35
    //
    // `estimateRectifier`'s interval is an interval on `delta`, so the guard's
    // first argument has to be the rate `delta` is an offset FROM. Passing
    // `judged + delta` would flip every assertion below.
    const built = buildGoldSet({
      bothPass: 10,
      bothFail: 8,
      falseNegatives: 2,
      falsePositives: 0,
    });
    const result = certify(built, { threshold: 0.35 });

    expect(result.verdict).toBe("pass"); // α = 0.80303, so only the floor can refuse
    expect(result.rectifier!.delta).toBeCloseTo(0.1, 12);
    expect(result.anchorRate).toBeCloseTo(0.5, 12);
    expect(result.floorStraddlesThreshold).toBe(true);
    expect(result.ineligibilityReasons).toEqual(["calibration-floor"]);

    // Spelled out, so the failure message names the bug: a band hung off the
    // corrected estimate would sit entirely above this threshold.
    const corrected = result.anchorRate! + result.rectifier!.delta;
    expect(corrected + result.rectifier!.interval.lower).toBeGreaterThan(0.35);
  });

  it("still reports a labels-needed figure for a judge with no observed errors", () => {
    // Zero disagreements, so the Wilson cells are both zero-count and the
    // normal approximation would collapse; U2 inverts them exactly instead.
    const built = buildGoldSet({
      bothPass: 24,
      bothFail: 0,
      falseNegatives: 0,
      falsePositives: 0,
    });
    const result = certify(built, { threshold: 0.9 });

    expect(result.rectifier!.delta).toBe(0);
    expect(result.floorStraddlesThreshold).toBe(true);
    expect(result.labelsNeeded).not.toBeNull();
    expect(result.labelsNeeded!).toBeGreaterThan(result.goldSetSize);
  });

  it("reports the floor U2 estimates for the same gold set", () => {
    const built = buildGoldSet({
      bothPass: 45,
      bothFail: 45,
      falseNegatives: 5,
      falsePositives: 5,
    });
    const expected = estimateRectifier(confusionFromPairs(built.pairs), ALPHA_C);
    const result = certify(built);

    expect(result.floorHalfWidth).toBe(expected.halfWidth);
    expect(result.rectifier).toEqual(expected);
  });
});

describe("certifyJudge: α interval diagnostic", () => {
  it("attaches a bootstrap interval around a defined α", () => {
    const built = buildGoldSet({
      bothPass: 45,
      bothFail: 45,
      falseNegatives: 5,
      falsePositives: 5,
    });
    const { interval } = certify(built).agreement;

    expect(interval).not.toBeNull();
    expect(interval!.lower).toBeLessThanOrEqual(interval!.upper);
    expect(interval!.confidence).toBeCloseTo(0.95, 12);
    expect(interval!.resamples).toBeGreaterThan(0);
  });

  it("is deterministic across calls", () => {
    const built = buildGoldSet({
      bothPass: 45,
      bothFail: 45,
      falseNegatives: 5,
      falsePositives: 5,
    });

    expect(certify(built).agreement.interval).toEqual(
      certify(built).agreement.interval,
    );
  });

  it("has no interval when α itself is undefined", () => {
    const built = buildGoldSet({
      bothPass: 24,
      bothFail: 0,
      falseNegatives: 0,
      falsePositives: 0,
    });

    expect(certify(built).agreement.interval).toBeNull();
  });
});

describe("certifyJudge: input validation", () => {
  it("throws on an alphaC outside (0,1)", () => {
    const built = buildGoldSet({
      bothPass: 12,
      bothFail: 12,
      falseNegatives: 0,
      falsePositives: 0,
    });

    expect(() =>
      certifyJudge({
        goldSet: built.load,
        judgeVerdicts: built.judgeVerdicts,
        threshold: 0.8,
        alphaC: 0,
      }),
    ).toThrow(/alphaC/);
  });
});
