import { wilsonScoreInterval, zForConfidence } from "./stats.js";

// Bias correction for judge contracts (KTD3).
//
// The judge is not an oracle, so the rate at which it says "pass" is not the
// rate at which the agent is right. This module estimates the gap from a gold
// set of human-labelled scenarios and carries its uncertainty.
//
// The estimator is Prediction-Powered-Inference-shaped with lambda fixed at 1:
// the corrected rate is the judged rate PLUS an additive rectifier `delta`, not
// a Rogan-Gladen ratio. There is no `se + sp - 1` denominator here, so nothing
// explodes as the judge approaches chance; a weak judge instead shows up as a
// wide calibration interval, which is exactly what the floor guard reads.
//
// Two assumptions live at this boundary and are invisible from the code:
//   1. The gold set is drawn from the same population as the trials. This
//      correction covers judge error, never distributional mismatch.
//   2. The same gold set is reused for certification and for correction, so
//      the two statistics are dependent. The union bound downstream (KTD2)
//      needs no independence, which is what makes the reuse legitimate.

// ── Types ────────────────────────────────────────────────────

/** One gold-set item: the human's label and the judge's verdict on it. */
export interface GoldLabelledVerdict {
  readonly humanLabel: boolean;
  readonly judgeVerdict: boolean;
}

/** The 2x2 confusion matrix of judge verdicts against human labels. */
export interface ConfusionCounts {
  /** Judge says pass, human says pass. */
  readonly tp: number;
  /** Judge says pass, human says fail — a judge false positive (`b`). */
  readonly fp: number;
  /** Judge says fail, human says pass — a judge false negative (`a`). */
  readonly fn: number;
  /** Judge says fail, human says fail. */
  readonly tn: number;
}

/** An interval on the rectifier. Not clamped to the unit interval. */
export interface RectifierInterval {
  readonly lower: number;
  readonly upper: number;
}

/**
 * R3's certification diagnostics. Reported alongside the correction, never
 * used as its divisor. Every rate is `null` when its denominator is zero
 * rather than NaN.
 */
export interface JudgeDiagnostics {
  readonly sensitivity: number | null;
  readonly specificity: number | null;
  readonly ppv: number | null;
  readonly npv: number | null;
  /** `PPV + NPV - 1`: the one-line answer to what a better judge would buy. */
  readonly markedness: number | null;
}

export interface RectifierEstimate {
  /** The point estimate `(a - b) / m`: the raw ratio, never a Wilson centre. */
  readonly delta: number;
  /** The two-cell union interval on `delta` at level `alphaC`. */
  readonly interval: RectifierInterval;
  /** Half the interval's width: the precision floor trials cannot shrink. */
  readonly halfWidth: number;
  /** Gold-set size. */
  readonly m: number;
  /** `a`: judge false negatives. */
  readonly falseNegatives: number;
  /** `b`: judge false positives. */
  readonly falsePositives: number;
  /** The two-sided level the interval was built at. */
  readonly alphaC: number;
  readonly diagnostics: JudgeDiagnostics;
}

// ── Counting ─────────────────────────────────────────────────

export function confusionFromPairs(
  pairs: readonly GoldLabelledVerdict[],
): ConfusionCounts {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;

  for (const { humanLabel, judgeVerdict } of pairs) {
    if (judgeVerdict) {
      if (humanLabel) tp++;
      else fp++;
    } else {
      if (humanLabel) fn++;
      else tn++;
    }
  }

  return { tp, fp, fn, tn };
}

// ── Diagnostics ──────────────────────────────────────────────

function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

export function judgeDiagnostics(counts: ConfusionCounts): JudgeDiagnostics {
  const { tp, fp, fn, tn } = counts;

  const sensitivity = rate(tp, tp + fn);
  const specificity = rate(tn, tn + fp);
  const ppv = rate(tp, tp + fp);
  const npv = rate(tn, tn + fn);
  const markedness = ppv === null || npv === null ? null : ppv + npv - 1;

  return { sensitivity, specificity, ppv, npv, markedness };
}

// ── Rectifier and calibration interval ───────────────────────

