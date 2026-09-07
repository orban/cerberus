// Krippendorff's alpha: chance-corrected agreement over a reliability matrix.
//
// Why alpha rather than percent agreement or Cohen's kappa: it handles missing
// labels, any number of raters, and ordinal distance — a judge disagreeing 2-vs-3
// should cost less than 2-vs-5.
//
// Ported from the Apache-2.0 leakeval reference implementation
// (leakeval/calibration.py), which is itself a hand-rolled coincidence-matrix
// form tested against the canonical worked example (nominal 0.691, interval
// 0.811). No new runtime dependency: this is ~80 lines of arithmetic.

import { MINIMUM_GOLD_SET_SIZE } from "./config.js";
import {
  calibrationFloorStraddles,
  confusionFromPairs,
  estimateRectifier,
  labelsNeededForHalfWidth,
  type ConfusionCounts,
  type GoldLabelledVerdict,
  type RectifierEstimate,
} from "./correction.js";
import type {
  AlphaDiagnostics,
  AlphaInterval,
  CertificationVerdict,
  GatingIneligibilityReason,
  GoldSetEntry,
  GoldSetLoadResult,
  JudgeCertification,
} from "./types.js";

// ── Types ────────────────────────────────────────────────────

/** Rows are raters, columns are units. `null` is a missing rating. */
export type ReliabilityMatrix = readonly (readonly (number | null)[])[];

export type MeasurementLevel = "nominal" | "ordinal" | "interval";

/**
 * Why alpha has no value. Never conflate these with a low alpha: a judge whose
 * agreement is undefined has not been measured, it has not been measured badly.
 */
export type UndefinedAgreementReason =
  | "no-values" // every cell is missing
  | "insufficient-pairable-values" // no unit carries two or more ratings
  | "no-expected-disagreement"; // no variation to have agreed about

export interface AgreementCounts {
  readonly level: MeasurementLevel;
  /** Non-missing cells in the matrix, including unpairable ones. */
  readonly observedValues: number;
  /** Units carrying at least two ratings. Single-rater units are skipped. */
  readonly validUnits: number;
  /** Ratings inside valid units — the n that enters the alpha formula. */
  readonly pairableValues: number;
}

export interface DefinedAgreement extends AgreementCounts {
  readonly defined: true;
  /** Not clamped. Negative alpha means systematic disagreement beyond chance. */
  readonly alpha: number;
}

export interface UndefinedAgreement extends AgreementCounts {
  readonly defined: false;
  readonly alpha: undefined;
  readonly reason: UndefinedAgreementReason;
}

export type Agreement = DefinedAgreement | UndefinedAgreement;

export interface Coincidence {
  /** Observed values in ascending numeric order; positions are ranks. */
  readonly values: readonly number[];
  readonly matrix: readonly (readonly number[])[];
  readonly marginals: readonly number[];
  readonly observedValues: number;
  readonly validUnits: number;
  readonly pairableValues: number;
}

// ── Coincidence matrix ───────────────────────────────────────

/**
 * Each pairable unit contributes all of its ordered value pairs, weighted
 * 1/(m − 1) so that units with more raters do not dominate.
 */
function coincidenceMatrix(data: ReliabilityMatrix): Coincidence {
  const units = data[0]?.length ?? 0;
  for (let r = 0; r < data.length; r++) {
    const row = data[r]!;
    if (row.length !== units) {
      throw new RangeError(
        `krippendorffAlpha: ragged reliability matrix (row ${r} has ${row.length} columns, expected ${units})`,
      );
    }
  }

  const distinct = new Set<number>();
  let observedValues = 0;
  for (const row of data) {
    for (const value of row) {
      if (value === null) continue;
      distinct.add(value);
      observedValues++;
    }
  }

  // Numerically, not lexicographically: the default sort would order [1, 2, 10]
  // as [1, 10, 2], which leaves nominal alpha correct while silently corrupting
  // the ordinal ranks.
  const values = [...distinct].sort((a, b) => a - b);
  const size = values.length;
  const rank = new Map(values.map((value, i) => [value, i]));

  // Flat row-major cells; reshaped once at the end.
  const cells = new Array<number>(size * size).fill(0);
  let validUnits = 0;
  let pairableValues = 0;

  for (let u = 0; u < units; u++) {
    const unitRanks: number[] = [];
    for (const row of data) {
      const value = row[u];
      if (value === null || value === undefined) continue;
      unitRanks.push(rank.get(value)!); // every observed value is ranked
    }

    const m = unitRanks.length;
    if (m < 2) continue; // a single rating agrees with nothing
    validUnits++;
    pairableValues += m;

    const weight = 1 / (m - 1);
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < m; j++) {
        if (i === j) continue;
        const cell = unitRanks[i]! * size + unitRanks[j]!;
        cells[cell] = cells[cell]! + weight;
      }
    }
  }

  const matrix = Array.from({ length: size }, (_, r) =>
    cells.slice(r * size, (r + 1) * size),
  );
  const marginals = matrix.map((row) => row.reduce((sum, x) => sum + x, 0));

  return {
    values,
    matrix,
    marginals,
    observedValues,
    validUnits,
    pairableValues,
  };
}

