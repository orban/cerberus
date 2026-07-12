import { join } from "node:path";
import { persistTimestampedJson } from "../output.js";
import type { CheckResult, EvaluatedClaim } from "./types.js";

// ── Markdown report (PRD §8.7 section order) ─────────────────

const EXECUTION_LABEL = "statically mapped — execution not verified";

function claimSeverityRank(claim: EvaluatedClaim): number {
  const order = { critical: 0, high: 1, medium: 2, low: 3 } as const;
  return order[claim.claim.severityIfFalse];
}

export function renderMarkdown(result: CheckResult): string {
  const lines: string[] = [];

  // 1. Verdict
  lines.push(`# Cerberus Check: ${result.verdict.toUpperCase()}`);
  lines.push("");
  lines.push(`Range: \`${result.range}\``);
  if (result.noChanges) {
    lines.push("");
    lines.push(`> No changes analyzed for range \`${result.range}\`. Verify the range if you expected changes.`);
  }
  if (result.override) {
    lines.push("");
    lines.push(
      `> **Override:** ${result.override.owner} accepted verdict \`${result.override.overriddenVerdict}\` — ${result.override.rationale}`,
    );
  }
  if (result.reasons.length > 0) {
    lines.push("");
    for (const reason of result.reasons) {
      lines.push(`- \`${reason.ruleId}\`: ${reason.message}`);
    }
  }

  // 2. Highest-risk unsupported claims
  lines.push("");
  lines.push("## Highest-Risk Unsupported Claims");
  const unsupported = result.claims
    .filter((c) => c.status === "unsupported")
    .sort((a, b) => claimSeverityRank(a) - claimSeverityRank(b));
  if (unsupported.length === 0) {
    lines.push("");
    lines.push("None.");
  } else {
    lines.push("");
    for (const c of unsupported.slice(0, 5)) {
      lines.push(`- [${c.claim.severityIfFalse}] ${c.claim.text}`);
    }
  }

  // 3. Claims and evidence status
  lines.push("");
  lines.push("## Claims");
  lines.push("");
  if (result.claims.length === 0) {
    lines.push("None.");
  } else {
    lines.push("| Claim | Kind | Severity if false | Status | Evidence |");
    lines.push("|---|---|---|---|---|");
    for (const c of result.claims) {
      const evidence =
        c.links.length === 0
          ? "—"
          : c.links
              .map(
                (l) =>
                  `${l.artifact.file}${l.artifact.testName ? ` ("${l.artifact.testName}")` : ""} [${l.directness}${l.independent ? "" : ", non-independent"}${l.artifact.skipMarked ? ", skip-marked" : ""}]`,
              )
              .join("<br>");
      lines.push(
        `| ${c.claim.text.replace(/\|/g, "\\|")} | ${c.claim.kind} | ${c.claim.severityIfFalse} | ${c.status} | ${evidence} |`,
      );
    }
    lines.push("");
    lines.push(`_All evidence is ${EXECUTION_LABEL}._`);
  }

  // 4. Affected invariants
  lines.push("");
  lines.push("## Affected Invariants");
  const affected = result.invariants.filter((i) => i.affected);
  lines.push("");
  if (affected.length === 0) {
    lines.push("None.");
  } else {
    for (const inv of affected) {
      lines.push(
        `- **${inv.name}** (${inv.severity}): ${inv.matchedFiles.join(", ")} — ${
          inv.evidenced ? "evidence present" : inv.requiresEvidence ? "requires evidence, none qualifies" : "no evidence required"
        }`,
      );
    }
  }

  // 5. Split recommendation
  lines.push("");
  lines.push("## Split Recommendation");
  const clustering = result.findings.find((f) => f.category === "unrelated-changes");
  lines.push("");
  if (!clustering?.clusters) {
    lines.push("None — change reads as a single concern.");
  } else {
    lines.push(clustering.explanation);
    lines.push("");
    clustering.clusters.forEach((cluster, i) => {
      lines.push(`- Cluster ${i + 1}: ${cluster.join(", ")}`);
    });
  }

  // 6. Rollback status
  lines.push("");
  lines.push("## Rollback Status");
  lines.push("");
  lines.push(
    result.rollback.relevant
      ? `${result.rollback.detected ? "Detected" : "**Not detected**"} — ${result.rollback.explanation}`
      : result.rollback.explanation,
  );

  // 7. Evidence details (risk findings)
  lines.push("");
  lines.push("## Risk Findings");
  lines.push("");
  if (result.findings.length === 0) {
    lines.push("None.");
  } else {
    for (const f of result.findings) {
      lines.push(`- [${f.severity}/${f.confidence}-confidence] **${f.category}**: ${f.explanation}`);
      lines.push(`  - Files: ${f.files.join(", ")}`);
      if (f.evidence && f.evidence.length > 0) {
        for (const e of f.evidence.slice(0, 3)) {
          lines.push(`  - \`${e.trim().slice(0, 120)}\``);
        }
      }
    }
  }

  lines.push("");
  return lines.join("\n");
}

// ── JSON output ──────────────────────────────────────────────

export function renderJson(result: CheckResult): string {
  return JSON.stringify(
    {
      version: 1,
      range: result.range,
      verdict: result.verdict,
      effectiveExitCode: result.effectiveExitCode,
      noChanges: result.noChanges,
      reasons: result.reasons,
      claims: result.claims.map((c) => ({
        id: c.claim.id,
        text: c.claim.text,
        kind: c.claim.kind,
        components: c.claim.components,
        severityIfFalse: c.claim.severityIfFalse,
        confidence: c.claim.confidence,
        status: c.status,
        evidence: c.links.map((l) => ({
          file: l.artifact.file,
          testName: l.artifact.testName ?? null,
          directness: l.directness,
          independent: l.independent,
          skipMarked: l.artifact.skipMarked,
          execution: l.execution,
        })),
      })),
      findings: result.findings.map((f) => ({
        category: f.category,
        severity: f.severity,
        confidence: f.confidence,
        files: f.files,
        explanation: f.explanation,
        clusters: f.clusters ?? null,
      })),
      invariants: result.invariants,
      rollback: result.rollback,
      override: result.override ?? null,
      durationMs: Math.round(result.durationMs),
    },
    null,
    2,
  );
}

// ── Persistence ──────────────────────────────────────────────

export async function persistCheck(
  result: CheckResult,
  cwd: string,
): Promise<string> {
  return persistTimestampedJson(join(cwd, ".cerberus", "checks"), renderJson(result));
}
