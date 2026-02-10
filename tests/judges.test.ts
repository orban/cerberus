import { describe, it, expect } from "vitest";
import {
  _buildPrompt,
  _parseVerdict,
  _getProvider,
} from "../src/judges.js";
import type { TrialOutput } from "../src/types.js";
import type { JudgeContractConfig, Scenario } from "../src/config.js";

const scenario: Scenario = {
  input: "Review this code for bugs",
  metadata: { category: "test" },
};

function makeOutput(raw = '{"result": "ok"}'): TrialOutput {
  return {
    meta: { raw, stderr: "", exitCode: 0, durationMs: 100, jsonParsed: true },
    parsed: { result: "ok" },
  };
}

const contract: JudgeContractConfig = {
  name: "test-judge",
  type: "judge",
  rubric: "Check if the output addresses the bug",
  judge_panel: 1,
  threshold: 0.90,
  confidence: 0.95,
  trials: 10,
};

// ── Provider registry ────────────────────────────────────────

describe("getProvider", () => {
  it("routes gpt-* to openai", () => {
    expect(_getProvider("gpt-4o")).not.toBeNull();
    expect(_getProvider("gpt-4o")!.name).toBe("openai");
  });

  it("routes claude-* to anthropic", () => {
    expect(_getProvider("claude-sonnet-4-5-20250929")!.name).toBe("anthropic");
  });

  it("routes gemini-* to google", () => {
    expect(_getProvider("gemini-2.0-flash")!.name).toBe("google");
  });

  it("returns null for unknown models", () => {
    expect(_getProvider("llama-3")).toBeNull();
  });
});

// ── Prompt template ──────────────────────────────────────────

describe("buildPrompt", () => {
  it("includes rubric, output, and scenario", () => {
    const prompt = _buildPrompt(makeOutput(), contract, scenario);
    expect(prompt).toContain("Check if the output addresses the bug");
    expect(prompt).toContain('"result": "ok"');
    expect(prompt).toContain("Review this code for bugs");
  });

  it("truncates long output", () => {
    const longOutput = "x".repeat(20_000);
    const prompt = _buildPrompt(makeOutput(longOutput), contract, scenario);
    expect(prompt).toContain("(truncated)");
    expect(prompt.length).toBeLessThan(20_000);
  });

  it("includes source when specified", () => {
    const withSource = { ...contract, source: "./CLAUDE.md#style-rules" };
    const prompt = _buildPrompt(makeOutput(), withSource, scenario);
    expect(prompt).toContain("./CLAUDE.md#style-rules");
  });

  it("requests JSON response format", () => {
    const prompt = _buildPrompt(makeOutput(), contract, scenario);
    expect(prompt).toContain('"pass"');
    expect(prompt).toContain('"confidence"');
    expect(prompt).toContain('"reasoning"');
  });
});

// ── Verdict parsing ──────────────────────────────────────────

describe("parseVerdict", () => {
  it("parses direct JSON", () => {
    const verdict = _parseVerdict('{"pass": true, "confidence": 0.95, "reasoning": "Looks good"}');
    expect(verdict.pass).toBe(true);
    expect(verdict.confidence).toBe(0.95);
    expect(verdict.reasoning).toBe("Looks good");
  });

  it("parses JSON from code block", () => {
    const raw = 'Here is my evaluation:\n```json\n{"pass": false, "confidence": 0.8, "reasoning": "Missing security check"}\n```';
    const verdict = _parseVerdict(raw);
    expect(verdict.pass).toBe(false);
    expect(verdict.reasoning).toBe("Missing security check");
  });

  it("parses JSON from brace matching", () => {
    const raw = 'Based on my analysis, {"pass": true, "confidence": 0.9, "reasoning": "Good"} is my verdict.';
    const verdict = _parseVerdict(raw);
    expect(verdict.pass).toBe(true);
  });

  it("throws on unparseable response", () => {
    expect(() => _parseVerdict("I think it passes")).toThrow("Could not parse judge verdict");
  });

  it("rejects invalid schema", () => {
    expect(() => _parseVerdict('{"verdict": true}')).toThrow();
  });

  it("handles confidence edge cases", () => {
    const v1 = _parseVerdict('{"pass": true, "confidence": 0, "reasoning": "n/a"}');
    expect(v1.confidence).toBe(0);

    const v2 = _parseVerdict('{"pass": true, "confidence": 1.0, "reasoning": "n/a"}');
    expect(v2.confidence).toBe(1.0);
  });
});