// ── Difference functions ─────────────────────────────────────

/**
 * Disagreement weight between two value ranks. Nominal treats every
 * disagreement alike; interval squares the numeric gap; ordinal squares the sum
 * of marginals spanned by the two ranks, half-weighting the endpoints.
 */
function differenceFunction(
  level: MeasurementLevel,
  values: readonly number[],
  marginals: readonly number[],
): (a: number, b: number) => number {
  switch (level) {
    case "nominal":
      return (a, b) => (a === b ? 0 : 1);
    case "interval":
      return (a, b) => (values[a]! - values[b]!) ** 2;
    case "ordinal":
      return (a, b) => {
        if (a === b) return 0;
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        let spanned = 0;
        for (let g = lo; g <= hi; g++) spanned += marginals[g]!;
        spanned -= (marginals[lo]! + marginals[hi]!) / 2;
        return spanned ** 2;
      };
  }
}

// ── Alpha ────────────────────────────────────────────────────

/**
 * Alpha over a reliability matrix: rows are raters, columns are units.
 *
 * Returns an undefined-agreement result rather than a number when alpha has no
 * value — fewer than two pairable values, or zero expected disagreement. The
 * all-same-value matrix is undefined, NOT 1.0: perfect agreement on a constant
 * is not evidence of a reliable instrument.
 */
export function krippendorffAlpha(
  data: ReliabilityMatrix,
  level: MeasurementLevel = "ordinal",
): Agreement {
  const { values, matrix, marginals, observedValues, validUnits, pairableValues } =
    coincidenceMatrix(data);

  const counts: AgreementCounts = {
    level,
    observedValues,
    validUnits,
    pairableValues,
  };

  if (values.length === 0) {
    return { ...counts, defined: false, alpha: undefined, reason: "no-values" };
  }
  if (pairableValues <= 1) {
    return {
      ...counts,
      defined: false,
      alpha: undefined,
      reason: "insufficient-pairable-values",
    };
  }

  const delta = differenceFunction(level, values, marginals);
  let observed = 0;
  let expected = 0;
  for (let a = 0; a < values.length; a++) {
    for (let b = a + 1; b < values.length; b++) {
      const d = delta(a, b);
      observed += matrix[a]![b]! * d;
      expected += marginals[a]! * marginals[b]! * d;
    }
  }

  if (expected === 0) {
    return {
      ...counts,
      defined: false,
      alpha: undefined,
      reason: "no-expected-disagreement",
    };
  }

  return {
    ...counts,
    defined: true,
    alpha: 1 - ((pairableValues - 1) * observed) / expected,
  };
}

// ── Bootstrap interval on alpha ──────────────────────────────

const ALPHA_BOOTSTRAP_RESAMPLES = 2000;
const ALPHA_BOOTSTRAP_CONFIDENCE = 0.95;
// Any fixed seed will do; the point is that two calls on the same gold set
// report the same interval, so a diagnostic never moves on its own.
const ALPHA_BOOTSTRAP_SEED = 0x9e3779b9;

/** mulberry32: a seeded PRNG in four lines, so the bootstrap adds no dependency. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BootstrapOptions {
  readonly confidence?: number;
  readonly resamples?: number;
  readonly seed?: number;
}

/**
 * Percentile bootstrap on alpha, resampling UNITS (columns) with replacement.
 * Units are the independent objects here, not individual ratings: resampling
 * ratings would break the pairing that alpha is computed over.
 *
 * Returns `null` when fewer than two resamples produced a defined alpha —
 * near-constant gold sets routinely resample into zero expected disagreement,
 * and a percentile over one point is not an interval.
 */
export function bootstrapAlphaInterval(
  data: ReliabilityMatrix,
  level: MeasurementLevel = "nominal",
  options: BootstrapOptions = {},
): AlphaInterval | null {
  const confidence = options.confidence ?? ALPHA_BOOTSTRAP_CONFIDENCE;
  const resamples = options.resamples ?? ALPHA_BOOTSTRAP_RESAMPLES;
  const units = data[0]?.length ?? 0;
  if (units === 0 || resamples < 2) return null;

  const random = mulberry32(options.seed ?? ALPHA_BOOTSTRAP_SEED);
  const alphas: number[] = [];

  for (let b = 0; b < resamples; b++) {
    const picks = Array.from({ length: units }, () =>
      Math.min(units - 1, Math.floor(random() * units)),
    );
    const resampled = data.map((row) => picks.map((u) => row[u] ?? null));
    const agreement = krippendorffAlpha(resampled, level);
    if (agreement.defined) alphas.push(agreement.alpha);
  }

  if (alphas.length < 2) return null;

  alphas.sort((a, b) => a - b);
  const tail = (1 - confidence) / 2;
  const last = alphas.length - 1;
  return {
    lower: alphas[Math.floor(tail * last)]!,
    upper: alphas[Math.ceil((1 - tail) * last)]!,
    confidence,
    resamples: alphas.length,
  };
}

