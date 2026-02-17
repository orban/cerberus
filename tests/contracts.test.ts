import { describe, it, expect } from "vitest";
import { evaluateContract } from "../src/contracts.js";
import type { TrialOutput } from "../src/types.js";
import type { Scenario, CodeContractConfig, JudgeContractConfig } from "../src/config.js";

function makeOutput(parsed: Record<string, unknown> = {}, exitCode = 0): TrialOutput {
  return {
    meta: {
      raw: JSON.stringify(parsed),
      stderr: "",
      exitCode,
      durationMs: 100,
      jsonParsed: true,
    },
    parsed,
  };
}

const scenario: Scenario = {
  input: "test input",
  metadata: { category: "test" },
};

const noJudges: [] = [];

describe("evaluateContract - code contracts", () => {
  const makeCodeContract = (assert: string): CodeContractConfig => ({
    name: "test-contract",
    type: "code",
    assert,
    threshold: 0.90,
    confidence: 0.95,
    trials: 10,
  });

  it("evaluates simple passing assertion", async () => {
    const output = makeOutput({ value: 42 });
    const contract = makeCodeContract("output.parsed.value === 42");
    const verdict = await evaluateContract(output, contract, scenario, noJudges);
    expect(verdict.status).toBe("pass");
  });

  it("evaluates simple failing assertion", async () => {
    const output = makeOutput({ value: 0 });
    const contract = makeCodeContract("output.parsed.value === 42");
    const verdict = await evaluateContract(output, contract, scenario, noJudges);
    expect(verdict.status).toBe("fail");
  });

  it("checks exitCode via meta", async () => {
    const output = makeOutput({}, 0);
    const contract = makeCodeContract("output.meta.exitCode === 0");
    const verdict = await evaluateContract(output, contract, scenario, noJudges);
    expect(verdict.status).toBe("pass");
  });

  it("handles runtime errors in assertion", async () => {
    const output = makeOutput({});
    const contract = makeCodeContract("output.nonexistent.deep.access");
    const verdict = await evaluateContract(output, contract, scenario, noJudges);
    expect(verdict.status).toBe("error");
    expect(verdict.error).toContain("Assertion error");
  });

  it("prevents access to require/process (sandbox)", async () => {
    const output = makeOutput({});
    const contract = makeCodeContract("typeof require !== 'undefined'");
    const verdict = await evaluateContract(output, contract, scenario, noJudges);
    expect(verdict.status).toBe("fail");
  });

  it("prevents access to process object (sandbox)", async () => {
    const output = makeOutput({});
    const contract = makeCodeContract("typeof process !== 'undefined'");
    const verdict = await evaluateContract(output, contract, scenario, noJudges);
    expect(verdict.status).toBe("fail");
  });

  it("allows use of Math in sandbox", async () => {
    const output = makeOutput({ value: 3.14159 });
    const contract = makeCodeContract("Math.round(output.parsed.value) === 3");
    const verdict = await evaluateContract(output, contract, scenario, noJudges);
    expect(verdict.status).toBe("pass");
  });

  it("allows use of JSON in sandbox", async () => {
    const output = makeOutput({ items: [1, 2, 3] });
    const contract = makeCodeContract("JSON.stringify(output.parsed.items) === '[1,2,3]'");
    const verdict = await evaluateContract(output, contract, scenario, noJudges);
    expect(verdict.status).toBe("pass");
  });

  it("can access scenario data", async () => {
    const contract = makeCodeContract("scenario.input.includes('test')");
    const verdict = await evaluateContract(makeOutput(), contract, scenario, noJudges);
    expect(verdict.status).toBe("pass");
  });

  it("handles assertion timeout (infinite loop)", async () => {
    const output = makeOutput({});
    const contract = makeCodeContract("(function() { while(true) {} })()");
    const verdict = await evaluateContract(output, contract, scenario, noJudges);
    expect(verdict.status).toBe("error");
    expect(verdict.error).toContain("Assertion error");
  });

  it("coerces truthy/falsy values", async () => {
    const output = makeOutput({ items: [1, 2] });
    const contract = makeCodeContract("output.parsed.items");
    const verdict = await evaluateContract(output, contract, scenario, noJudges);
    expect(verdict.status).toBe("pass");
  });

  it("coerces empty string to fail", async () => {
    const output = makeOutput({ name: "" });
    const contract = makeCodeContract("output.parsed.name");
    const verdict = await evaluateContract(output, contract, scenario, noJudges);
    expect(verdict.status).toBe("fail");
  });
});

describe("evaluateContract - judge contracts", () => {
  it("returns error for unknown model provider", async () => {
    const contract: JudgeContractConfig = {
      name: "judge-test",
      type: "judge",
      rubric: "Check quality",
      judge_panel: 1,
      threshold: 0.90,
      confidence: 0.95,
      trials: 10,
    };
    const verdict = await evaluateContract(makeOutput(), contract, scenario, [
      { model: "unknown-model-xyz" },
    ]);
    expect(verdict.status).toBe("error");
    expect(verdict.error).toContain("Unknown model provider");
  });
});
