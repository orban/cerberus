// ── Change collection ────────────────────────────────────────

export type FileStatus = "added" | "modified" | "deleted" | "renamed";

export interface FileHunk {
  readonly header: string;
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

export interface FileChange {
  readonly path: string;
  readonly oldPath?: string;
  readonly status: FileStatus;
  readonly additions: number;
  readonly deletions: number;
  readonly isBinary: boolean;
  readonly isTest: boolean;
  readonly hunks: readonly FileHunk[];
}

export interface ChangeSet {
  readonly baseRef: string;
  readonly headRef: string;
  readonly mergeBase: string;
  readonly rangeLabel: string;
  readonly files: readonly FileChange[];
  readonly commitSubjects: readonly string[];
  readonly description?: string;
}

// ── Risk findings ────────────────────────────────────────────

export type RiskCategory =
  | "migration"
  | "permission"
  | "public-api"
  | "dependency"
  | "infrastructure"
  | "test-integrity"
  | "unrelated-changes"
  | "secret";

export type RiskSeverity = "info" | "warning" | "critical";

export type FindingConfidence = "high" | "low";

export interface RiskFinding {
  readonly category: RiskCategory;
  readonly severity: RiskSeverity;
  readonly confidence: FindingConfidence;
  readonly files: readonly string[];
  readonly explanation: string;
  readonly evidence?: readonly string[];
  readonly clusters?: readonly (readonly string[])[];
}

export interface RollbackStatus {
  readonly relevant: boolean;
  readonly detected: boolean;
  readonly explanation: string;
}

// ── Claims ───────────────────────────────────────────────────

export type ClaimKind = "behavior-change" | "invariant-preserved";

export type ClaimSeverity = "low" | "medium" | "high" | "critical";

export type ClaimConfidence = "llm" | "deterministic" | "unknown";

export type ClaimStatus = "supported" | "unsupported";

export interface Claim {
  readonly id: string;
  readonly text: string;
  readonly kind: ClaimKind;
  readonly components: readonly string[];
  readonly severityIfFalse: ClaimSeverity;
  readonly confidence: ClaimConfidence;
  readonly suggestedEvidence?: string;
}

// ── Evidence ─────────────────────────────────────────────────

export interface EvidenceArtifact {
  readonly file: string;
  readonly testName?: string;
  readonly changedInRange: boolean;
  readonly skipMarked: boolean;
}

export type EvidenceDirectness = "direct" | "proxy";

export interface EvidenceLink {
  readonly artifact: EvidenceArtifact;
  readonly directness: EvidenceDirectness;
  readonly independent: boolean;
  // The MVP maps evidence statically; it never executes tests.
  readonly execution: "not-verified";
  readonly rationale: string;
}

export interface EvaluatedClaim {
  readonly claim: Claim;
  readonly links: readonly EvidenceLink[];
  readonly status: ClaimStatus;
}

// ── Invariants ───────────────────────────────────────────────

export interface InvariantStatus {
  readonly name: string;
  readonly description: string;
  readonly affected: boolean;
  readonly matchedFiles: readonly string[];
  readonly requiresEvidence: boolean;
  readonly evidenced: boolean;
  readonly severity: ClaimSeverity;
}

// ── Verdict & result ─────────────────────────────────────────

export type CheckVerdict =
  | "pass"
  | "pass-with-warnings"
  | "needs-evidence"
  | "split-required"
  | "block";

export interface PolicyReason {
  readonly ruleId: string;
  readonly message: string;
}

export interface OverrideRecord {
  readonly owner: string;
  readonly rationale: string;
  readonly overriddenVerdict: CheckVerdict;
}

export interface CheckResult {
  readonly range: string;
  readonly verdict: CheckVerdict;
  readonly effectiveExitCode: number;
  readonly reasons: readonly PolicyReason[];
  readonly claims: readonly EvaluatedClaim[];
  readonly findings: readonly RiskFinding[];
  readonly invariants: readonly InvariantStatus[];
  readonly rollback: RollbackStatus;
  readonly noChanges: boolean;
  readonly override?: OverrideRecord;
  readonly durationMs: number;
}
