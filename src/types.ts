import type { UndefinedAgreementReason } from "./calibration.js";
import type { RectifierEstimate } from "./correction.js";

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

// ── Contract result (post-SPRT aggregation) ──────────────────

export interface ContractResult {
  readonly contractName: string;
  readonly status: "pass" | "fail" | "inconclusive";
  readonly observedRate: number;
  readonly ci: ConfidenceInterval;
  readonly trialsEvaluated: number;
  readonly sprtStoppedEarly: boolean;
  readonly correctedAlpha?: number;
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
