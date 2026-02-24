import type { SPRTConfig, SPRTState, ConfidenceInterval } from "./types.js";

// ── Z-score lookup ───────────────────────────────────────────
// Rational approximation of the inverse normal CDF (Abramowitz & Stegun 26.2.23).
// Accurate to ~4.5e-4. Good enough for CI computation; avoids a dependency.

function inverseNormalCDF(p: number): number {
  if (p <= 0 || p >= 1) {
    throw new RangeError(`inverseNormalCDF: p must be in (0,1), got ${p}`);
  }

  // Coefficients for the rational approximation
  const a1 = -3.969683028665376e1;
  const a2 = 2.209460984245205e2;
  const a3 = -2.759285104469687e2;
  const a4 = 1.383577518672690e2;
  const a5 = -3.066479806614716e1;
  const a6 = 2.506628277459239e0;

  const b1 = -5.447609879822406e1;
  const b2 = 1.615858368580409e2;
  const b3 = -1.556989798598866e2;
  const b4 = 6.680131188771972e1;
  const b5 = -1.328068155288572e1;

  const c1 = -7.784894002430293e-3;
  const c2 = -3.223964580411365e-1;
  const c3 = -2.400758277161838e0;
  const c4 = -2.549732539343734e0;
  const c5 = 4.374664141464968e0;
  const c6 = 2.938163982698783e0;

  const d1 = 7.784695709041462e-3;
  const d2 = 3.224671290700398e-1;
  const d3 = 2.445134137142996e0;
  const d4 = 3.754408661907416e0;

  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  let q: number;
  let r: number;

  if (p < pLow) {
    // Rational approximation for lower region
    q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c1 * q + c2) * q + c3) * q + c4) * q + c5) * q + c6) /
      ((((d1 * q + d2) * q + d3) * q + d4) * q + 1)
    );
  } else if (p <= pHigh) {
    // Rational approximation for central region
    q = p - 0.5;
    r = q * q;
    return (
      ((((((a1 * r + a2) * r + a3) * r + a4) * r + a5) * r + a6) * q) /
      (((((b1 * r + b2) * r + b3) * r + b4) * r + b5) * r + 1)
    );
  } else {
    // Rational approximation for upper region
    q = Math.sqrt(-2 * Math.log(1 - p));
    return (
      -(((((c1 * q + c2) * q + c3) * q + c4) * q + c5) * q + c6) /
      ((((d1 * q + d2) * q + d3) * q + d4) * q + 1)
    );
  }
}

// ── SPRT ─────────────────────────────────────────────────────

export function sprtConfigFromContract(
  threshold: number,
  confidence: number,
): SPRTConfig {
  const p0 = threshold;
  const p1 = Math.max(0.01, threshold - 0.10);
  const alpha = 1 - confidence;
  const beta = 0.20;

  return { p0, p1, alpha, beta };
}

export function createSPRT(config: SPRTConfig): SPRTState {
  const A = (1 - config.alpha) / config.beta; // upper boundary (accept H₀)
  const B = config.alpha / (1 - config.beta); // lower boundary (reject H₀)

  return {
    logLR: 0,
    observations: 0,
    successes: 0,
    decision: "continue",
    upperBoundary: Math.log(A),
    lowerBoundary: Math.log(B),
  };
}

export function updateSPRT(
  state: SPRTState,
  config: SPRTConfig,
  success: boolean,
): SPRTState {
  if (state.decision !== "continue") {
    return state; // already decided
  }

  // Guard against degenerate probabilities
  const p0 = Math.max(1e-10, Math.min(1 - 1e-10, config.p0));
  const p1 = Math.max(1e-10, Math.min(1 - 1e-10, config.p1));

  // Log-likelihood ratio update for Bernoulli SPRT
  const logUpdate = success
    ? Math.log(p0 / p1)
    : Math.log((1 - p0) / (1 - p1));

  const newLogLR = state.logLR + logUpdate;
  const newObservations = state.observations + 1;
  const newSuccesses = state.successes + (success ? 1 : 0);

  // NaN guard
  if (!Number.isFinite(newLogLR)) {
    return {
      ...state,
      observations: newObservations,
      successes: newSuccesses,
      decision: "continue", // can't decide on NaN, keep going
    };
  }

  let decision: SPRTState["decision"] = "continue";

  // Upper boundary: strong evidence FOR the null hypothesis (agent meets threshold)
  if (newLogLR >= state.upperBoundary) {
    decision = "accept";
  }
  // Lower boundary: strong evidence AGAINST the null hypothesis (agent fails)
  else if (newLogLR <= state.lowerBoundary) {
    decision = "reject";
  }

  return {
    logLR: newLogLR,
    observations: newObservations,
    successes: newSuccesses,
    decision,
    upperBoundary: state.upperBoundary,
    lowerBoundary: state.lowerBoundary,
  };
}

// ── Wilson Score Confidence Interval ─────────────────────────

export function wilsonScoreInterval(
  successes: number,
  n: number,
  confidence: number,
): ConfidenceInterval {
  if (n === 0) {
    return { lower: 0, upper: 1, center: 0, n: 0 };
  }

  const z = inverseNormalCDF(1 - (1 - confidence) / 2);
  const z2 = z * z;
  const pHat = successes / n;

  const denominator = 1 + z2 / n;
  const center = (pHat + z2 / (2 * n)) / denominator;
  const spread =
    (z * Math.sqrt(pHat * (1 - pHat) / n + z2 / (4 * n * n))) / denominator;

  return {
    lower: Math.max(0, center - spread),
    upper: Math.min(1, center + spread),
    center,
    n,
  };
}

// ── Multiple testing corrections ─────────────────────────────

export function bonferroniCorrection(
  alpha: number,
  numTests: number,
): number[] {
  const corrected = alpha / numTests;
  return Array.from({ length: numTests }, () => corrected);
}

export function benjaminiHochbergCorrection(
  pValues: readonly number[],
  alpha: number,
): { readonly correctedAlphas: readonly number[]; readonly rejected: readonly boolean[] } {
  const n = pValues.length;
  if (n === 0) {
    return { correctedAlphas: [], rejected: [] };
  }

  // Sort p-values, keeping track of original indices
  const indexed = pValues.map((p, i) => ({ p, i }));
  indexed.sort((a, b) => a.p - b.p);

  const rejected = new Array<boolean>(n).fill(false);
  const correctedAlphas = new Array<number>(n).fill(0);

  // Find the largest k such that p(k) <= (k/n) * alpha
  let maxK = -1;
  for (let k = 0; k < n; k++) {
    const bhThreshold = ((k + 1) / n) * alpha;
    correctedAlphas[indexed[k]!.i] = bhThreshold;
    if (indexed[k]!.p <= bhThreshold) {
      maxK = k;
    }
  }

  // Reject all hypotheses up to maxK
  if (maxK >= 0) {
    for (let k = 0; k <= maxK; k++) {
      rejected[indexed[k]!.i] = true;
    }
  }

  return { correctedAlphas, rejected };
}

// Re-export for testing
export { inverseNormalCDF as _inverseNormalCDF };