// ── Judge certification (KTD5) ───────────────────────────────
//
// The bands sit directly on judge-vs-human alpha, at Krippendorff's published
// cutoffs. The gap rule the leakeval reference uses does not survive the port:
// it scores a judge by the distance between judge-vs-human alpha and a
// human-human baseline, and that baseline needs two human raters per unit.
// A Cerberus gold set carries one label per scenario, so the ported rule would
// return insufficient-data for every gold set that can be loaded.
//
// `contestable` therefore means undefined-or-undersized here, NOT leakeval's
// low-human-agreement sense.

/** Krippendorff's cutoff for relying on data. */
export const CERTIFICATION_PASS_ALPHA = 0.8;
/** Krippendorff's cutoff for drawing tentative conclusions. */
export const CERTIFICATION_MARGINAL_ALPHA = 0.667;

// Both raters are binary, so the encoding only has to be stable: on a
// two-valued scale nominal, ordinal and interval alpha coincide.
const ENCODED_PASS = 1;
const ENCODED_FAIL = 0;

function encode(pass: boolean): number {
  return pass ? ENCODED_PASS : ENCODED_FAIL;
}

/**
 * Row 1 is the human labels, row 2 the judge's verdicts on the same scenarios.
 * A scenario the judge did not rule on becomes a missing rating rather than a
 * dropped column, so the unit still counts toward the gold set's size.
 */
function reliabilityMatrix(
  entries: readonly GoldSetEntry[],
  judgeVerdicts: ReadonlyMap<string, boolean>,
): ReliabilityMatrix {
  const human: (number | null)[] = [];
  const judge: (number | null)[] = [];

  for (const entry of entries) {
    human.push(encode(entry.label === "pass"));
    const verdict = judgeVerdicts.get(entry.scenario);
    judge.push(verdict === undefined ? null : encode(verdict));
  }

  return [human, judge];
}

/** Judge-vs-human agreement over a gold set, on the nominal scale. */
export function goldSetAgreement(
  entries: readonly GoldSetEntry[],
  judgeVerdicts: ReadonlyMap<string, boolean>,
): Agreement {
  return krippendorffAlpha(reliabilityMatrix(entries, judgeVerdicts), "nominal");
}

function goldLabelledVerdicts(
  entries: readonly GoldSetEntry[],
  judgeVerdicts: ReadonlyMap<string, boolean>,
): GoldLabelledVerdict[] {
  const pairs: GoldLabelledVerdict[] = [];

  for (const entry of entries) {
    const judgeVerdict = judgeVerdicts.get(entry.scenario);
    if (judgeVerdict === undefined) continue;
    pairs.push({ humanLabel: entry.label === "pass", judgeVerdict });
  }

  return pairs;
}

/**
 * The size check reads PAIRED units, not gold-set entries: a scenario the
 * judge never ruled on certifies nothing. On a complete gold set the two are
 * the same number.
 */
function verdictFromAgreement(
  agreement: Agreement,
  disagreements: number,
): CertificationVerdict {
  if (agreement.validUnits < MINIMUM_GOLD_SET_SIZE) return "contestable";

  if (agreement.defined) {
    if (agreement.alpha >= CERTIFICATION_PASS_ALPHA) return "pass";
    if (agreement.alpha >= CERTIFICATION_MARGINAL_ALPHA) return "marginal";
    return "fail";
  }

  // Undefined alpha is not evidence of a weak judge. A gold set the judge and
  // the human never disagreed on has zero expected disagreement and therefore
  // no alpha — the common healthy-suite case, and a pass. Anything else that
  // leaves alpha undefined has not measured the judge at all.
  return disagreements === 0 ? "pass" : "contestable";
}

/**
 * The floor stops straddling once its half-width falls under the distance from
 * the calibration band's centre to the threshold, so that distance is the
 * target handed to the labels-needed solver.
 *
 * `anchorRate` is the RAW judged rate, exactly as the guard takes it — the
 * centre is the anchor plus the interval's own midpoint, never the corrected
 * estimate plus the interval again.
 *
 * A threshold sitting exactly on the centre has no target: no gold-set size
 * separates it. That is reported as absent rather than as infinity, and the
 * guard is load-bearing — `labelsNeededForHalfWidth` throws on a non-positive
 * target. Every other case yields a figure, including a judge with no observed
 * errors at all, whose zero-count Wilson cells the solver inverts exactly.
 */
