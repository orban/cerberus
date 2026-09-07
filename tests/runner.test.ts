import { describe, it, expect, beforeEach, vi } from "vitest";
import { resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { runSuite } from "../src/runner.js";
import { displayProgress } from "../src/output.js";
import {
  certifiedJudge,
  judgeCalls,
  programJudge,
  resetScriptedJudge,
} from "./fixtures/scripted-judge.js";

// Replace the only function `src/contracts.ts` imports from `src/judges.ts`.
// Every judge scenario below therefore runs with no API key set.
vi.mock("../src/judges.js", async () => ({
  evaluateWithPanel: (await import("./fixtures/scripted-judge.js"))
    .scriptedEvaluateWithPanel,
}));

const fixturesDir = resolve(import.meta.dirname, "fixtures");

function config(name: string) {
  return loadConfig(resolve(fixturesDir, name));
}

beforeEach(() => {
  resetScriptedJudge();
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GOOGLE_API_KEY;
});

describe("runSuite", () => {
  it("runs a simple study with echo agent and passes", async () => {
    const result = await runSuite(await config("valid-config.yaml"), {
      json: false,
    });

    expect(result.status).toBe("pass");
    expect(result.studies).toHaveLength(1);
    expect(result.studies[0]!.studyName).toBe("basic-test");
    expect(result.studies[0]!.contractResults).toHaveLength(1);
    expect(result.studies[0]!.contractResults[0]!.status).toBe("pass");
    expect(result.studies[0]!.contractResults[0]!.observedRate).toBe(1.0);
  });

  it("detects failures with crash agent", async () => {
    const result = await runSuite(await config("crash-config.yaml"), {
      json: false,
    });

    // Crash agent exits with code 1 -> all contracts fail
    expect(result.status).toBe("fail");
    const contract = result.studies[0]!.contractResults[0]!;
    expect(contract.status).toBe("fail");
    expect(contract.observedRate).toBe(0);
  });

  it("handles timeout agent", async () => {
    const result = await runSuite(await config("timeout-config.yaml"), {
      json: false,
    });

    // Slow agent should time out
    expect(result.studies[0]!.contractResults[0]!.status).toBe("fail");
  }, 15_000);

  it("SPRT stops early when evidence is clear", async () => {
    const result = await runSuite(await config("valid-config.yaml"), {
      json: false,
    });

    const contract = result.studies[0]!.contractResults[0]!;
    // With 100% pass rate, SPRT should stop well before 30 max trials
    expect(contract.sprtStoppedEarly).toBe(true);
    expect(contract.trialsEvaluated).toBeLessThan(30);
  });

  it("aborts study when error rate exceeds threshold", async () => {
    const result = await runSuite(await config("abort-config.yaml"), {
      json: false,
    });

    expect(result.studies[0]!.aborted).toBe(true);
  });
});

// ── Code-contract characterization ───────────────────────────
// Written before the calibrated seam was touched. A code contract is an exact
// oracle and must stay on the SPRT path with the shape it had before, down to
// the field list -- an extra field would change the persisted JSON run record.

describe("code contracts are unaffected by the calibrated path", () => {
  it("produces the same result shape and values as before the change", async () => {
    const result = await runSuite(await config("valid-config.yaml"), {
      json: false,
    });
    const contract = result.studies[0]!.contractResults[0]!;

    expect(Object.keys(contract)).toEqual([
      "contractName",
      "status",
      "observedRate",
      "ci",
      "trialsEvaluated",
      "sprtStoppedEarly",
    ]);
    expect(contract.contractName).toBe("exits-cleanly");
    expect(contract.status).toBe("pass");
    expect(contract.observedRate).toBe(1);
    expect(contract.trialsEvaluated).toBe(contract.ci.n);
    expect(contract.sprtStoppedEarly).toBe(true);
  });

  it("carries no calibrated fields in a multi-contract study", async () => {
    const result = await runSuite(await config("multi-contract-config.yaml"), {
      json: false,
    });

    for (const contract of result.studies[0]!.contractResults) {
      expect(contract.stopReason).toBeUndefined();
      expect(contract.calibrated).toBeUndefined();
      expect(contract.judgedRate).toBeUndefined();
      // The multiple-comparison correction still runs over all three.
      expect(contract.correctedAlpha).toBeGreaterThan(0);
    }
  });
});

// ── Calibrated judge contracts ───────────────────────────────

describe("calibrated judge contracts", () => {
  it("stops early and passes on a clear gap, refuses a floor-guarded contract, and reports an uncalibrated one raw (AE3, AE1, R10)", async () => {
    programJudge("clear-gap", certifiedJudge(() => "pass"));
    programJudge("floor-guarded", certifiedJudge(() => "pass"));
    // No gold set: the SPRT path over the raw judged rate, at ~70%.
    programJudge("uncalibrated", (call) =>
      call.callIndex % 10 < 7 ? "pass" : "fail",
    );

    const result = await runSuite(await config("calibrated-judge-config.yaml"), {
      json: false,
    });
    const byName = new Map(
      result.studies[0]!.contractResults.map((c) => [c.contractName, c]),
    );

    // AE3: the corrected interval clears 0.50 from above at trial 20.
    const clearGap = byName.get("clear-gap")!;
    expect(clearGap.status).toBe("pass");
    expect(clearGap.stopReason).toBe("decisive");
    expect(clearGap.calibrated).toBe(true);
    expect(clearGap.sprtStoppedEarly).toBe(true);
    expect(clearGap.trialsEvaluated).toBe(20);
    expect(clearGap.ci.lower).toBeGreaterThan(0.5);

    // R10: the floor guard and the label-limited stop are one predicate, so a
    // contract the guard refuses never runs a trial and is never later
    // reported as sampling-limited.
    const guarded = byName.get("floor-guarded")!;
    expect(guarded.status).toBe("inconclusive");
    expect(guarded.stopReason).toBe("label-limited");
    expect(guarded.trialsEvaluated).toBe(0);
    // Two gold-set scenarios calibrated it; not one trial followed. It is
    // never admitted and then reported sampling-limited at the budget.
    expect(judgeCalls("floor-guarded").map((c) => c.scenarioInput)).toEqual([
      "GOLD-A",
      "GOLD-B",
    ]);

    // AE1: no gold set -> raw judged rate, marked uncalibrated.
    const uncalibrated = byName.get("uncalibrated")!;
    expect(uncalibrated.calibrated).toBe(false);
    expect(uncalibrated.stopReason).toBeUndefined();
    expect(uncalibrated.judgedRate).toBeUndefined();
    expect(uncalibrated.observedRate).toBeCloseTo(0.7, 1);
    expect(uncalibrated.status).toBe("fail");
  }, 30_000);

  it("makes no further judge calls after stopping while a sibling contract continues", async () => {
    programJudge("clear-gap", certifiedJudge(() => "pass"));
    programJudge("floor-guarded", certifiedJudge(() => "pass"));
    programJudge("uncalibrated", (call) =>
      call.callIndex % 10 < 7 ? "pass" : "fail",
    );

    await runSuite(await config("calibrated-judge-config.yaml"), {
      json: false,
    });

    const stopped = judgeCalls("clear-gap");
    const sibling = judgeCalls("uncalibrated");

    // 2 gold-set calibration calls + exactly 20 trials, then nothing.
    expect(stopped.filter((c) => c.scenarioInput.startsWith("GOLD"))).toHaveLength(2);
    expect(stopped.filter((c) => !c.scenarioInput.startsWith("GOLD"))).toHaveLength(20);
    expect(sibling.length).toBeGreaterThan(20);
  }, 30_000);

  it("stops label-limited when the calibration interval alone straddles at the running judged rate (AE4)", async () => {
    // Alternating verdicts drift the running judged rate to 0.50 -- exactly
    // the threshold, where the +/- 0.144 calibration band alone straddles.
    programJudge(
      "drifts-into-floor",
      certifiedJudge((trial) => (trial % 2 === 0 ? "pass" : "fail")),
    );

    const result = await runSuite(
      await config("calibrated-label-limited-config.yaml"),
      { json: false },
    );
    const contract = result.studies[0]!.contractResults[0]!;

    expect(contract.status).toBe("inconclusive");
    expect(contract.stopReason).toBe("label-limited");
    expect(contract.calibrated).toBe(true);
    // 50 is the minimum this stop may fire at, and it fires there.
    expect(contract.trialsEvaluated).toBe(50);
    expect(contract.judgedRate).toBeCloseTo(0.5, 10);
  }, 30_000);

  it("stops sampling-limited when the budget runs out with a decision still reachable (AE6)", async () => {
    programJudge("budget-exhausted", certifiedJudge(() => "pass"));

    const result = await runSuite(
      await config("calibrated-sampling-limited-config.yaml"),
      { json: false },
    );
    const contract = result.studies[0]!.contractResults[0]!;

    expect(contract.status).toBe("inconclusive");
    expect(contract.stopReason).toBe("sampling-limited");
    expect(contract.trialsEvaluated).toBe(8);
    // A decision was reachable: more trials, not more labels, would resolve it.
    expect(contract.judgedRate).toBe(1);
  }, 30_000);

  it("excludes judge error verdicts from the sequence and the trial budget (KTD8)", async () => {
    programJudge("all-errors", certifiedJudge(() => "error"));

    const result = await runSuite(
      await config("calibrated-errors-config.yaml"),
      { json: false },
    );
    const contract = result.studies[0]!.contractResults[0]!;

    expect(contract.calibrated).toBe(true);
    expect(contract.trialsEvaluated).toBe(0);
    expect(contract.status).toBe("inconclusive");
    expect(contract.stopReason).toBeUndefined();
    // The judge was still asked once per trial: 2 calibration + 10 trials.
    expect(judgeCalls("all-errors")).toHaveLength(12);
    expect(result.studies[0]!.totalTrials).toBe(10);
  }, 30_000);

  it("reports a corrected rate below the judged rate for an over-passing judge (R4)", async () => {
    programJudge("over-passing-judge", certifiedJudge(() => "pass"));

    const result = await runSuite(
      await config("calibrated-biased-config.yaml"),
      { json: false },
    );
    const contract = result.studies[0]!.contractResults[0]!;

    expect(contract.calibrated).toBe(true);
    expect(contract.judgedRate).toBe(1);
    // delta = (0 fn - 4 fp) / 20 = -0.20.
    expect(contract.observedRate).toBeCloseTo(0.8, 10);
    expect(contract.observedRate).toBeLessThan(contract.judgedRate!);
  }, 30_000);
});

// ── Progress display ─────────────────────────────────────────

describe("displayProgress", () => {
  it("renders a calibrated contract state without an SPRT state", () => {
    const written: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        written.push(String(chunk));
        return true;
      });

    try {
      displayProgress(
        "calibrated-judge",
        7,
        60,
        new Map([
          ["clear-gap", { decision: "accept", successes: 7, failures: 0 }],
          [
            "floor-guarded",
            { decision: "inconclusive", successes: 0, failures: 0 },
          ],
          ["uncalibrated", { decision: "continue", successes: 5, failures: 2 }],
        ]),
      );
    } finally {
      spy.mockRestore();
    }

    const output = written.join("");
    expect(output).toContain("7");
    expect(output).toContain("60");
    // Two of the three contracts are terminal.
    expect(output).toMatch(/2\/3/);
  });
});
