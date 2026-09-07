import type { ConfidenceInterval } from "./types.js";

// ── Predictable-plug-in empirical-Bernstein confidence sequence ──
//
// An anytime-valid interval for the mean of a [0,1]-valued stream, following
// Waudby-Smith & Ramdas (JRSS-B 2023, Theorem 2). Unlike the Wilson interval in
// `stats.ts`, this one is valid under per-trial monitoring: you may look after
// every trial and stop whenever you like without inflating the error rate.
//
// VALIDITY ASSUMPTION: trials are independent and identically distributed.
// Shared sandbox state between trials, a warm cache, correlated rate-limit
// failures, or an agent that learns within a run all break the guarantee -- and
// they break it with no numerical symptom. The arithmetic below stays finite and
// the interval stays plausible; it just stops covering at the advertised rate.
// Anything that couples one trial to the next must be eliminated upstream, not
// detected here.

const LAMBDA_CAP = 0.5; // c in (0,1)
const PSI_SERIES_THRESHOLD = 1e-2;
const MU_REGULARIZER = 0.5;
const SIGMA2_REGULARIZER = 0.25;

export interface ConfidenceSequenceState {
  /** Number of observations folded in so far. */
  readonly t: number;
  /** L = log(2 / alphaA). Fixed at construction. */
  readonly logTerm: number;
  /** sum_{i=1..t} lambda_i */
  readonly sumLambda: number;
  /** sum_{i=1..t} lambda_i * X_i */
  readonly sumLambdaX: number;
  /** sum_{i=1..t} (X_i - mu_hat_{i-1})^2 * psi(lambda_i) */
  readonly sumIncrement: number;
  /** sum_{i=1..t} X_i */
  readonly sumX: number;
  /** sum_{i=1..t} (X_i - mu_hat_i)^2 -- note the index differs from sumIncrement */
  readonly sumSquaredDeviation: number;
  /** Running intersection of every interval seen so far, before unit clamping. */
  readonly lower: number;
  readonly upper: number;
  /** lambda_t as actually applied by the most recent update; 0 at t = 0. */
  readonly lastLambda: number;
}

// ── psi ──────────────────────────────────────────────────────
// psi(L) = -log(1 - L) - L = sum_{k>=2} L^k / k.
//
// The closed form is a difference of two nearly-equal quantities: at L = 1e-4 it
// loses roughly five significant digits, and psi feeds every increment in the
// sequence. Below the threshold, use the series directly; above it, use log1p --
// never Math.log(1 - L), which adds its own cancellation before the subtraction.

function psi(lambda: number): number {
  if (lambda < PSI_SERIES_THRESHOLD) {
    return lambda * lambda * (1 / 2 + lambda * (1 / 3 + lambda * (1 / 4 + lambda / 5)));
  }
  return -Math.log1p(-lambda) - lambda;
}

// ── Regularized running moments ──────────────────────────────
// At t = 0 both fall out of the regularizers (1/2 and 1/4), which is why the
// first trial needs no special case.

function muHat(state: ConfidenceSequenceState): number {
  return (MU_REGULARIZER + state.sumX) / (state.t + 1);
}

function sigma2Hat(state: ConfidenceSequenceState): number {
  return (SIGMA2_REGULARIZER + state.sumSquaredDeviation) / (state.t + 1);
}

// ── Tuning parameter ─────────────────────────────────────────
// lambda_t must be a function of X_1..X_{t-1} only -- hence sigma2_hat_{t-1}.
// Predictability is what makes the sequence time-uniform, and violating it has
// no observable symptom, so `tests/sequence.test.ts` perturbs X_t directly.

function nextLambda(state: ConfidenceSequenceState): number {
  const t = state.t + 1;
  const raw = Math.sqrt(
    (2 * state.logTerm) / (sigma2Hat(state) * t * Math.log1p(t)),
  );
  const lambda = Math.min(raw, LAMBDA_CAP);

  // Math.min(NaN, c) is NaN, which then poisons every downstream sum without
  // throwing. Assert the open bounds rather than trusting the minimum.
  if (!(lambda > 0 && lambda <= LAMBDA_CAP)) {
    throw new RangeError(
      `confidence sequence: lambda must lie in (0, ${LAMBDA_CAP}], got ${lambda}`,
    );
  }
  return lambda;
}

