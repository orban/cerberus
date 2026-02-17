import { z } from "zod";
import type { TrialOutput } from "./types.js";
import type { JudgeContractConfig, JudgeProviderConfig, Scenario } from "./config.js";

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

// ── Provider registry ────────────────────────────────────────

type ProviderFn = (prompt: string, model: string) => Promise<string>;

function getProvider(model: string): { call: ProviderFn; name: string } | null {
  if (model.startsWith("gpt-") || model.startsWith("o1") || model.startsWith("o3") || model.startsWith("o4")) {
    return { call: callOpenAI, name: "openai" };
  }
  if (model.startsWith("claude-")) {
    return { call: callAnthropic, name: "anthropic" };
  }
  if (model.startsWith("gemini-")) {
    return { call: callGoogle, name: "google" };
  }
  return null;
}

function getEnvVar(providerName: string): string | undefined {
  switch (providerName) {
    case "openai":
      return process.env.OPENAI_API_KEY;
    case "anthropic":
      return process.env.ANTHROPIC_API_KEY;
    case "google":
      return process.env.GOOGLE_API_KEY;
    default:
      return undefined;
  }
}

// ── Provider implementations ─────────────────────────────────

const TIMEOUT_MS = 60_000;

async function callOpenAI(prompt: string, model: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`OpenAI API error ${res.status}: ${body.slice(0, 200)}`);
    }

    const data: unknown = await res.json();
    const content = (data as { choices: Array<{ message: { content: string } }> })
      .choices[0]?.message?.content;
    if (typeof content !== "string") throw new Error("No content in OpenAI response");
    return content;
  } finally {
    clearTimeout(timer);
  }
}

async function callAnthropic(prompt: string, model: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Anthropic API error ${res.status}: ${body.slice(0, 200)}`);
    }

    const data: unknown = await res.json();
    const content = (data as { content: Array<{ text: string }> })
      .content[0]?.text;
    if (typeof content !== "string") throw new Error("No content in Anthropic response");
    return content;
  } finally {
    clearTimeout(timer);
  }
}

async function callGoogle(prompt: string, model: string): Promise<string> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_API_KEY not set");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Google API error ${res.status}: ${body.slice(0, 200)}`);
    }

    const data: unknown = await res.json();
    const content = (data as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> })
      .candidates[0]?.content?.parts[0]?.text;
    if (typeof content !== "string") throw new Error("No content in Google response");
    return content;
  } finally {
    clearTimeout(timer);
  }
}

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
  // Strategy 1: Direct JSON parse
  try {
    const parsed = JudgeResponseSchema.parse(JSON.parse(raw));
    return parsed;
  } catch {
    // continue to next strategy
  }

  // Strategy 2: Extract JSON from code block
  const codeBlockMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch?.[1]) {
    try {
      const parsed = JudgeResponseSchema.parse(JSON.parse(codeBlockMatch[1]));
      return parsed;
    } catch {
      // continue to next strategy
    }
  }

  // Strategy 3: Find first { ... } block
  const braceMatch = raw.match(/\{[\s\S]*?\}/);
  if (braceMatch?.[0]) {
    try {
      const parsed = JudgeResponseSchema.parse(JSON.parse(braceMatch[0]));
      return parsed;
    } catch {
      // fall through
    }
  }

  throw new Error(`Could not parse judge verdict from response: ${raw.slice(0, 200)}`);
}

// ── Panel evaluation ─────────────────────────────────────────

async function callJudgeWithRetry(
  provider: { call: ProviderFn; name: string },
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
  const panelJudges: Array<{ model: string; provider: { call: ProviderFn; name: string } }> = [];

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