function labelsToClearFloor(
  counts: ConfusionCounts,
  rectifier: RectifierEstimate,
  anchorRate: number,
  threshold: number,
  alphaC: number,
): number | null {
  const centre =
    anchorRate + (rectifier.interval.lower + rectifier.interval.upper) / 2;
  const gap = Math.abs(centre - threshold);
  if (!(gap > 0)) return null;

  return labelsNeededForHalfWidth(counts, gap, alphaC);
}

export interface CertificationOptions {
  /** U4's load result. A marked gold set can never gate, whatever its alpha. */
  readonly goldSet: GoldSetLoadResult;
  /** The judge's verdict on each gold-set scenario, keyed by scenario. */
  readonly judgeVerdicts: ReadonlyMap<string, boolean>;
  /** The contract's pass-rate threshold, for the R10 floor guard. */
  readonly threshold: number;
  /** The two-sided level the calibration interval is built at. */
  readonly alphaC: number;
  /**
   * The judged rate the calibration band hangs off. Before the first trial
   * there is no such rate, so it defaults to the judge's own pass rate over the
   * gold set — legitimate only because the correction already assumes the gold
   * set is drawn from the trial population. Callers holding a running judged
   * rate should pass it.
   */
  readonly judgedRate?: number;
}

/**
 * Whether a judge may gate, decided before trial 1 (R2, R6, R10).
 *
 * Weak judges are refused twice, per KD6: the alpha bands refuse them up front,
 * and the floor guard refuses them again when the calibration interval alone
 * cannot separate the threshold. The two are distinct statistics off the same
 * small gold set, so passing one does not bound the other.
 */
export function certifyJudge(options: CertificationOptions): JudgeCertification {
  const { goldSet: load, judgeVerdicts, threshold, alphaC } = options;
  if (!(alphaC > 0 && alphaC < 1)) {
    throw new RangeError(`alphaC must be in (0,1), got ${alphaC}`);
  }

  const entries = load.goldSet?.entries ?? [];
  const matrix = reliabilityMatrix(entries, judgeVerdicts);
  const agreement = krippendorffAlpha(matrix, "nominal");
  const pairs = goldLabelledVerdicts(entries, judgeVerdicts);
  const disagreements = pairs.filter(
    (pair) => pair.humanLabel !== pair.judgeVerdict,
  ).length;

  const diagnostics: AlphaDiagnostics = {
    alpha: agreement.defined ? agreement.alpha : null,
    undefinedReason: agreement.defined ? null : agreement.reason,
    interval: agreement.defined ? bootstrapAlphaInterval(matrix, "nominal") : null,
    pairedUnits: agreement.validUnits,
    disagreements,
  };

  const verdict = verdictFromAgreement(agreement, disagreements);

  const counts = pairs.length > 0 ? confusionFromPairs(pairs) : null;
  const rectifier = counts === null ? null : estimateRectifier(counts, alphaC);

  // The RAW judged rate — the share of gold-set units the judge passed. Never
  // `judged + delta`: the rectifier interval is an interval on `delta` itself,
  // so anchoring the guard on an already-corrected estimate applies `delta`
  // twice and silently shifts the whole band.
  const anchorRate =
    options.judgedRate ??
    (counts === null ? null : (counts.tp + counts.fp) / pairs.length);

  const floorStraddlesThreshold =
    rectifier !== null &&
    anchorRate !== null &&
    calibrationFloorStraddles(anchorRate, rectifier.interval, threshold);

  const labelsNeeded =
    floorStraddlesThreshold && counts !== null && rectifier !== null && anchorRate !== null
      ? labelsToClearFloor(counts, rectifier, anchorRate, threshold, alphaC)
      : null;

  const ineligibilityReasons: GatingIneligibilityReason[] = [];
  if (load.marked) ineligibilityReasons.push("marked-gold-set");
  if (verdict !== "pass") ineligibilityReasons.push("certification");
  if (floorStraddlesThreshold) ineligibilityReasons.push("calibration-floor");

  return {
    verdict,
    gatingEligible: ineligibilityReasons.length === 0,
    ineligibilityReasons,
    markingReason: load.marked ? load.reason : null,
    agreement: diagnostics,
    goldSetSize: entries.length,
    rectifier,
    floorHalfWidth: rectifier?.halfWidth ?? null,
    floorStraddlesThreshold,
    anchorRate,
    labelsNeeded,
    threshold,
    alphaC,
  };
}

// Re-export for testing
export { coincidenceMatrix as _coincidenceMatrix };
