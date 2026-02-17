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

// ── Config types (inferred from Zod in config.ts) ────────────
// These are re-exported from config.ts after Zod schema definition.
// This file only contains runtime/domain types.
