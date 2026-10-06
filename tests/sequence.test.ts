import { describe, it, expect } from "vitest";
import {
  createConfidenceSequence,
  updateConfidenceSequence,
  confidenceSequenceInterval,
  _psi,
  _muHat,
  _sigma2Hat,
  _nextLambda,
  _LAMBDA_CAP,
} from "../src/sequence.js";
import type { ConfidenceSequenceState } from "../src/sequence.js";

// ── Deterministic PRNG ───────────────────────────────────────
// `Math.random()` would make the coverage simulation non-reproducible: a
// failure could not be replayed and a flaky pass would hide an under-covering
// interval. mulberry32 is a 32-bit state generator, seeded per test.

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function feed(
  state: ConfidenceSequenceState,
  observations: readonly number[],
): ConfidenceSequenceState {
  return observations.reduce(
    (acc, x) => updateConfidenceSequence(acc, x),
    state,
  );
}

// ── psi ──────────────────────────────────────────────────────

describe("psi", () => {
  it("matches a high-precision reference at lambda = 1e-6", () => {
    // psi(L) = sum_{k>=2} L^k / k. At L = 1e-6 the first two terms already
    // exhaust double precision: 5e-13 + 3.3333...e-19.
    const lambda = 1e-6;
    const reference = 5e-13 + 1e-18 / 3;

    const relativeError = Math.abs(_psi(lambda) - reference) / reference;
    expect(relativeError).toBeLessThan(1e-12);
  });

  it("beats the naive -log(1 - L) - L form at lambda = 1e-6", () => {
    // The naive difference form loses ~5 significant digits here. This test
    // exists so a regression back to it is caught rather than silently
    // degrading every increment in the sequence.
    const lambda = 1e-6;
    const reference = 5e-13 + 1e-18 / 3;
    const naive = -Math.log(1 - lambda) - lambda;

    const naiveError = Math.abs(naive - reference) / reference;
    const actualError = Math.abs(_psi(lambda) - reference) / reference;

    expect(naiveError).toBeGreaterThan(1e-6);
    expect(actualError).toBeLessThan(naiveError / 1e6);
  });

  it("uses the log1p form above the series threshold", () => {
    // At lambda = 0.5 (the cap) cancellation is not a concern and the closed
    // form is exact to machine precision.
    expect(_psi(0.5)).toBeCloseTo(-Math.log1p(-0.5) - 0.5, 15);
    expect(_psi(0.5)).toBeCloseTo(0.19314718055994531, 15);
  });

  it("is continuous across the series/log1p threshold", () => {
    // The series is truncated after the L^5 term, so at the 1e-2 threshold the
    // two branches disagree by roughly L^4/3 ~ 3e-9 relative. Anything larger
    // means the threshold or the series moved.
    const below = _psi(1e-2 - 1e-12);
    const above = _psi(1e-2 + 1e-12);
    expect(Math.abs(above - below) / above).toBeLessThan(1e-8);
  });

  it("returns 0 at lambda = 0 and is positive for lambda > 0", () => {
    expect(_psi(0)).toBe(0);
    expect(_psi(1e-8)).toBeGreaterThan(0);
    expect(_psi(0.25)).toBeGreaterThan(0);
  });
});

// ── Initial state (t = 0 regularizers) ───────────────────────

describe("createConfidenceSequence", () => {
  it("derives t=0 state from the regularizers, not a special-cased first trial", () => {
    const state = createConfidenceSequence(0.05);

    expect(state.t).toBe(0);
    expect(state.sumX).toBe(0);
    expect(state.sumSquaredDeviation).toBe(0);
    expect(state.sumLambda).toBe(0);
    expect(state.sumLambdaX).toBe(0);
    expect(state.sumIncrement).toBe(0);

    // mu_hat_0 = (1/2 + 0) / (0 + 1) = 1/2 and sigma2_hat_0 = (1/4 + 0) / 1.
    expect(_muHat(state)).toBe(0.5);
    expect(_sigma2Hat(state)).toBe(0.25);
  });

  it("sets L = log(2 / alphaA)", () => {
    expect(createConfidenceSequence(0.05).logTerm).toBeCloseTo(
      Math.log(2 / 0.05),
      12,
    );
  });

  it("returns the whole unit interval before any observation", () => {
    const ci = confidenceSequenceInterval(createConfidenceSequence(0.05));
    expect(ci.lower).toBe(0);
    expect(ci.upper).toBe(1);
    expect(ci.center).toBe(0.5);
    expect(ci.n).toBe(0);
    expect(Number.isNaN(ci.center)).toBe(false);
  });

  it("rejects an alphaA outside (0, 1)", () => {
    expect(() => createConfidenceSequence(0)).toThrow(RangeError);
    expect(() => createConfidenceSequence(1)).toThrow(RangeError);
    expect(() => createConfidenceSequence(Number.NaN)).toThrow(RangeError);
  });
});

