import { z } from "zod";
import { loadYamlValidated } from "../config.js";
import type {
  ChangeSet,
  CheckVerdict,
  EvaluatedClaim,
  EvidenceLink,
  InvariantStatus,
  PolicyReason,
  RiskFinding,
  RollbackStatus,
} from "./types.js";

// ── Schema ───────────────────────────────────────────────────

const InvariantSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  paths: z.array(z.string().min(1)).min(1),
  requires_evidence: z.boolean().default(true),
  severity: z.enum(["low", "medium", "high", "critical"]).default("critical"),
});

const PolicySchema = z.object({
  version: z.literal(1),
  thresholds: z
    .object({
      max_unrelated_clusters: z.number().int().min(1).default(2),
    })
    .default({}),
  rules: z
    .object({
      // Advisory-first defaults: block rules ship off and only warn until a
      // repo policy flips them on (PRD Phase 1 posture).
      block_destructive_migration_without_rollback: z.boolean().default(false),
      block_permission_change_without_auth_test: z.boolean().default(false),
      block_critical_claim_without_direct_evidence: z.boolean().default(false),
    })
    .default({}),
  invariants: z.array(InvariantSchema).default([]),
});

export type PolicyConfig = z.infer<typeof PolicySchema>;

export const DEFAULT_POLICY: PolicyConfig = PolicySchema.parse({ version: 1 });

export async function loadPolicy(path: string): Promise<PolicyConfig> {
  return loadYamlValidated(path, PolicySchema, "policy");
}

// ── Glob matching (no new deps: ** and * segments only) ──────

export function matchGlob(pattern: string, path: string): boolean {
  const escapeSegment = (s: string) =>
    s.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");

  const parts = pattern.split("/");
  let regex = "^";
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const last = i === parts.length - 1;
    if (part === "**") {
      regex += last ? ".+" : "(?:[^/]+/)*";
    } else {
      regex += escapeSegment(part) + (last ? "" : "/");
    }
  }
  regex += "$";
  return new RegExp(regex).test(path);
}

// ── Qualifying evidence ──────────────────────────────────────
// A link qualifies for block-level rules only when the test exists in the
// head tree (structural — mapping only draws from real artifacts), is not
// skip-marked, and is independent. Otherwise it counts as proxy.

export function qualifiesForBlock(link: EvidenceLink): boolean {
  return (
    link.directness === "direct" &&
    link.independent &&
    !link.artifact.skipMarked
  );
}

function isMaterial(claim: EvaluatedClaim): boolean {
  return (
    claim.claim.severityIfFalse === "high" ||
    claim.claim.severityIfFalse === "critical"
  );
}

// ── Invariants ───────────────────────────────────────────────

export function evaluateInvariants(
  policy: PolicyConfig,
  changeSet: ChangeSet,
  claims: readonly EvaluatedClaim[],
): InvariantStatus[] {
  return policy.invariants.map((inv) => {
    const matchedFiles = changeSet.files
      .map((f) => f.path)
      .filter((p) => inv.paths.some((glob) => matchGlob(glob, p)));
    const affected = matchedFiles.length > 0;

    // Evidenced when a qualifying link's tokens or path relate to the
    // invariant's matched files, or a changed test overlaps the invariant name.
    const nameTokens = inv.name.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
    const evidenced =
      affected &&
      claims.some((c) =>
        c.links.some((link) => {
          if (!qualifiesForBlock(link)) return false;
          const file = link.artifact.file.toLowerCase();
          const name = (link.artifact.testName ?? "").toLowerCase();
          return (
            nameTokens.some((t) => file.includes(t) || name.includes(t)) ||
            c.claim.components.some((comp) => matchedFiles.includes(comp))
          );
        }),
      );

    return {
      name: inv.name,
      description: inv.description,
      affected,
      matchedFiles,
      requiresEvidence: inv.requires_evidence,
      evidenced,
      severity: inv.severity,
    };
  });
}

// ── Evaluation ───────────────────────────────────────────────

export interface EvaluationInput {
  readonly findings: readonly RiskFinding[];
  readonly claims: readonly EvaluatedClaim[];
  readonly invariants: readonly InvariantStatus[];
  readonly rollback: RollbackStatus;
}

export interface Evaluation {
  readonly verdict: CheckVerdict;
  readonly reasons: readonly PolicyReason[];
}

