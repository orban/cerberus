import type { UndefinedAgreementReason } from "./calibration.js";
import type { RectifierEstimate, RectifierInterval } from "./correction.js";
import type { ConfidenceSequenceState } from "./sequence.js";

// ── Trial types ──────────────────────────────────────────────

export interface TrialMeta {
  readonly raw: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly jsonParsed: boolean;
}

export interface TrialOutput {
  readonly meta: TrialMeta;
  readonly parsed: Readonly<Record<string, unknown>>;
}

// ── Contract types ───────────────────────────────────────────

export type ContractStatus = "pass" | "fail" | "error";

export interface ContractVerdict {
  readonly contractName: string;
  readonly status: ContractStatus;
  readonly error?: string;
  readonly reasoning?: string; // judge reasoning (judge contracts only)
}

export interface TrialResult {
  readonly trialIndex: number;
  readonly output: TrialOutput;
  readonly verdicts: readonly ContractVerdict[];
  readonly durationMs: number;
}

// ── SPRT types ───────────────────────────────────────────────

export type SPRTDecision = "continue" | "accept" | "reject";

export interface SPRTState {
  readonly logLR: number;
  readonly observations: number;
  readonly successes: number;
  readonly decision: SPRTDecision;
  readonly upperBoundary: number;
  readonly lowerBoundary: number;
}

export interface SPRTConfig {
  readonly p0: number; // null hypothesis (threshold)
  readonly p1: number; // alternative hypothesis
  readonly alpha: number; // Type I error rate
  readonly beta: number; // Type II error rate
}

// ── Stats types ──────────────────────────────────────────────

export interface ConfidenceInterval {
  readonly lower: number;
  readonly upper: number;
  readonly center: number;
  readonly n: number;
}

// ── Calibrated sequential state (KTD4) ───────────────────────
// Judge contracts backed by a gold set get their own sequential state rather
// than an extended `SPRTState`. `SPRTState` carries Wald boundaries and a
// two-way decision; it has no vocabulary for a calibration floor or for a
// stop that is terminal without being decisive. Code contracts and
// uncalibrated judge contracts keep the SPRT path untouched.

/**
 * `inconclusive` is the third TERMINAL value `SPRTDecision` lacks: the
 * contract has stopped and will observe nothing further, but neither side of
 * the threshold was established. Everything that is not `continue` is
 * terminal, so the runner's existing `decision !== "continue"` skip freezes a
 * stopped judge contract through the same branch that freezes a decided SPRT.
 */
export type ContractDecision = "continue" | "accept" | "reject" | "inconclusive";

/**
 * How a calibrated contract stopped (R9). The two inconclusive reasons are a
 * diagnosis, not a label: `label-limited` means the calibration interval alone
 * straddles the threshold, so only more gold labels can resolve it;
 * `sampling-limited` means the budget ran out while a decision was still
 * reachable, so more trials would.
 */
export type ContractStopReason =
  | "decisive"
  | "label-limited"
  | "sampling-limited";

export interface CalibratedState {
  /** The sampling term: shrinks with trials. */
  readonly sequence: ConfidenceSequenceState;
  /** The calibration term on `delta`. Fixed for the run; trials never shrink it. */
  readonly calibration: RectifierInterval;
  /** The rectifier's point estimate: corrected = judged + delta. */
  readonly delta: number;
  readonly decision: ContractDecision;
  /** Set exactly when `decision !== "continue"`. */
  readonly stopReason: ContractStopReason | null;
  /** Non-error trials folded in. Error verdicts advance nothing (KTD8). */
  readonly observations: number;
  readonly judgedSuccesses: number;
  /** The corrected interval: sampling + calibration, summed on endpoints. */
  readonly interval: ConfidenceInterval;
}

// ── Contract result (post-SPRT aggregation) ──────────────────

