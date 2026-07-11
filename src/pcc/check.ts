import { EXIT_CODE } from "../types.js";
import { ConfigError } from "../errors.js";
import type { CheckResult, CheckVerdict, OverrideRecord } from "./types.js";
import { collectChangeSet, listRepoTestFiles } from "./git.js";
import { detectRisks } from "./detectors.js";
import { generateClaims, type LlmContentMode } from "./claims.js";
import { mapEvidence } from "./evidence.js";
import {
  DEFAULT_POLICY,
  evaluateInvariants,
  evaluatePolicy,
  loadPolicy,
  type PolicyConfig,
} from "./policy.js";
import type { ProviderFn } from "../providers.js";

export interface CheckOptions {
  readonly cwd: string;
  readonly range?: string;
  readonly base?: string;
  readonly description?: string;
  readonly policy?: PolicyConfig;
  readonly policyPath?: string;
  readonly noLlm?: boolean;
  readonly model?: string;
  readonly llmContent?: LlmContentMode;
  readonly advisory?: boolean;
  readonly override?: string;
  readonly callModel?: ProviderFn;
  readonly warn?: (message: string) => void;
}

const VERDICT_EXIT: Record<CheckVerdict, number> = {
  pass: EXIT_CODE.PASS,
  "pass-with-warnings": EXIT_CODE.PASS,
  "needs-evidence": EXIT_CODE.INCONCLUSIVE,
  "split-required": EXIT_CODE.INCONCLUSIVE,
  block: EXIT_CODE.FAIL,
};

export function parseOverride(raw: string): { owner: string; rationale: string } {
  const idx = raw.indexOf(":");
  const owner = idx > 0 ? raw.slice(0, idx).trim() : "";
  const rationale = idx > 0 ? raw.slice(idx + 1).trim() : "";
  if (!owner || !rationale) {
    throw new ConfigError(
      'Invalid --override: expected "<owner>: <rationale>" with both parts non-empty.',
    );
  }
  return { owner, rationale };
}

export async function runCheck(options: CheckOptions): Promise<CheckResult> {
  const start = performance.now();

  const override = options.override !== undefined ? parseOverride(options.override) : undefined;

  const policy =
    options.policy ??
    (options.policyPath ? await loadPolicy(options.policyPath) : DEFAULT_POLICY);

  const changeSet = await collectChangeSet({
    cwd: options.cwd,
    ...(options.range !== undefined ? { range: options.range } : {}),
    ...(options.base !== undefined ? { base: options.base } : {}),
    ...(options.description !== undefined ? { description: options.description } : {}),
  });

  // An empty range short-circuits to an explicit pass — never a silent green
  // that is indistinguishable from a real clean verdict.
  if (changeSet.files.length === 0) {
    return {
      range: changeSet.rangeLabel,
      verdict: "pass",
      effectiveExitCode: EXIT_CODE.PASS,
      reasons: [
        {
          ruleId: "no_changes",
          message: `No changes analyzed for range ${changeSet.rangeLabel}. Verify the range if you expected changes.`,
        },
      ],
      claims: [],
      findings: [],
      invariants: [],
      rollback: { relevant: false, detected: false, explanation: "No changes." },
      noChanges: true,
      durationMs: performance.now() - start,
    };
  }

  const detection = detectRisks(changeSet, {
    clusterThreshold: policy.thresholds.max_unrelated_clusters,
  });

  const claims = await generateClaims(changeSet, detection.findings, {
    ...(options.noLlm !== undefined ? { noLlm: options.noLlm } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.llmContent !== undefined ? { llmContent: options.llmContent } : {}),
    ...(options.callModel !== undefined ? { callModel: options.callModel } : {}),
    ...(options.warn !== undefined ? { warn: options.warn } : {}),
  });

  const repoTests = await listRepoTestFiles(options.cwd);
  const evaluated = mapEvidence(changeSet, claims, repoTests);
  const invariants = evaluateInvariants(policy, changeSet, evaluated);

  const evaluation = evaluatePolicy(policy, {
    findings: detection.findings,
    claims: evaluated,
    invariants,
    rollback: detection.rollback,
  });

  const rawExit = VERDICT_EXIT[evaluation.verdict];
  const clamped = options.advisory || override !== undefined;
  const effectiveExitCode = clamped ? EXIT_CODE.PASS : rawExit;

  const overrideRecord: OverrideRecord | undefined =
    override !== undefined
      ? { owner: override.owner, rationale: override.rationale, overriddenVerdict: evaluation.verdict }
      : undefined;

  return {
    range: changeSet.rangeLabel,
    verdict: evaluation.verdict,
    effectiveExitCode,
    reasons: evaluation.reasons,
    claims: evaluated,
    findings: detection.findings,
    invariants,
    rollback: detection.rollback,
    noChanges: false,
    ...(overrideRecord !== undefined ? { override: overrideRecord } : {}),
    durationMs: performance.now() - start,
  };
}
