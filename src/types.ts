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

// ── Config types (inferred from Zod in config.ts) ────────────
// These are re-exported from config.ts after Zod schema definition.
// This file only contains runtime/domain types.
