#!/usr/bin/env node
// Independent SPRT mathematical oracle.
//
// This file is part of the HIDDEN ORACLE for the PCC validation benchmark.
// It must never be copied into, or made visible to, the repositories given
// to the system under test.
//
// Purpose: derive the correct Wald SPRT boundaries for the likelihood-ratio
// convention actually used by Cerberus, from first principles — NOT from
// Cerberus's implementation, its tests, or the later fix commit — and then
// confirm empirically (fixed-seed Monte Carlo) which of the two historical
// boundary formula pairs controls the advertised error rates.
//
// ── Convention (stated before derivation) ────────────────────────────────
//
// Cerberus's updateSPRT accumulates, per Bernoulli trial:
//
//   success:  logLR += log(p0 / p1)
//   failure:  logLR += log((1 - p0) / (1 - p1))
//
// with p0 = threshold (the "agent is good" rate) and p1 < p0 (the "agent is
// degraded" rate). Since p0 > p1, successes push logLR UP. Therefore the
// statistic is  Λ_n = Π f(x_i | H0) / f(x_i | H1)  — evidence FOR H0
// accumulates upward. H0: p = p0 (meets threshold). H1: p = p1 (degraded).
// "accept" = accept H0 at the upper boundary; "reject" = accept H1 at the
// lower boundary.
//
// ── Derivation ────────────────────────────────────────────────────────────
//
// Wald (1945) states the SPRT in the convention  LR*_n = Π f(x_i|H1)/f(x_i|H0):
//   continue while  B* < LR*_n < A*,  with  A* = (1-β)/α  and  B* = β/(1-α);
//   accept H1 when LR*_n ≥ A*;  accept H0 when LR*_n ≤ B*.
// α = P(accept H1 | H0 true) (Type I), β = P(accept H0 | H1 true) (Type II).
//
// Cerberus uses Λ_n = 1 / LR*_n. Substituting:
//   accept H0  ⇔  LR* ≤ β/(1-α)  ⇔  Λ ≥ (1-α)/β
//   accept H1  ⇔  LR* ≥ (1-β)/α  ⇔  Λ ≤ α/(1-β)
//
// So in Cerberus's convention the CORRECT boundaries are:
//   upper (accept H0):  log((1-α)/β)
//   lower (reject H0):  log(α/(1-β))
//
// The HISTORICAL boundaries under audit are:
//   upper: log((1-β)/α),  lower: log(β/(1-α))
// i.e. Wald's A*/B* used verbatim without inverting the ratio convention.
// Under asymmetric α ≠ β these two pairs differ in BOTH boundaries, so a
// swapped implementation cannot pass this oracle accidentally.

// ── Deterministic PRNG (mulberry32) ──────────────────────────────────────

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Independent Wilson interval (z hardcoded, 95%) ───────────────────────

function wilson95(successes, n) {
  if (n === 0) return { lower: 0, upper: 1 };
  const z = 1.959964;
  const z2 = z * z;
  const p = successes / n;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const spread = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { lower: Math.max(0, center - spread), upper: Math.min(1, center + spread) };
}

// General Wilson interval used only to produce reference constants for the
// benchmark fixtures (case D hand-computed values).
function wilsonAt(successes, n, z) {
  const z2 = z * z;
  const p = successes / n;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const spread = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { lower: center - spread, upper: center + spread };
}

// ── Boundary formula pairs ────────────────────────────────────────────────

function derivedBoundaries(alpha, beta) {
  return {
    upper: Math.log((1 - alpha) / beta),
    lower: Math.log(alpha / (1 - beta)),
  };
}

function historicalBuggyBoundaries(alpha, beta) {
  return {
    upper: Math.log((1 - beta) / alpha),
    lower: Math.log(beta / (1 - alpha)),
  };
}

// ── Independent SPRT walk ────────────────────────────────────────────────

function simulate(pTrue, p0, p1, bounds, maxTrials, rng) {
  const up = Math.log(p0 / p1);
  const down = Math.log((1 - p0) / (1 - p1));
  let llr = 0;
  for (let i = 1; i <= maxTrials; i++) {
    llr += rng() < pTrue ? up : down;
    if (llr >= bounds.upper) return { decision: "accept", n: i };
    if (llr <= bounds.lower) return { decision: "reject", n: i };
  }
  return { decision: "undecided", n: maxTrials };
}

function monteCarlo(pTrue, p0, p1, bounds, reps, maxTrials, seed) {
  const rng = mulberry32(seed);
  let accept = 0, reject = 0, undecided = 0, totalN = 0;
  for (let r = 0; r < reps; r++) {
    const res = simulate(pTrue, p0, p1, bounds, maxTrials, rng);
    totalN += res.n;
    if (res.decision === "accept") accept++;
    else if (res.decision === "reject") reject++;
    else undecided++;
  }
  return {
    accept, reject, undecided, reps,
    acceptRate: accept / reps,
    rejectRate: reject / reps,
    undecidedRate: undecided / reps,
    meanN: totalN / reps,
    rejectCI: wilson95(reject, reps),
    acceptCI: wilson95(accept, reps),
  };
}

// Terminal-direction check: consecutive identical outcomes until decision.
function consecutiveToDecision(outcome, p0, p1, bounds, cap = 10_000) {
  const step = outcome ? Math.log(p0 / p1) : Math.log((1 - p0) / (1 - p1));
  let llr = 0;
  for (let i = 1; i <= cap; i++) {
    llr += step;
    if (llr >= bounds.upper) return { decision: "accept", n: i };
    if (llr <= bounds.lower) return { decision: "reject", n: i };
  }
  return { decision: "none", n: cap };
}

