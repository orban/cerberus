import { runInNewContext } from "node:vm";
import type { TrialOutput, ContractVerdict } from "./types.js";
import type { ContractConfig, JudgeContractConfig, JudgeProviderConfig, Scenario } from "./config.js";
import { evaluateWithPanel } from "./judges.js";

export async function evaluateContract(
  output: TrialOutput,
  contract: ContractConfig,
  scenario: Scenario,
  judges: readonly JudgeProviderConfig[],
): Promise<ContractVerdict> {
  switch (contract.type) {
    case "code":
      return evaluateCodeContract(output, contract.assert, contract.name, scenario);
    case "judge":
      return evaluateJudgeContract(output, contract, scenario, judges);
  }
}

function evaluateCodeContract(
  output: TrialOutput,
  assertExpr: string,
  contractName: string,
  scenario: Scenario,
): ContractVerdict {
  try {
    const sandbox = Object.freeze({
      output: Object.freeze({
        meta: Object.freeze({ ...output.meta }),
        parsed: Object.freeze({ ...output.parsed }),
      }),
      scenario: Object.freeze({ ...scenario }),
      Math: Object.freeze(Math),
      Array: Object.freeze(Array),
      String: Object.freeze(String),
      RegExp: Object.freeze(RegExp),
      Boolean: Object.freeze(Boolean),
      Number: Object.freeze(Number),
      JSON: Object.freeze(JSON),
    });

    const result: unknown = runInNewContext(
      `"use strict"; (${assertExpr})`,
      sandbox,
      { timeout: 100 },
    );

    return {
      contractName,
      status: Boolean(result) ? "pass" : "fail",
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      contractName,
      status: "error",
      error: `Assertion error: ${msg}`,
    };
  }
}

async function evaluateJudgeContract(
  output: TrialOutput,
  contract: JudgeContractConfig,
  scenario: Scenario,
  judges: readonly JudgeProviderConfig[],
): Promise<ContractVerdict> {
  try {
    const result = await evaluateWithPanel(output, contract, scenario, judges);
    return {
      contractName: contract.name,
      status: result.pass ? "pass" : "fail",
      reasoning: result.reasoning,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      contractName: contract.name,
      status: "error",
      error: `Judge evaluation failed: ${msg}`,
    };
  }
}