function assertCounts(counts: ConfusionCounts): number {
  for (const value of [counts.tp, counts.fp, counts.fn, counts.tn]) {
    if (!Number.isInteger(value) || value < 0) {
      throw new RangeError(
        `confusion counts must be non-negative integers, got ${JSON.stringify(counts)}`,
      );
    }
  }

  const m = counts.tp + counts.fp + counts.fn + counts.tn;
  if (m === 0) {
    throw new RangeError("gold set is empty: the rectifier is undefined for m = 0");
  }

  return m;
}

function assertAlphaC(alphaC: number): void {
  if (!(alphaC > 0 && alphaC < 1)) {
    throw new RangeError(`alphaC must be in (0,1), got ${alphaC}`);
  }
}

/**
 * `wilsonScoreInterval` takes a TWO-SIDED confidence and derives z internally
 * as `Phi^-1(1 - (1 - confidence) / 2)`. Each cell of the union is built at
 * level `alphaC / 2`, so the confidence passed is `1 - alphaC / 2` — not
 * `1 - alphaC`. Getting this wrong is a silent factor-of-two error.
 */
function cellConfidence(alphaC: number): number {
  return 1 - alphaC / 2;
}

/** The z the per-cell Wilson call uses, for the labels-needed inversion. */
function cellZ(alphaC: number): number {
  return zForConfidence(cellConfidence(alphaC));
}

export function estimateRectifier(
  counts: ConfusionCounts,
  alphaC: number,
): RectifierEstimate {
  const m = assertCounts(counts);
  assertAlphaC(alphaC);

  const a = counts.fn;
  const b = counts.fp;

  const confidence = cellConfidence(alphaC);
  const cellA = wilsonScoreInterval(a, m, confidence);
  const cellB = wilsonScoreInterval(b, m, confidence);

  // Union of the two cells: the widest the difference can be when each cell
  // sits at its own extreme.
  const lower = cellA.lower - cellB.upper;
  const upper = cellA.upper - cellB.lower;

  return {
    delta: (a - b) / m,
    interval: { lower, upper },
    halfWidth: (upper - lower) / 2,
    m,
    falseNegatives: a,
    falsePositives: b,
    alphaC,
    diagnostics: judgeDiagnostics(counts),
  };
}

// ── Labels-needed solver ─────────────────────────────────────

/**
 * The gold-set size needed to bring the calibration floor down to
 * `targetHalfWidth`, holding the observed per-cell error rate fixed.
 *
 * Each cell contributes about `z * sqrt(eBar / m)` to the half-width, so
 * `wC ~= 2 * z * sqrt(eBar / m)` and `m = 4 * z^2 * eBar / wC^2`. The result
 * is rounded up, and is an estimate: it assumes the larger gold set errs at
 * the same rate the current one does.
 */
export function labelsNeededForHalfWidth(
  counts: ConfusionCounts,
  targetHalfWidth: number,
  alphaC: number,
): number {
  const m = assertCounts(counts);
  assertAlphaC(alphaC);

  if (!(targetHalfWidth > 0)) {
    throw new RangeError(
      `targetHalfWidth must be positive, got ${targetHalfWidth}`,
    );
  }

  const z = cellZ(alphaC);
  const eBar = (counts.fn + counts.fp) / (2 * m);

  if (eBar === 0) {
    // The normal approximation collapses to m = 0 with no observed errors,
    // but the Wilson floor at a zero cell is not zero: each cell spans
    // [0, (z^2/m) / (1 + z^2/m)]. Invert that exactly instead.
    if (targetHalfWidth >= 1) {
      return 1;
    }
    return Math.ceil((z * z * (1 - targetHalfWidth)) / targetHalfWidth);
  }

  return Math.ceil((4 * z * z * eBar) / (targetHalfWidth * targetHalfWidth));
}

// ── Floor guard (R10) ────────────────────────────────────────

/**
 * Whether the calibration interval ALONE straddles the threshold. When it
 * does, no number of trials can produce a decisive result: the sampling term
 * shrinks with trials, this one does not.
 *
 * `estimate` is the point the calibration band is anchored on — the judged
 * rate, since `interval` is already expressed as an offset from the judged
 * rate to the corrected estimand. Touching the threshold counts as
 * straddling: the gate must not claim a decision from a boundary case.
 */
export function calibrationFloorStraddles(
  estimate: number,
  interval: RectifierInterval,
  threshold: number,
): boolean {
  return estimate + interval.lower <= threshold && estimate + interval.upper >= threshold;
}
