import { z } from "zod";
import type {
  ChangeSet,
  Claim,
  ClaimSeverity,
  RiskFinding,
} from "./types.js";
import { redactSecrets } from "./detectors.js";
import { getProvider, getEnvVar, type ProviderFn } from "../providers.js";

// ── Options ──────────────────────────────────────────────────

export type LlmContentMode = "hunks" | "minimal";

export interface ClaimOptions {
  readonly noLlm?: boolean;
  readonly model?: string;
  readonly llmContent?: LlmContentMode;
  // Injectable for tests; defaults to the shared provider client.
  readonly callModel?: ProviderFn;
  readonly warn?: (message: string) => void;
}

export const DEFAULT_CLAIM_MODEL = "claude-sonnet-5";

const MAX_PROMPT_CHARS = 10_000;

// ── Prompt ───────────────────────────────────────────────────

export function buildClaimPrompt(
  changeSet: ChangeSet,
  findings: readonly RiskFinding[],
  mode: LlmContentMode = "hunks",
): string {
  const description = changeSet.description?.trim()
    ? redactSecrets(changeSet.description)
    : "(none provided)";

  const subjects = changeSet.commitSubjects.slice(0, 20).join("\n") || "(none)";

  const findingLines =
    findings
      .map((f) => `- [${f.severity}] ${f.category}: ${f.explanation} (${f.files.join(", ")})`)
      .join("\n") || "(none)";

  const fileLines = changeSet.files
    .map((f) => `${f.status} ${f.path} (+${f.additions}/-${f.deletions})`)
    .join("\n");

  let digest = `## Changed Files\n${fileLines}`;
  if (mode === "hunks") {
    const excerpts: string[] = [];
    for (const f of changeSet.files) {
      if (f.isBinary || f.hunks.length === 0) continue;
      const body = f.hunks
        .flatMap((h) => [
          ...h.added.map((l) => `+ ${l}`),
          ...h.removed.map((l) => `- ${l}`),
        ])
        .slice(0, 40)
        .join("\n");
      excerpts.push(`### ${f.path}\n${redactSecrets(body)}`);
    }
    digest += `\n\n## Diff Excerpts\n${excerpts.join("\n\n")}`;
  }
  if (digest.length > MAX_PROMPT_CHARS) {
    digest = digest.slice(0, MAX_PROMPT_CHARS) + "\n... (truncated)";
  }

  return `You are analyzing a proposed software change to extract falsifiable behavioral claims.

## Task Description
${description}

## Commit Subjects
${subjects}

## Deterministic Risk Findings
${findingLines}

${digest}

## Instructions

Produce the behavioral claims this change makes. Distinguish what changes (kind "behavior-change") from what must remain unchanged (kind "invariant-preserved"). Prefer precise, falsifiable statements. If intent cannot be inferred from the material above, say so via a claim with "intent unknown" in its text — never invent intent.

Respond with ONLY a JSON array in this exact format:

\`\`\`json
[
  {
    "text": "Unauthenticated requests to /admin continue to return 401",
    "kind": "invariant-preserved",
    "components": ["src/auth/guard.ts"],
    "severity_if_false": "critical",
    "suggested_evidence": "integration test exercising /admin without a session"
  }
]
\`\`\`

"kind" is "behavior-change" or "invariant-preserved". "severity_if_false" is one of "low", "medium", "high", "critical".`;
}

// ── Parsing ──────────────────────────────────────────────────

const ClaimItemSchema = z.object({
  text: z.string().min(1),
  kind: z.enum(["behavior-change", "invariant-preserved"]),
  components: z.array(z.string()).default([]),
  severity_if_false: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  suggested_evidence: z.string().optional(),
});

const ClaimsResponseSchema = z.array(ClaimItemSchema).min(1);

export function parseClaimsResponse(raw: string): Claim[] {
  const candidates = [
    raw.trim(),
    raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)?.[1]?.trim(),
    raw.match(/\[[\s\S]*\]/)?.[0]?.trim(),
  ].filter((c): c is string => c !== undefined && c.length > 0);

  for (const candidate of candidates) {
    try {
      const parsed = ClaimsResponseSchema.parse(JSON.parse(candidate));
      return parsed.map((item, i) => ({
        id: `c${i + 1}`,
        text: item.text,
        kind: item.kind,
        components: item.components,
        severityIfFalse: item.severity_if_false,
        confidence: "llm" as const,
        ...(item.suggested_evidence !== undefined
          ? { suggestedEvidence: item.suggested_evidence }
          : {}),
      }));
    } catch {
      // try next strategy
    }
  }
  throw new Error(`Could not parse claims from response: ${raw.slice(0, 200)}`);
}

// ── Deterministic fallback ───────────────────────────────────

const FINDING_SEVERITY_TO_CLAIM: Record<string, ClaimSeverity> = {
  info: "low",
  warning: "medium",
  critical: "critical",
};

export function deterministicClaims(
  changeSet: ChangeSet,
  findings: readonly RiskFinding[],
): Claim[] {
  const claims: Claim[] = [];
  let n = 0;

  for (const finding of findings) {
    if (finding.category === "unrelated-changes") continue;
    n++;
    claims.push({
      id: `c${n}`,
      text: `Change affects ${finding.category.replace("-", " ")} surface: ${finding.explanation}`,
      kind: "behavior-change",
      components: finding.files,
      severityIfFalse: FINDING_SEVERITY_TO_CLAIM[finding.severity] ?? "medium",
      confidence: "deterministic",
    });
  }

  if (!changeSet.description?.trim()) {
    n++;
    claims.push({
      id: `c${n}`,
      text: "Intent unknown: no task description was provided and no LLM analysis ran. Behavioral intent could not be inferred.",
      kind: "behavior-change",
      components: [],
      // Fixed low severity: renders in the report but can never drive
      // needs-evidence on its own (see policy materiality definition).
      severityIfFalse: "low",
      confidence: "unknown",
    });
  }

  return claims;
}

// ── Generation ───────────────────────────────────────────────

export async function generateClaims(
  changeSet: ChangeSet,
  findings: readonly RiskFinding[],
  options: ClaimOptions = {},
): Promise<Claim[]> {
  const warn = options.warn ?? ((m: string) => process.stderr.write(`${m}\n`));
  const model = options.model ?? DEFAULT_CLAIM_MODEL;

  if (options.noLlm) {
    return deterministicClaims(changeSet, findings);
  }

  let call = options.callModel;
  if (!call) {
    const provider = getProvider(model);
    if (!provider || !getEnvVar(provider.name)) {
      warn(
        `No API key for model ${model} — generating deterministic claims only (pass --no-llm to silence).`,
      );
      return deterministicClaims(changeSet, findings);
    }
    call = provider.call;
  }

  const prompt = buildClaimPrompt(changeSet, findings, options.llmContent ?? "hunks");

  try {
    const raw = await call(prompt, model);
    return parseClaimsResponse(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    warn(`LLM claim generation failed (${msg}) — falling back to deterministic claims.`);
    return deterministicClaims(changeSet, findings);
  }
}