// ── Predictability of the tuning parameter ───────────────────

describe("lambda predictability", () => {
  it("is unchanged when the observation at trial t is perturbed", () => {
    // lambda_t must be a function of X_1..X_{t-1} only. If the implementation
    // reaches for sigma2_hat_t or mu_hat_t instead of their t-1 versions, the
    // sequence silently loses time-uniform validity: nothing throws, the
    // interval just under-covers. Perturbing X_t is the only way to see it.
    const pattern = [1, 0, 1, 1, 0, 1, 1, 1, 0, 1, 0, 0, 1, 1, 1, 0, 1, 1, 1, 0];
    const history = [...pattern, ...pattern, ...pattern];
    const before = feed(createConfidenceSequence(0.05), history);

    const withZero = updateConfidenceSequence(before, 0);
    const withOne = updateConfidenceSequence(before, 1);
    const withHalf = updateConfidenceSequence(before, 0.5);

    expect(withZero.lastLambda).toBe(withOne.lastLambda);
    expect(withZero.lastLambda).toBe(withHalf.lastLambda);

    // The history must be long enough that lambda has fallen off the cap --
    // otherwise every branch clips to c and the equality above is vacuous.
    expect(withZero.lastLambda).toBeLessThan(_LAMBDA_CAP);

    // ...and the downstream sums do differ, proving the observation was used
    // at all and the equality above is not vacuous.
    expect(withZero.sumLambdaX).not.toBe(withOne.sumLambdaX);
  });

  it("holds at every step of a stream, not just one", () => {
    const rand = mulberry32(20260907);
    let state = createConfidenceSequence(0.05);

    for (let i = 0; i < 200; i++) {
      const lambdaIfZero = updateConfidenceSequence(state, 0).lastLambda;
      const lambdaIfOne = updateConfidenceSequence(state, 1).lastLambda;
      expect(lambdaIfZero).toBe(lambdaIfOne);

      state = updateConfidenceSequence(state, rand() < 0.8 ? 1 : 0);
    }
  });

  it("exposes the same lambda the update actually applied", () => {
    const state = feed(createConfidenceSequence(0.05), [1, 0, 1, 1, 0]);
    expect(updateConfidenceSequence(state, 1).lastLambda).toBe(
      _nextLambda(state),
    );
  });

  it("clips lambda_1 to the cap rather than special-casing the first trial", () => {
    // With sigma2_hat_0 = 1/4 and t = 1 the raw lambda is ~20, so the cap is
    // the operative value. That is correct behaviour, not a degenerate case.
    const state = createConfidenceSequence(0.05);
    expect(_nextLambda(state)).toBe(_LAMBDA_CAP);
    expect(updateConfidenceSequence(state, 1).lastLambda).toBe(_LAMBDA_CAP);
  });

  it("keeps lambda strictly inside (0, c] at every step", () => {
    const rand = mulberry32(4242);
    let state = createConfidenceSequence(0.01);

    for (let i = 0; i < 500; i++) {
      state = updateConfidenceSequence(state, rand() < 0.5 ? 1 : 0);
      expect(state.lastLambda).toBeGreaterThan(0);
      expect(state.lastLambda).toBeLessThanOrEqual(_LAMBDA_CAP);
      expect(Number.isFinite(state.lastLambda)).toBe(true);
    }
  });
});

// ── The mu_hat index asymmetry ───────────────────────────────
// `sumIncrement` sums (X_i - mu_hat_{i-1})^2 while `sumSquaredDeviation` sums
// (X_i - mu_hat_i)^2 -- the mean one index later. These are different
// recursions and swapping either one voids time-uniform validity while every
// coverage, width, and NaN check above still passes. Only a direct numerical
// pin catches it, so these two tests carry the whole guarantee.