// ── Construction and update ──────────────────────────────────

export function createConfidenceSequence(
  alphaA: number,
): ConfidenceSequenceState {
  if (!(alphaA > 0 && alphaA < 1)) {
    throw new RangeError(
      `createConfidenceSequence: alphaA must be in (0,1), got ${alphaA}`,
    );
  }

  return {
    t: 0,
    logTerm: Math.log(2 / alphaA),
    sumLambda: 0,
    sumLambdaX: 0,
    sumIncrement: 0,
    sumX: 0,
    sumSquaredDeviation: 0,
    lower: Number.NEGATIVE_INFINITY,
    upper: Number.POSITIVE_INFINITY,
    lastLambda: 0,
  };
}

export function updateConfidenceSequence(
  state: ConfidenceSequenceState,
  x: number,
): ConfidenceSequenceState {
  if (!(x >= 0 && x <= 1)) {
    throw new RangeError(
      `updateConfidenceSequence: observation must be in [0,1], got ${x}`,
    );
  }

  // Both of these read the state BEFORE the observation is folded in: lambda_t
  // from sigma2_hat_{t-1} (predictability), and the increment from mu_hat_{t-1}.
  const lambda = nextLambda(state);

  // The published increment is 4(X_i - mu_hat_{i-1})^2 * psi_E(lambda_i) with
  // psi_E = psi/4. The constants cancel, so fuse them: materializing both
  // reintroduces a subtraction between near-equal quantities for no benefit.
  const priorDeviation = x - muHat(state);
  const increment = priorDeviation * priorDeviation * psi(lambda);

  const t = state.t + 1;
  const sumX = state.sumX + x;

  // sigma2_hat accumulates deviations from mu_hat_i -- the mean at time i,
  // one index LATER than the increment above. The asymmetry is deliberate:
  // these are different recursions, and conflating them silently voids
  // time-uniform validity without changing anything observable.
  const currentDeviation = x - (MU_REGULARIZER + sumX) / (t + 1);
  const sumSquaredDeviation =
    state.sumSquaredDeviation + currentDeviation * currentDeviation;

  const sumLambda = state.sumLambda + lambda;
  const sumLambdaX = state.sumLambdaX + lambda * x;
  const sumIncrement = state.sumIncrement + increment;

  const center = sumLambdaX / sumLambda;
  const halfWidth = (state.logTerm + sumIncrement) / sumLambda;

  return {
    t,
    logTerm: state.logTerm,
    sumLambda,
    sumLambdaX,
    sumIncrement,
    sumX,
    sumSquaredDeviation,
    lower: Math.max(state.lower, center - halfWidth),
    upper: Math.min(state.upper, center + halfWidth),
    lastLambda: lambda,
  };
}

// ── Reporting ────────────────────────────────────────────────

export function confidenceSequenceInterval(
  state: ConfidenceSequenceState,
): ConfidenceInterval {
  if (state.t === 0) {
    return { lower: 0, upper: 1, center: MU_REGULARIZER, n: 0 };
  }

  const center = state.sumLambdaX / state.sumLambda;

  // Clamp last: endpoint clipping to the support is coverage-preserving, but
  // clipping earlier would corrupt the running intersection it feeds.
  return {
    lower: Math.min(1, Math.max(0, state.lower)),
    upper: Math.min(1, Math.max(0, state.upper)),
    center: Math.min(1, Math.max(0, center)),
    n: state.t,
  };
}

// Re-exports for testing
export {
  psi as _psi,
  muHat as _muHat,
  sigma2Hat as _sigma2Hat,
  nextLambda as _nextLambda,
  LAMBDA_CAP as _LAMBDA_CAP,
};
