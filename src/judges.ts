import { z } from "zod";
import type { TrialOutput } from "./types.js";
import type { JudgeContractConfig, JudgeProviderConfig, Scenario } from "./config.js";
import { getProvider, getEnvVar, parseJsonResponse, type Provider } from "./providers.js";

// ── Types ────────────────────────────────────────────────────

export interface JudgeVerdict {
  readonly pass: boolean;
  readonly confidence: number;
  readonly reasoning: string;
}

const JudgeResponseSchema = z.object({
  pass: z.boolean(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});

// Provider registry and clients live in providers.ts (shared with pcc/claims.ts).

// ── Prompt template ──────────────────────────────────────────

const MAX_OUTPUT_CHARS = 10_000;

function buildPrompt(
  output: TrialOutput,
  contract: JudgeContractConfig,
  scenario: Scenario,
): string {
  const truncatedOutput = output.meta.raw.length > MAX_OUTPUT_CHARS
    ? output.meta.raw.slice(0, MAX_OUTPUT_CHARS) + "\n... (truncated)"
    : output.meta.raw;

  const rubricSection = `## Evaluation Rubric\n${contract.rubric}`;

  const outputSection = `## Agent Output\n\`\`\`\n${truncatedOutput}\n\`\`\``;

  const scenarioSection = `## Scenario Input\n\`\`\`\n${scenario.input}\n\`\`\``;

  const sourceSection = contract.source
    ? `\n## Reference Source\n${contract.source}\n`
    : "";

  // Randomize presentation order to reduce position bias
  const sections = Math.random() < 0.5
    ? [rubricSection, outputSection]
    : [outputSection, rubricSection];

  return `You are evaluating an AI agent's output against a rubric. Be strict and objective.

${scenarioSection}

${sections[0]}

${sections[1]}
${sourceSection}
## Instructions

Evaluate whether the agent's output satisfies the rubric criteria.
Respond with ONLY a JSON object in this exact format:

\`\`\`json
{
  "pass": true or false,
  "confidence": 0.0 to 1.0,
  "reasoning": "Brief explanation of your evaluation"
}
\`\`\``;
}

// ── Verdict parsing ──────────────────────────────────────────

function parseVerdict(raw: string): JudgeVerdict {
  return parseJsonResponse(raw, JudgeResponseSchema, /\{[\s\S]*?\}/, "judge verdict");
}

// ── Panel evaluation ─────────────────────────────────────────

async function callJudgeWithRetry(
  provider: Provider,
  prompt: string,
  model: string,
): Promise<JudgeVerdict> {
  try {
    const raw = await provider.call(prompt, model);
    return parseVerdict(raw);
  } catch (firstError) {
    // Retry once with backoff (skip retry for auth errors)
    const msg = firstError instanceof Error ? firstError.message : "";
    if (msg.includes("401") || msg.includes("403") || msg.includes("not set")) {
      throw firstError;
    }

    await new Promise((r) => setTimeout(r, 1000 + Math.random() * 2000));

    try {
      const raw = await provider.call(prompt, model);
      return parseVerdict(raw);
    } catch {
      throw firstError; // throw original error
    }
  }
}

export async function evaluateWithPanel(
  output: TrialOutput,
  contract: JudgeContractConfig,
  scenario: Scenario,
  judges: readonly JudgeProviderConfig[],
): Promise<{ pass: boolean; reasoning: string }> {
  const panelSize = contract.judge_panel;
  const prompt = buildPrompt(output, contract, scenario);

  // Select judges for this panel (cycle through available judges)
  const panelJudges: Array<{ model: string; provider: Provider }> = [];

  for (let i = 0; i < panelSize; i++) {
    const judge = judges[i % judges.length]!;
    const provider = getProvider(judge.model);
    if (!provider) {
      throw new Error(`Unknown model provider for: ${judge.model}`);
    }
    const apiKey = getEnvVar(provider.name);
    if (!apiKey) {
      throw new Error(`${provider.name.toUpperCase()}_API_KEY not set for model: ${judge.model}`);
    }
    panelJudges.push({ model: judge.model, provider });
  }

  // Invoke all judges in parallel
  const results = await Promise.allSettled(
    panelJudges.map(({ model, provider }) =>
      callJudgeWithRetry(provider, prompt, model),
    ),
  );

  // Collect successful verdicts
  const verdicts: JudgeVerdict[] = [];
  const errors: string[] = [];

  for (const result of results) {
    if (result.status === "fulfilled") {
      verdicts.push(result.value);
    } else {
      const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
      errors.push(msg);
    }
  }

  // Require at least 1 successful verdict
  if (verdicts.length === 0) {
    throw new Error(`All judges failed: ${errors.join("; ")}`);
  }

  // Majority vote
  const passCount = verdicts.filter((v) => v.pass).length;
  const pass = passCount > verdicts.length / 2;

  // Aggregate reasoning
  const reasoning = verdicts
    .map((v, i) => `Judge ${i + 1}: ${v.pass ? "PASS" : "FAIL"} (${(v.confidence * 100).toFixed(0)}%) - ${v.reasoning}`)
    .join("\n");

  return { pass, reasoning };
}

// Export for testing
export { buildPrompt as _buildPrompt, parseVerdict as _parseVerdict, getProvider as _getProvider };
