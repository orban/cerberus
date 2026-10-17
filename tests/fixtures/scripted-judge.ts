import type {
  JudgeContractConfig,
  JudgeProviderConfig,
  Scenario,
} from "../../src/config.js";
import type { TrialOutput } from "../../src/types.js";

// A deterministic offline judge.
//
// Every provider in `src/judges.ts` throws when its API key is unset, and
// `runStudy` calls `evaluateContract` directly with no injection seam, so no
// test that exercises the judge path can run in CI without one of these. The
// seam is `evaluateWithPanel`: it is the single function `src/contracts.ts`
// imports from `src/judges.ts`, so a test file that does
//
//   vi.mock("../src/judges.js", async () => ({
//     evaluateWithPanel: (await import("./fixtures/scripted-judge.js"))
//       .scriptedEvaluateWithPanel,
//   }));
//
// replaces every network call in the runner with a replayed script, and
// nothing under `src/` has to know a test is running.
//
// A script is a function of the call rather than a flat array, because the
// runner calls the judge in two distinct phases: once per DISTINCT gold-set
// scenario during the pre-trial calibration pass, and once per trial
// afterwards. `scenarioInput` is what tells them apart.

export type ScriptedVerdict = "pass" | "fail" | "error";

export interface ScriptedJudgeCall {
  readonly contractName: string;
  /** The scenario's `input`, trimmed. Gold-set fixtures use "GOLD-A"/"GOLD-B". */
  readonly scenarioInput: string;
  /** 0-based index among every call to this contract. */
  readonly callIndex: number;
  /** 0-based index among calls to this contract for this same scenario. */
  readonly scenarioCallIndex: number;
}

export type ScriptedJudgeScript = (call: ScriptedJudgeCall) => ScriptedVerdict;

const scripts = new Map<string, ScriptedJudgeScript>();
const calls = new Map<string, ScriptedJudgeCall[]>();

/** Call from `beforeEach`: scripts and call logs are module-level state. */
export function resetScriptedJudge(): void {
  scripts.clear();
  calls.clear();
}

export function programJudge(
  contractName: string,
  script: ScriptedJudgeScript,
): void {
  scripts.set(contractName, script);
}

/**
 * Every judge call the runner made for a contract, in order. This is how a
 * test proves a stopped contract consumed no further judge calls.
 */
export function judgeCalls(
  contractName: string,
): readonly ScriptedJudgeCall[] {
  return calls.get(contractName) ?? [];
}

/** Drop-in replacement for `evaluateWithPanel`. */
export async function scriptedEvaluateWithPanel(
  _output: TrialOutput,
  contract: JudgeContractConfig,
  scenario: Scenario,
  _judges: readonly JudgeProviderConfig[],
): Promise<{ pass: boolean; reasoning: string }> {
  const script = scripts.get(contract.name);
  if (!script) {
    throw new Error(
      `scripted judge: no script programmed for contract "${contract.name}"`,
    );
  }

  const scenarioInput = scenario.input.trim();
  const previous = calls.get(contract.name) ?? [];
  const call: ScriptedJudgeCall = {
    contractName: contract.name,
    scenarioInput,
    callIndex: previous.length,
    scenarioCallIndex: previous.filter((c) => c.scenarioInput === scenarioInput)
      .length,
  };
  calls.set(contract.name, [...previous, call]);

  const verdict = script(call);
  if (verdict === "error") {
    // `evaluateJudgeContract` turns a throw into a verdict with status
    // "error", which is exactly what a judge API timeout produces.
    throw new Error(
      `scripted judge: simulated judge failure on call ${call.callIndex}`,
    );
  }

  return { pass: verdict === "pass", reasoning: `scripted ${verdict}` };
}

// ── Scripts the fixtures share ───────────────────────────────

export const GOLD_A = "GOLD-A";
export const GOLD_B = "GOLD-B";

/** True for a trial call — anything that is not a gold-set scenario. */
export function isTrialCall(call: ScriptedJudgeCall): boolean {
  return call.scenarioInput !== GOLD_A && call.scenarioInput !== GOLD_B;
}

/**
 * The judge the `certified` and `biased` gold sets were written against:
 * GOLD-A passes, GOLD-B fails, and `onTrial` decides every trial verdict.
 */
export function certifiedJudge(
  onTrial: (trialIndex: number) => ScriptedVerdict,
): ScriptedJudgeScript {
  return (call) => {
    if (call.scenarioInput === GOLD_A) return "pass";
    if (call.scenarioInput === GOLD_B) return "fail";
    return onTrial(call.scenarioCallIndex);
  };
}
