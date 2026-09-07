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

// Re-export for testing
export { coincidenceMatrix as _coincidenceMatrix };