export interface ContractResult {
  readonly contractName: string;
  readonly status: "pass" | "fail" | "inconclusive";
  /**
   * For a calibrated judge contract this is the BIAS-CORRECTED true-rate
   * estimate (R4), not the judged rate; `judgedRate` carries the raw figure.
   * For every other contract it is the observed pass rate, unchanged.
   */
  readonly observedRate: number;
  readonly ci: ConfidenceInterval;
  readonly trialsEvaluated: number;
  readonly sprtStoppedEarly: boolean;
  readonly correctedAlpha?: number;
  /**
   * Judge contracts only, so a code contract's result shape is untouched.
   * `false` marks a judge contract running on the raw judged rate for want of
   * a usable gold set.
   */
  readonly calibrated?: boolean;
  /** Calibrated contracts only. Absent while a contract never stopped. */
  readonly stopReason?: ContractStopReason;
  /** Calibrated contracts only: the raw rate the judge said pass at. */
  readonly judgedRate?: number;
  /**
   * Whether this contract may drive the exit code (R6, R11, KTD7). Code
   * contracts are exact oracles and are always `true`; a judge contract is
   * `true` only with an unmarked gold set and a `pass` certification.
   *
   * An advisory contract still reports the verdict it would have had — it is
   * simply excluded from the suite-status rollup and from the
   * multiple-comparison family, so it never spends alpha budget either.
   */
  readonly gating: boolean;
  /**
   * Why the contract runs advisory (R12). Present and non-empty exactly when
   * `gating` is false; absent otherwise. Ordered as evaluated, and genuinely
   * multi-valued — an undersized gold set is both marked and uncertifiable.
   */
  readonly advisoryReasons?: readonly AdvisoryReason[];
  /** Human-labelled entries backing this contract. Absent with no gold set. */
  readonly goldSetSize?: number;
  /**
   * Gold-set entries carrying BOTH a human label and a judge verdict — the
   * count undersize is actually measured on, since a scenario the judge never
   * ruled on certifies nothing. Below `goldSetSize` for a partially-judged gold
   * set, equal to it for a complete one.
   */
  readonly pairedUnits?: number;
  /**
   * R12's estimate: the TOTAL gold-set size that would bring the calibration
   * floor under the gap, not the increment. Compare against `goldSetSize` for
   * the number of additional labels.
   *
   * Three states, all distinct. Present with a number: that many labels would
   * separate the threshold. Present and `null`: the threshold sits exactly on
   * the calibration band's centre, so NO gold-set size separates it — an
   * answer, not a missing value. Absent: the calibration floor is not why this
   * contract is advisory, so the question does not arise.
   */
  readonly labelsNeeded?: number | null;
}

// ── Study & Suite results ────────────────────────────────────

export interface StudyResult {
  readonly studyName: string;
  readonly contractResults: readonly ContractResult[];
  readonly totalTrials: number;
  readonly errorCount: number;
  readonly aborted: boolean;
  readonly durationMs: number;
}

export interface SuiteResult {
  readonly status: "pass" | "fail" | "inconclusive" | "error";
  readonly studies: readonly StudyResult[];
  readonly durationMs: number;
}

// ── Exit codes ───────────────────────────────────────────────

export const EXIT_CODE = {
  PASS: 0,
  FAIL: 1,
  CONFIG_ERROR: 2,
  INCONCLUSIVE: 3,
  RUNTIME_ERROR: 4,
} as const;

export type ExitCode = (typeof EXIT_CODE)[keyof typeof EXIT_CODE];

// ── Gold-set types ───────────────────────────────────────────
// A gold set is human labels over a subset of a judge contract's scenarios,
// used to calibrate the judge against ground truth. Loaded and marked by
// `src/config.ts`; consumed by the calibration/correction units.

export interface GoldSetEntry {
  readonly scenario: string;
  readonly label: "pass" | "fail";
}

export interface GoldSet {
  // The declared sampling mechanism (e.g. "random-sample-of-trial-population").
  // Empty when undeclared -- see GoldSetMarkingReason "unprovenanced".
  readonly provenance: string;
  readonly entries: readonly GoldSetEntry[];
}

// Distinct, machine-readable reasons a gold set cannot support gating.
// A later unit surfaces these to the user alongside human-readable text.
export type GoldSetMarkingReason =
  | "malformed" // content does not match the expected shape
  | "empty" // parsed, but has zero entries
  | "undersized" // below the minimum unit count
  | "unprovenanced"; // no declared sampling mechanism