// Only high-confidence permission findings can block; keyword-only
// (low-confidence) findings stay warning-level.
function permissionBlockReason(
  findings: readonly RiskFinding[],
  claims: readonly EvaluatedClaim[],
): PolicyReason | null {
  const highConfidence = findings.filter(
    (f) => f.category === "permission" && f.confidence === "high",
  );
  if (highConfidence.length === 0) return null;

  const permFiles = new Set(highConfidence.flatMap((f) => f.files));
  const authEvidence = claims.some((c) => {
    const touchesPerm =
      c.claim.components.some((comp) => permFiles.has(comp)) ||
      /\b(auth|permission|role|guard|session)\b/i.test(c.claim.text);
    return touchesPerm && c.links.some(qualifiesForBlock);
  });
  if (authEvidence) return null;

  const downgraded = claims.some((c) =>
    c.links.some((l) => l.directness === "direct" && !qualifiesForBlock(l)),
  );
  return {
    ruleId: "block_permission_change_without_auth_test",
    message: `Permission-sensitive change (${[...permFiles].join(", ")}) has no qualifying auth-test evidence${
      downgraded
        ? " (existing direct evidence downgraded to proxy: non-independent or skip-marked)"
        : ""
    }.`,
  };
}

export function evaluatePolicy(
  policy: PolicyConfig,
  input: EvaluationInput,
): Evaluation {
  const reasons: PolicyReason[] = [];
  const blocks: PolicyReason[] = [];

  // ── Block rules (only when enabled) ──
  if (policy.rules.block_destructive_migration_without_rollback) {
    const destructive = input.findings.filter(
      (f) => f.category === "migration" && f.severity === "critical",
    );
    if (destructive.length > 0 && !input.rollback.detected) {
      blocks.push({
        ruleId: "block_destructive_migration_without_rollback",
        message: `Destructive migration without a detected rollback path (${destructive
          .flatMap((f) => f.files)
          .join(", ")}).`,
      });
    }
  }

  if (policy.rules.block_permission_change_without_auth_test) {
    const reason = permissionBlockReason(input.findings, input.claims);
    if (reason) blocks.push(reason);
  }

  if (policy.rules.block_critical_claim_without_direct_evidence) {
    const failing = input.claims.filter(
      (c) => isMaterial(c) && !c.links.some(qualifiesForBlock),
    );
    if (failing.length > 0) {
      blocks.push({
        ruleId: "block_critical_claim_without_direct_evidence",
        message: `Material claim(s) without qualifying direct evidence: ${failing
          .map((c) => `"${c.claim.text.slice(0, 80)}"`)
          .join("; ")}.`,
      });
    }
  }

  if (blocks.length > 0) {
    return { verdict: "block", reasons: blocks };
  }

  // ── Split-required ──
  const clustering = input.findings.find((f) => f.category === "unrelated-changes");
  if (clustering) {
    reasons.push({
      ruleId: "split_required_unrelated_clusters",
      message: clustering.explanation,
    });
    return { verdict: "split-required", reasons };
  }

  // ── Needs-evidence ──
  const materialUnsupported = input.claims.filter(
    (c) => isMaterial(c) && c.status === "unsupported",
  );
  const unevidencedInvariants = input.invariants.filter(
    (i) => i.affected && i.requiresEvidence && !i.evidenced,
  );
  if (materialUnsupported.length > 0 || unevidencedInvariants.length > 0) {
    for (const c of materialUnsupported) {
      reasons.push({
        ruleId: "needs_evidence_material_claim",
        message: `Material claim has no mapped evidence: "${c.claim.text.slice(0, 100)}".`,
      });
    }
    for (const inv of unevidencedInvariants) {
      reasons.push({
        ruleId: "needs_evidence_invariant",
        message: `Invariant "${inv.name}" is affected (${inv.matchedFiles.join(", ")}) and requires evidence, but none qualifies.`,
      });
    }
    return { verdict: "needs-evidence", reasons };
  }

  // ── Warnings ──
  const warningFindings = input.findings.filter((f) => f.severity !== "info");
  const unsupportedMinor = input.claims.filter((c) => c.status === "unsupported");
  if (warningFindings.length > 0 || unsupportedMinor.length > 0) {
    for (const f of warningFindings) {
      reasons.push({ ruleId: `warn_${f.category}`, message: f.explanation });
    }
    for (const c of unsupportedMinor) {
      reasons.push({
        ruleId: "warn_unsupported_claim",
        message: `Claim has no mapped evidence: "${c.claim.text.slice(0, 100)}".`,
      });
    }
    return { verdict: "pass-with-warnings", reasons };
  }

  return { verdict: "pass", reasons: [] };
}