// ── Run ───────────────────────────────────────────────────────────────────

const failures = [];
function check(name, cond, detail) {
  const ok = Boolean(cond);
  if (!ok) failures.push({ name, detail });
  return { name, ok, detail };
}

const REPS = 20_000;
const MAX_TRIALS = 2_000;
const SEED = 0xc0ffee;

// Parameter sets. Asymmetric α/β everywhere; the second set is strongly
// asymmetric so that a swapped-formula implementation differs in both
// boundaries by a wide margin.
const PARAMS = [
  { label: "alpha=0.05, beta=0.20 (cerberus default: threshold .90, confidence .95)", alpha: 0.05, beta: 0.20, p0: 0.90, p1: 0.80 },
  { label: "alpha=0.01, beta=0.20 (confidence .99)", alpha: 0.01, beta: 0.20, p0: 0.90, p1: 0.80 },
];

const report = { convention: "Lambda_n = P(data|H0)/P(data|H1); success pushes UP toward accept-H0", checks: [], params: [] };

for (const P of PARAMS) {
  const derived = derivedBoundaries(P.alpha, P.beta);
  const buggy = historicalBuggyBoundaries(P.alpha, P.beta);

  const entry = {
    label: P.label,
    derived,
    historicalBuggy: buggy,
    terminal: {
      derived: {
        consecutiveSuccessesToAccept: consecutiveToDecision(true, P.p0, P.p1, derived).n,
        consecutiveFailuresToReject: consecutiveToDecision(false, P.p0, P.p1, derived).n,
      },
      buggy: {
        consecutiveSuccessesToAccept: consecutiveToDecision(true, P.p0, P.p1, buggy).n,
        consecutiveFailuresToReject: consecutiveToDecision(false, P.p0, P.p1, buggy).n,
      },
    },
    monteCarlo: {
      derived: {
        atP0_typeI_is_rejectRate: monteCarlo(P.p0, P.p0, P.p1, derived, REPS, MAX_TRIALS, SEED),
        atP1_typeII_is_acceptRate: monteCarlo(P.p1, P.p0, P.p1, derived, REPS, MAX_TRIALS, SEED + 1),
      },
      buggy: {
        atP0_typeI_is_rejectRate: monteCarlo(P.p0, P.p0, P.p1, buggy, REPS, MAX_TRIALS, SEED + 2),
        atP1_typeII_is_acceptRate: monteCarlo(P.p1, P.p0, P.p1, buggy, REPS, MAX_TRIALS, SEED + 3),
      },
      indifferenceZone_p085: monteCarlo(0.85, P.p0, P.p1, derived, REPS, MAX_TRIALS, SEED + 4),
    },
  };

  const dI = entry.monteCarlo.derived.atP0_typeI_is_rejectRate;
  const dII = entry.monteCarlo.derived.atP1_typeII_is_acceptRate;
  const bI = entry.monteCarlo.buggy.atP0_typeI_is_rejectRate;

  report.checks.push(
    check(`[${P.label}] derived != buggy in BOTH boundaries (asymmetry guard)`,
      Math.abs(derived.upper - buggy.upper) > 1e-9 && Math.abs(derived.lower - buggy.lower) > 1e-9,
      { derived, buggy }),
    // Wald's boundary inequalities guarantee alpha' <= alpha/(1-beta) etc.;
    // with a generous truncation allowance we require the empirical Type I of
    // the DERIVED boundaries to be consistent with the advertised alpha.
    check(`[${P.label}] derived boundaries: empirical Type I CI overlaps [0, alpha + 0.01]`,
      dI.rejectCI.lower <= P.alpha + 0.01,
      { empirical: dI.rejectRate, ci: dI.rejectCI, alpha: P.alpha }),
    check(`[${P.label}] derived boundaries: empirical Type II CI overlaps [0, beta + 0.01]`,
      dII.acceptCI.lower <= P.beta + 0.01,
      { empirical: dII.acceptRate, ci: dII.acceptCI, beta: P.beta }),
    check(`[${P.label}] buggy boundaries INFLATE Type I: CI lower bound > 2x alpha`,
      bI.rejectCI.lower > 2 * P.alpha,
      { empirical: bI.rejectRate, ci: bI.rejectCI, alpha: P.alpha }),
  );

  report.params.push(entry);
}

// Reference constants for benchmark fixtures (case B / case D evidence files).
report.fixtureConstants = {
  // alpha=0.05, beta=0.20, p0=.90, p1=.80
  acceptAfterConsecutiveSuccesses_alpha05: report.params[0].terminal.derived.consecutiveSuccessesToAccept,
  rejectAfterConsecutiveFailures_alpha05: report.params[0].terminal.derived.consecutiveFailuresToReject,
  // alpha=0.01, beta=0.20
  acceptAfterConsecutiveSuccesses_alpha01: report.params[1].terminal.derived.consecutiveSuccessesToAccept,
  rejectAfterConsecutiveFailures_alpha01: report.params[1].terminal.derived.consecutiveFailuresToReject,
  wilson_8_of_10_at_95: wilsonAt(8, 10, 1.959964),
  wilson_90_of_100_at_99: wilsonAt(90, 100, 2.575829),
};

report.failures = failures;
report.verdict = failures.length === 0 ? "ORACLE_CONFIRMED" : "ORACLE_FAILED";

process.stdout.write(JSON.stringify(report, null, 2) + "\n");
process.exit(failures.length === 0 ? 0 : 1);