export interface MarkedGoldSet {
  readonly marked: true;
  readonly reason: GoldSetMarkingReason;
  readonly message: string;
  // Present whenever entries/provenance could be constructed despite the
  // marking (e.g. "undersized", "unprovenanced"); absent for "malformed",
  // where the content could not be parsed into a GoldSet at all.
  readonly goldSet?: GoldSet;
}

export interface UnmarkedGoldSet {
  readonly marked: false;
  readonly goldSet: GoldSet;
}

export type GoldSetLoadResult = UnmarkedGoldSet | MarkedGoldSet;

// Override for how a judge contract's error budget splits between the
// sampling term and the calibration term (see KTD2 in the calibration plan).
// Absent by default; the default split is computed elsewhere from the
// contract's overall alpha.
export interface AlphaSplitConfig {
  readonly alpha_c: number;
  readonly alpha_a: number;
}

// ── Judge certification (R2, R6, R10) ────────────────────────
// Produced by `src/calibration.ts` before the first trial runs. The verdict
// answers "is this judge measured well enough to be believed"; `gatingEligible`
// answers "may it drive the exit code", which is strictly stronger — a marked
// gold set or a calibration floor too wide to separate the threshold refuses a
// judge that certified `pass`.

/** KTD5's pre-committed bands on judge-vs-human α. */
export type CertificationVerdict = "pass" | "marginal" | "fail" | "contestable";

/** Why a judge contract runs advisory. Multiple reasons can hold at once. */
export type GatingIneligibilityReason =
  | "marked-gold-set" // U4 marked the gold set; see `markingReason`
  | "certification" // the verdict is anything but `pass`
  | "calibration-floor"; // R10: the floor alone straddles the threshold

/**
 * Why a contract result runs advisory (R12). Three of the four come straight
 * from `JudgeCertification.ineligibilityReasons`; `no-gold-set` cannot, because
 * a contract with no labels at all is never certified and so has no
 * ineligibility list to read.
 */
export type AdvisoryReason = "no-gold-set" | GatingIneligibilityReason;

/** Percentile bootstrap interval on α, resampling gold-set units. */
export interface AlphaInterval {
  readonly lower: number;
  readonly upper: number;
  readonly confidence: number;
  /** Resamples whose α was defined. The percentiles are taken over these. */
  readonly resamples: number;
}

/**
 * α reported as a diagnostic, never compared as a bare point estimate. `alpha`
 * is `null` exactly when `undefinedReason` is set: an unmeasured judge is not
 * a badly measured one.
 */
export interface AlphaDiagnostics {
  readonly alpha: number | null;
  readonly undefinedReason: UndefinedAgreementReason | null;
  readonly interval: AlphaInterval | null;
  /** Gold-set units carrying both a human label and a judge verdict. */
  readonly pairedUnits: number;
  /** Paired units where the judge and the human differed. */
  readonly disagreements: number;
}

export interface JudgeCertification {
  readonly verdict: CertificationVerdict;
  readonly gatingEligible: boolean;
  /** Empty if and only if `gatingEligible`. Ordered as evaluated. */
  readonly ineligibilityReasons: readonly GatingIneligibilityReason[];
  readonly markingReason: GoldSetMarkingReason | null;
  readonly agreement: AlphaDiagnostics;
  /** Human-labelled entries in the gold set, paired or not. */
  readonly goldSetSize: number;
  /** The rectifier this gold set implies; `null` when no unit was pairable. */
  readonly rectifier: RectifierEstimate | null;
  /** The calibration floor: half the rectifier interval's width. */
  readonly floorHalfWidth: number | null;
  readonly floorStraddlesThreshold: boolean;
  /** The judged rate the calibration band was anchored on. */
  readonly anchorRate: number | null;
  /** Gold-set size that would bring the floor under the gap. R12's estimate. */
  readonly labelsNeeded: number | null;
  readonly threshold: number;
  readonly alphaC: number;
}

// ── Config types (inferred from Zod in config.ts) ────────────
// These are re-exported from config.ts after Zod schema definition.
// This file only contains runtime/domain types.
