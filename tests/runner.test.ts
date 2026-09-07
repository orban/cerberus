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
      // U7 (KTD7): gating is explicit on every result, code contracts
      // included, because the rollups filter on it rather than inferring it.
      // A code contract is an exact oracle and is always gating.
      "gating",
    ]);
    expect(contract.gating).toBe(true);
    expect(contract.advisoryReasons).toBeUndefined();
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

// ── Gating vs advisory envelope (R6, R11, R12, KTD7) ─────────
//
// The exit code is the whole point of these: a judge that was never measured
// against human labels reports, and nothing more. Everything here runs on the
// scripted judge, so no API key is read.

/** Fail every trial; the reported verdict is what a gating run would have had. */
const alwaysFails = () => "fail" as const;
const alwaysPasses = () => "pass" as const;

describe("gating vs advisory envelope", () => {
  it("AE1: a suite whose only judge contract is advisory and below threshold passes", async () => {
    programJudge("advisory-judge", alwaysFails);

    const result = await runSuite(await config("advisory-only-config.yaml"), {
      json: false,
    });
    const contract = result.studies[0]!.contractResults[0]!;

    // The verdict it would have had is still reported (R11).
    expect(contract.status).toBe("fail");
    expect(contract.observedRate).toBe(0);
    expect(contract.gating).toBe(false);
    expect(contract.advisoryReasons).toEqual(["no-gold-set"]);

    // ...and it does not reach the exit code.
    expect(result.status).toBe("pass");
  }, 30_000);

  it("fails on a gating code contract while an advisory judge contract is reported but not the cause", async () => {
    programJudge("advisory-judge", alwaysFails);

    const result = await runSuite(await config("advisory-mixed-config.yaml"), {
      json: false,
    });
    const byName = new Map(
      result.studies[0]!.contractResults.map((c) => [c.contractName, c]),
    );

    expect(result.status).toBe("fail");

    const code = byName.get("never-holds")!;
    expect(code.gating).toBe(true);
    expect(code.status).toBe("fail");
    expect(code.advisoryReasons).toBeUndefined();

    // Named in the report, absent from the cause.
    const judge = byName.get("advisory-judge")!;
    expect(judge.status).toBe("fail");
    expect(judge.gating).toBe(false);

    const causes = result.studies
      .flatMap((s) => s.contractResults)
      .filter((c) => c.gating && c.status === "fail")
      .map((c) => c.contractName);
    expect(causes).toEqual(["never-holds"]);
  }, 30_000);

  it("passes a suite with zero gating contracts, whatever the advisory verdicts say", async () => {
    programJudge("advisory-passes", alwaysPasses);
    programJudge("advisory-fails", alwaysFails);

    const result = await runSuite(
      await config("advisory-zero-gating-config.yaml"),
      { json: false },
    );
    const all = result.studies.flatMap((s) => s.contractResults);

    expect(all.every((c) => c.gating === false)).toBe(true);
    expect(all.map((c) => c.status).sort()).toEqual(["fail", "pass"]);
    expect(result.status).toBe("pass");
  }, 30_000);

  it("fails an aborted study even when every contract is advisory", async () => {
    // The judge passes everything it is asked, so the contract rollup has no
    // complaint. Only the error-rate abort knows the agent is broken.
    programJudge("advisory-on-a-crash", alwaysPasses);

    const result = await runSuite(await config("advisory-abort-config.yaml"), {
      json: false,
    });

    expect(result.studies[0]!.aborted).toBe(true);
    expect(result.studies[0]!.contractResults[0]!.gating).toBe(false);
    expect(result.status).toBe("fail");
  }, 30_000);

  it("excludes advisory contracts from the multiple-comparison family", async () => {
    programJudge("advisory-one", alwaysFails);
    programJudge("advisory-two", alwaysFails);

    const withAdvisory = await runSuite(
      await config("advisory-correction-config.yaml"),
      { json: false },
    );
    const baseline = await runSuite(
      await config("advisory-correction-baseline-config.yaml"),
      { json: false },
    );

    const alphas = (result: Awaited<ReturnType<typeof runSuite>>) =>
      new Map(
        result.studies
          .flatMap((s) => s.contractResults)
          .map((c) => [c.contractName, c.correctedAlpha]),
      );

    const mixed = alphas(withAdvisory);
    const alone = alphas(baseline);

    // Advisory contracts spend no alpha budget and receive no corrected alpha.
    expect(mixed.get("advisory-one")).toBeUndefined();
    expect(mixed.get("advisory-two")).toBeUndefined();

    // The gating contracts are corrected as a family of two, not of four.
    expect(mixed.get("exits-cleanly")).toBe(alone.get("exits-cleanly"));
    expect(mixed.get("parses-json")).toBe(alone.get("parses-json"));
    expect(mixed.get("exits-cleanly")).toBeGreaterThan(0);
  }, 30_000);

  it("reaches each of R12's four advisory reasons, distinctly", async () => {
    programJudge("no-labels", alwaysPasses);
    programJudge("marked-labels", alwaysPasses);
    programJudge("weak-certification", alwaysPasses);
    programJudge("floor-too-wide", certifiedJudge(() => "pass"));
    programJudge("floor-with-a-gap", certifiedJudge(() => "pass"));

    const result = await runSuite(
      await config("advisory-reasons-config.yaml"),
      { json: false },
    );
    const byName = new Map(
      result.studies[0]!.contractResults.map((c) => [c.contractName, c]),
    );

    for (const contract of byName.values()) {
      expect(contract.gating).toBe(false);
    }

    // A contract with no gold set is never certified, so this reason cannot be
    // sourced from `ineligibilityReasons` -- it is named on its own.
    expect(byName.get("no-labels")!.advisoryReasons).toEqual(["no-gold-set"]);
    expect(byName.get("marked-labels")!.advisoryReasons).toContain(
      "marked-gold-set",
    );
    expect(byName.get("weak-certification")!.advisoryReasons).toEqual([
      "certification",
    ]);
    expect(byName.get("floor-too-wide")!.advisoryReasons).toEqual([
      "calibration-floor",
    ]);

    // Four distinct reason sets across the five contracts.
    const sets = new Set(
      [...byName.values()].map((c) => JSON.stringify(c.advisoryReasons)),
    );
    expect(sets.size).toBe(4);

    // R12's labels estimate rides along wherever the floor leaves a gap to
    // close. 20 labels put the floor at +/- 0.144; closing to 0.05 needs 64 --
    // and this judge made no errors at all, so that figure comes from the
    // exact inversion of the zero-count Wilson cell, not the normal
    // approximation, which would have collapsed to zero.
    const floored = byName.get("floor-with-a-gap")!;
    expect(floored.goldSetSize).toBe(20);
    expect(floored.pairedUnits).toBe(20);
    expect(floored.labelsNeeded).toBe(64);

    // A threshold sitting exactly on the band's centre is its own answer, not
    // a missing one: the key is PRESENT and null, because no gold-set size
    // separates it. Absent would have said "the floor is not the reason".
    const unseparable = byName.get("floor-too-wide")!;
    expect(unseparable.goldSetSize).toBe(20);
    expect(unseparable.labelsNeeded).toBeNull();
    expect("labelsNeeded" in unseparable).toBe(true);

    // Where the floor is not the reason, the question does not arise.
    expect("labelsNeeded" in byName.get("weak-certification")!).toBe(false);
    expect("labelsNeeded" in byName.get("no-labels")!).toBe(false);

    // A judge contract with no gold set has no size and no estimate to give.
    expect(byName.get("no-labels")!.goldSetSize).toBeUndefined();
    expect(byName.get("no-labels")!.pairedUnits).toBeUndefined();

    // The suite is vacuously passing: nothing here may drive the exit.
    expect(result.status).toBe("pass");
  }, 60_000);

  it("separates a partially-judged gold set from a small one", async () => {
    // 20 entries over two scenarios; the judge errors on GOLD-B, so its five
    // entries are missing ratings and only 15 units pair.
    programJudge("half-judged-gold-set", (call) =>
      call.scenarioInput === "GOLD-B" ? "error" : "pass",
    );

    const result = await runSuite(
      await config("advisory-partial-labels-config.yaml"),
      { json: false },
    );
    const contract = result.studies[0]!.contractResults[0]!;

    // The gold set is full-sized, unmarked and well-formed. What refuses it is
    // that only 15 units carry both a label and a verdict -- undersize is
    // measured there, not on the entry count.
    expect(contract.goldSetSize).toBe(20);
    expect(contract.pairedUnits).toBe(15);
    expect(contract.advisoryReasons).toEqual(["certification"]);
    expect(contract.gating).toBe(false);

    // It still gets a corrected estimate: the rectifier is what routes a
    // contract to the calibrated path, not the verdict (R4 and R1 are
    // separable). It simply cannot gate.
    expect(contract.calibrated).toBe(true);
    expect(result.status).toBe("pass");
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