/** Literal transcription of the published recursions, O(t) and array-based. */
function referenceState(observations: readonly number[], alphaA: number) {
  const logTerm = Math.log(2 / alphaA);
  const xs: number[] = [];

  // mu_hat_i over the first i observations.
  const muHatAt = (i: number) =>
    (0.5 + xs.slice(0, i).reduce((a, b) => a + b, 0)) / (i + 1);

  // sigma2_hat_i, whose deviations are taken against mu_hat_k at each k.
  const sigma2HatAt = (i: number) => {
    let acc = 0;
    for (let k = 1; k <= i; k++) {
      acc += (xs[k - 1]! - muHatAt(k)) ** 2;
    }
    return (0.25 + acc) / (i + 1);
  };

  let sumLambda = 0;
  let sumLambdaX = 0;
  let sumIncrement = 0;
  let sumSquaredDeviation = 0;

  for (let t = 1; t <= observations.length; t++) {
    const x = observations[t - 1]!;
    xs.push(x);

    const lambda = Math.min(
      Math.sqrt((2 * logTerm) / (sigma2HatAt(t - 1) * t * Math.log(1 + t))),
      _LAMBDA_CAP,
    );

    sumIncrement += (x - muHatAt(t - 1)) ** 2 * _psi(lambda);
    sumSquaredDeviation += (x - muHatAt(t)) ** 2;
    sumLambda += lambda;
    sumLambdaX += lambda * x;
  }

  return { sumLambda, sumLambdaX, sumIncrement, sumSquaredDeviation };
}

describe("index asymmetry", () => {
  it("uses mu_hat_{t-1} for the increment and mu_hat_t for sigma2_hat at t=1", () => {
    // Hand-computed. mu_hat_0 = 1/2 and lambda_1 clips to c = 1/2, so
    //   increment_1 = (1 - 1/2)^2 * psi(1/2) = 0.25 * 0.1931471805599453
    // while mu_hat_1 = (1/2 + 1)/2 = 3/4, so
    //   sumSquaredDeviation = (1 - 3/4)^2 = 0.0625.
    // Swapping either index changes exactly one of these two numbers.
    const state = updateConfidenceSequence(createConfidenceSequence(0.05), 1);

    expect(state.sumIncrement).toBeCloseTo(0.25 * 0.1931471805599453, 15);
    expect(state.sumSquaredDeviation).toBeCloseTo(0.0625, 15);
  });

  it("matches an independent transcription of both recursions over a stream", () => {
    const rand = mulberry32(31337);
    const observations = Array.from({ length: 120 }, () =>
      rand() < 0.7 ? 1 : 0,
    );

    const state = feed(createConfidenceSequence(0.05), observations);
    const reference = referenceState(observations, 0.05);

    expect(state.sumIncrement).toBeCloseTo(reference.sumIncrement, 12);
    expect(state.sumSquaredDeviation).toBeCloseTo(
      reference.sumSquaredDeviation,
      12,
    );
    expect(state.sumLambda).toBeCloseTo(reference.sumLambda, 12);
    expect(state.sumLambdaX).toBeCloseTo(reference.sumLambdaX, 12);
  });

  it("matches the reference on fractional observations too", () => {
    // Integer 0/1 streams can mask an index error when the two means happen to
    // straddle the observation symmetrically; fractional values do not.
    const rand = mulberry32(90210);
    const observations = Array.from({ length: 80 }, () => rand());

    const state = feed(createConfidenceSequence(0.1), observations);
    const reference = referenceState(observations, 0.1);

    expect(state.sumIncrement).toBeCloseTo(reference.sumIncrement, 12);
    expect(state.sumSquaredDeviation).toBeCloseTo(
      reference.sumSquaredDeviation,
      12,
    );
  });
});

// ── Immutability ─────────────────────────────────────────────

describe("updateConfidenceSequence immutability", () => {
  it("returns a new state and does not mutate its input", () => {
    const state = feed(createConfidenceSequence(0.05), [1, 0, 1]);
    const snapshot = { ...state };

    const next = updateConfidenceSequence(state, 1);

    expect(next).not.toBe(state);
    expect(state).toEqual(snapshot);
    expect(next.t).toBe(state.t + 1);
  });

  it("produces identical output for identical input (no hidden state)", () => {
    const observations = [1, 1, 0, 1, 0, 0, 1, 1];
    const a = feed(createConfidenceSequence(0.05), observations);
    const b = feed(createConfidenceSequence(0.05), observations);
    expect(a).toEqual(b);
  });
});

// ── Coverage ─────────────────────────────────────────────────

describe("coverage", () => {
  it("contains the true mean at every step of a long Bernoulli(0.8) stream", () => {
    const trueMean = 0.8;
    const rand = mulberry32(123456789);
    let state = createConfidenceSequence(0.05);

    for (let i = 0; i < 3000; i++) {
      state = updateConfidenceSequence(state, rand() < trueMean ? 1 : 0);
      const ci = confidenceSequenceInterval(state);
      expect(ci.lower).toBeLessThanOrEqual(trueMean);
      expect(ci.upper).toBeGreaterThanOrEqual(trueMean);
    }
  });

  it("contains the true mean across several rates and seeds", () => {
    for (const [rate, seed] of [
      [0.5, 11],
      [0.95, 22],
      [0.2, 33],
    ] as const) {
      const rand = mulberry32(seed);
      let state = createConfidenceSequence(0.05);

      for (let i = 0; i < 1500; i++) {
        state = updateConfidenceSequence(state, rand() < rate ? 1 : 0);
        const ci = confidenceSequenceInterval(state);
        expect(ci.lower).toBeLessThanOrEqual(rate);
        expect(ci.upper).toBeGreaterThanOrEqual(rate);
      }
    }
  });

  it("concentrates around the true mean as evidence accumulates", () => {
    const rand = mulberry32(987654321);
    let state = createConfidenceSequence(0.05);
    for (let i = 0; i < 3000; i++) {
      state = updateConfidenceSequence(state, rand() < 0.8 ? 1 : 0);
    }

    const ci = confidenceSequenceInterval(state);
    expect(ci.upper - ci.lower).toBeLessThan(0.2);
    expect(ci.center).toBeCloseTo(0.8, 1);
  });
});

// ── Running intersection ─────────────────────────────────────

describe("running intersection", () => {
  it("returns a non-increasing width across trials", () => {
    // The raw PrPl-EB width is not monotone. Without the intersection a
    // threshold-crossing stop would oscillate and the run would stop
    // non-deterministically across identical inputs.
    const rand = mulberry32(555);
    let state = createConfidenceSequence(0.05);
    let previousWidth = 1;

    for (let i = 0; i < 1000; i++) {
      state = updateConfidenceSequence(state, rand() < 0.7 ? 1 : 0);
      const ci = confidenceSequenceInterval(state);
      const width = ci.upper - ci.lower;
      expect(width).toBeLessThanOrEqual(previousWidth);
      previousWidth = width;
    }
  });

  it("never lets an endpoint retreat", () => {
    const rand = mulberry32(777);
    let state = createConfidenceSequence(0.05);
    let previous = confidenceSequenceInterval(state);

    for (let i = 0; i < 800; i++) {
      state = updateConfidenceSequence(state, rand() < 0.35 ? 1 : 0);
      const ci = confidenceSequenceInterval(state);
      expect(ci.lower).toBeGreaterThanOrEqual(previous.lower);
      expect(ci.upper).toBeLessThanOrEqual(previous.upper);
      previous = ci;
    }
  });
});

// ── Degenerate streams ───────────────────────────────────────

describe("degenerate streams", () => {
  it("handles an all-ones stream without NaN or a zero-width interval", () => {
    let state = createConfidenceSequence(0.05);

    for (let i = 1; i <= 50; i++) {
      state = updateConfidenceSequence(state, 1);
      const ci = confidenceSequenceInterval(state);
      expect(Number.isFinite(ci.lower)).toBe(true);
      expect(Number.isFinite(ci.upper)).toBe(true);
      expect(Number.isFinite(ci.center)).toBe(true);
      expect(ci.upper - ci.lower).toBeGreaterThan(0);
    }
  });

  it("handles an all-zeros stream without NaN or a zero-width interval", () => {
    let state = createConfidenceSequence(0.05);

    for (let i = 1; i <= 50; i++) {
      state = updateConfidenceSequence(state, 0);
      const ci = confidenceSequenceInterval(state);
      expect(Number.isFinite(ci.lower)).toBe(true);
      expect(Number.isFinite(ci.upper)).toBe(true);
      expect(ci.upper - ci.lower).toBeGreaterThan(0);
    }
  });

  it("keeps endpoints inside the unit interval", () => {
    let state = createConfidenceSequence(0.05);
    for (let i = 0; i < 100; i++) {
      state = updateConfidenceSequence(state, 1);
      const ci = confidenceSequenceInterval(state);
      expect(ci.lower).toBeGreaterThanOrEqual(0);
      expect(ci.upper).toBeLessThanOrEqual(1);
      expect(ci.center).toBeGreaterThanOrEqual(0);
      expect(ci.center).toBeLessThanOrEqual(1);
    }
  });

  it("accepts fractional observations in [0, 1]", () => {
    const state = feed(createConfidenceSequence(0.05), [0.25, 0.75, 0.5, 0.5]);
    const ci = confidenceSequenceInterval(state);
    expect(Number.isFinite(ci.center)).toBe(true);
    expect(state.t).toBe(4);
  });

  it("rejects observations outside [0, 1] and non-finite ones", () => {
    const state = createConfidenceSequence(0.05);
    expect(() => updateConfidenceSequence(state, 1.5)).toThrow(RangeError);
    expect(() => updateConfidenceSequence(state, -0.1)).toThrow(RangeError);
    expect(() => updateConfidenceSequence(state, Number.NaN)).toThrow(
      RangeError,
    );
  });
});
