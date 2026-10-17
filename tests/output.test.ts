import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { runSuite } from "../src/runner.js";
import {
  formatResults,
  writeJsonOutput,
  GOLD_SET_LOAD_FAILURE_PREFIX,
  NO_GOLD_SET_WARNING_HEADER,
} from "../src/output.js";
import type { ContractResult, SuiteResult } from "../src/types.js";
import {
  certifiedJudge,
  programJudge,
  resetScriptedJudge,
} from "./fixtures/scripted-judge.js";

// Same seam as tests/runner.test.ts: the only function `src/contracts.ts`
// imports from `src/judges.ts`, replaced with a replayed script. Every
// integration case below therefore runs with no API key set.
vi.mock("../src/judges.js", async () => ({
  evaluateWithPanel: (await import("./fixtures/scripted-judge.js"))
    .scriptedEvaluateWithPanel,
}));

const fixturesDir = resolve(import.meta.dirname, "fixtures");

function config(name: string) {
  return loadConfig(resolve(fixturesDir, name));
}

// picocolors emits nothing when stdout is not a TTY, but vitest's runner does
// not guarantee that, so every assertion below reads stripped text.
const ANSI = /\x1B\[[0-9;]*[A-Za-z]/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

function captureStdout(fn: () => void): string {
  const chunks: string[] = [];
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return stripAnsi(chunks.join(""));
}

async function captureStderr(fn: () => Promise<void>): Promise<string[]> {
  const chunks: string[] = [];
  const spy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      chunks.push(stripAnsi(String(chunk)));
      return true;
    });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return chunks;
}

function contractResult(over: Partial<ContractResult> = {}): ContractResult {
  return {
    contractName: "a-contract",
    status: "pass",
    observedRate: 0.9,
    ci: { lower: 0.8, upper: 0.95, center: 0.9, n: 20 },
    trialsEvaluated: 20,
    sprtStoppedEarly: false,
    gating: true,
    ...over,
  };
}

function suiteOf(
  contracts: readonly ContractResult[],
  status: SuiteResult["status"] = "pass",
  aborted = false,
): SuiteResult {
  return {
    status,
    studies: [
      {
        studyName: "a-study",
        contractResults: contracts,
        totalTrials: 20,
        errorCount: 0,
        aborted,
        durationMs: 1234.5,
      },
    ],
    durationMs: 1234.5,
  };
}

function render(contracts: readonly ContractResult[], ...rest: [SuiteResult["status"]?, boolean?]) {
  return captureStdout(() => formatResults(suiteOf(contracts, ...rest)));
}

function jsonContract(result: ContractResult): Record<string, unknown> {
  const parsed = JSON.parse(writeJsonOutput(suiteOf([result])));
  return parsed.studies[0].contracts[0];
}

// ── Existing rendering paths (regression cover) ──────────────

describe("formatResults", () => {
  it("renders name, status, rate, interval and trial count", () => {
    const out = render([
      contractResult({ contractName: "exits-cleanly", trialsEvaluated: 17 }),
    ]);

    expect(out).toContain("exits-cleanly");
    expect(out).toContain("PASS");
    expect(out).toContain("90.0%");
    expect(out).toContain("[CI: 80–95%]");
    expect(out).toContain("(17 trials)");
    expect(out).toContain("Suite: PASS");
  });

  it("marks an early stop and an aborted study", () => {
    expect(render([contractResult({ sprtStoppedEarly: true })])).toContain(
      "early stop",
    );

    const aborted = render(
      [contractResult({ status: "fail" })],
      "fail",
      true,
    );
    expect(aborted).toContain("ABORTED");
  });
});

// ── R9: the stop reason is named ─────────────────────────────

describe("stop reasons in text output", () => {
  const labelLimited = (over: Partial<ContractResult> = {}) =>
    contractResult({
      contractName: "judge-contract",
      status: "inconclusive",
      calibrated: true,
      judgedRate: 0.72,
      stopReason: "label-limited",
      goldSetSize: 20,
      pairedUnits: 20,
      ...over,
    });

  it("names a label-limited stop and the gold-set size that would resolve it", () => {
    const out = render([labelLimited({ labelsNeeded: 64 })]);

    expect(out).toContain("label-limited");
    expect(out).toContain("64");
    // 64 total against the 20 already judged is 44 more.
    expect(out).toContain("44 more");
  });

  it("counts the increment off paired units, not gold-set entries", () => {
    // A partially-judged gold set: 20 human labels, but only 15 of them carry
    // a judge verdict too. `labelsNeeded` is solved over the PAIRED counts, so
    // 15 is the number it is expressed against -- subtracting the 20 entries
    // would report 44 and understate what is actually needed.
    const out = render([
      labelLimited({ labelsNeeded: 64, goldSetSize: 20, pairedUnits: 15 }),
    ]);

    expect(out).toContain("64");
    expect(out).toContain("49 more");
    expect(out).not.toContain("44 more");
  });

  it("never claims a total that is already met", () => {
    // The solver assumes a bigger gold set errs at the rate this one does, so
    // its answer can land at or below the units already judged while the floor
    // still straddles. "(0 more) would resolve it" promises a remedy that has
    // been applied and did not work; "(-3 more)" is worse.
    const out = render([
      labelLimited({ labelsNeeded: 12, goldSetSize: 20, pairedUnits: 15 }),
    ]);

    expect(out).toContain("label-limited");
    expect(out).toMatch(/more gold labels would narrow it/);
    expect(out).toMatch(/already met/);
    expect(out).not.toMatch(/\(-?\d+ more\)/);
    expect(out).not.toMatch(/would resolve it/);
  });

  it("explains a band-centred threshold instead of printing a blank or a zero", () => {
    // The key is PRESENT and null: no gold-set size separates the threshold.
    const out = render([
      labelLimited({
        gating: false,
        advisoryReasons: ["calibration-floor"],
        labelsNeeded: null,
      }),
    ]);

    expect(out).toContain("label-limited");
    expect(out).toMatch(/no gold-set size/i);
    expect(out).not.toMatch(/\bnull\b/);
    expect(out).not.toMatch(/\b0 (more|gold labels)/);
  });

  it("says so plainly when a label-limited stop carries no estimate at all", () => {
    // The key is ABSENT: the floor is not why this contract is advisory, so no
    // labels-needed figure was ever computed. That is not the band-centred case.
    const out = render([labelLimited()]);

    expect(out).toContain("label-limited");
    expect(out).toMatch(/no estimate/i);
    expect(out).not.toMatch(/no gold-set size/i);
  });

  it("keeps the absent state distinct when the floor is not the advisory reason", () => {
    // Advisory for `certification`, so the floor was never the question and
    // U7 emits no `labelsNeeded` key. Saying "no gold-set size separates it"
    // here would be false -- more labels are exactly what would help.
    const out = render([
      labelLimited({
        gating: false,
        advisoryReasons: ["certification"],
        pairedUnits: 20,
      }),
    ]);

    expect(out).toMatch(/certif/i);
    expect(out).toMatch(/no estimate/i);
    expect(out).not.toMatch(/no gold-set size/i);
  });

  it("renders a sampling-limited stop distinctly from a label-limited one", () => {
    const sampling = render([
      labelLimited({ stopReason: "sampling-limited" }),
    ]);
    const label = render([labelLimited({ labelsNeeded: 64 })]);

    expect(sampling).toContain("sampling-limited");
    expect(sampling).not.toContain("label-limited");
    expect(sampling).toMatch(/more trials/i);
    expect(sampling).not.toMatch(/gold labels/i);
    expect(sampling).not.toBe(label);
  });

  it("says nothing extra about a decisive stop", () => {
    const out = render([
      contractResult({ calibrated: true, stopReason: "decisive" }),
    ]);
    expect(out).not.toContain("decisive");
    expect(out).not.toMatch(/stopped/i);
  });
});

// ── R12: advisory is not failure ─────────────────────────────

describe("advisory contracts in text output", () => {
  it("renders an advisory contract distinctly from a failing gating one", () => {
    const advisory = render([
      contractResult({
        contractName: "judge-contract",
        status: "fail",
        gating: false,
        calibrated: false,
        advisoryReasons: ["no-gold-set"],
      }),
    ]);
    const failing = render([
      contractResult({ contractName: "judge-contract", status: "fail" }),
    ]);

    // An advisory contract that would have failed must not read as a failure.
    expect(advisory).toContain("ADVISORY");
    expect(advisory).not.toContain("FAIL");
    expect(advisory).toMatch(/would fail/);
    expect(failing).toContain("FAIL");
    expect(failing).not.toContain("ADVISORY");
  });

  it("names why it is advisory and what would change that", () => {
    const out = render([
      contractResult({
        gating: false,
        advisoryReasons: ["no-gold-set"],
      }),
    ]);

    expect(out).toMatch(/no gold set/i);
    expect(out).toMatch(/gold_set/);
  });

  it("names every reason when a contract has more than one", () => {
    const out = render([
      contractResult({
        gating: false,
        advisoryReasons: ["marked-gold-set", "certification"],
        goldSetSize: 4,
      }),
    ]);

    expect(out).toMatch(/marked/i);
    expect(out).toMatch(/certif/i);
  });

  it("counts advisory contracts out of the suite summary", () => {
    const out = render(
      [
        contractResult({ contractName: "code-one" }),
        contractResult({
          contractName: "judge-one",
          status: "fail",
          gating: false,
          advisoryReasons: ["no-gold-set"],
        }),
      ],
      "pass",
    );

    expect(out).toContain("1/1 contracts satisfied");
    expect(out).toMatch(/1 advisory/);
  });
});

// ── JSON output ──────────────────────────────────────────────

describe("writeJsonOutput", () => {
  it("keeps the envelope fields it always had", () => {
    const parsed = JSON.parse(writeJsonOutput(suiteOf([contractResult()])));
    expect(parsed.version).toBe(1);
    expect(parsed.status).toBe("pass");
    expect(typeof parsed.durationMs).toBe("number");

    const study = parsed.studies[0];
    expect(study.name).toBe("a-study");
    expect(study.totalTrials).toBe(20);
    expect(study.errorCount).toBe(0);
    expect(study.aborted).toBe(false);
  });

  it("leaves an uncalibrated contract's shape unchanged apart from gating", () => {
    expect(Object.keys(jsonContract(contractResult()))).toEqual([
      "name",
      "status",
      "observedRate",
      "ci",
      "trialsEvaluated",
      "sprtStoppedEarly",
      "gating",
    ]);
  });

  it("carries gating, advisory reasons, stop reason and labels-needed", () => {
    const json = jsonContract(
      contractResult({
        status: "inconclusive",
        observedRate: 0.68,
        calibrated: true,
        judgedRate: 0.72,
        stopReason: "label-limited",
        gating: false,
        advisoryReasons: ["calibration-floor"],
        goldSetSize: 20,
        pairedUnits: 20,
        labelsNeeded: 64,
      }),
    );

    expect(json.gating).toBe(false);
    expect(json.advisoryReasons).toEqual(["calibration-floor"]);
    expect(json.stopReason).toBe("label-limited");
    expect(json.labelsNeeded).toBe(64);
    expect(json.goldSetSize).toBe(20);
    expect(json.pairedUnits).toBe(20);
    expect(json.calibrated).toBe(true);
    expect(json.judgedRate).toBe(0.72);
    // R4: the reported rate is the corrected one; the raw rate rides alongside.
    expect(json.observedRate).toBe(0.68);
  });

  it("distinguishes a null labels-needed from an absent one", () => {
    const centred = jsonContract(
      contractResult({
        gating: false,
        advisoryReasons: ["calibration-floor"],
        labelsNeeded: null,
      }),
    );
    expect("labelsNeeded" in centred).toBe(true);
    expect(centred.labelsNeeded).toBeNull();

    const other = jsonContract(
      contractResult({ gating: false, advisoryReasons: ["certification"] }),
    );
    expect("labelsNeeded" in other).toBe(false);
  });
});

// ── Pre-run disclosure and the one-time warning ──────────────

describe("pre-run disclosure", () => {
  const savedCI = process.env.CI;

  beforeEach(() => {
    resetScriptedJudge();
    delete process.env.CI;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GOOGLE_API_KEY;
  });

  afterEach(() => {
    if (savedCI === undefined) delete process.env.CI;
    else process.env.CI = savedCI;
  });

  const progressLine = /SPRT:|trial \d+\/\d+/;

  it("discloses gold-set size and floor before any trial output", async () => {
    programJudge("clear-gap", certifiedJudge(() => "pass"));
    programJudge("floor-guarded", certifiedJudge(() => "pass"));
    programJudge("uncalibrated", () => "pass");

    const chunks = await captureStderr(async () => {
      await runSuite(await config("calibrated-judge-config.yaml"), {
        json: false,
      });
    });

    const disclosure = chunks.findIndex((c) => c.includes("judge calibration"));
    const firstProgress = chunks.findIndex((c) => progressLine.test(c));

    expect(disclosure).toBeGreaterThanOrEqual(0);
    expect(firstProgress).toBeGreaterThanOrEqual(0);
    expect(disclosure).toBeLessThan(firstProgress);

    const before = chunks.slice(0, firstProgress).join("");
    // 20 labels at alpha_C 0.1333 put the floor at +/- 14.4% -- the reason the
    // 0.75 contract can never be decided, learned before trial 1.
    expect(before).toContain("floor-guarded");
    expect(before).toMatch(/20 gold labels/);
    expect(before).toMatch(/14\.4%/);
  }, 60_000);

  it("names a gold-set entry whose scenario could not be loaded", async () => {
    programJudge("gold-set-with-a-bad-path", certifiedJudge(() => "pass"));

    const chunks = await captureStderr(async () => {
      await runSuite(
        await config("advisory-unloadable-scenario-config.yaml"),
        { json: false },
      );
    });
    const text = chunks.join("");

    // Degrading the entry to an unrated unit is intended; doing it silently is
    // not. Without this line, five entries vanish from the pairing and a
    // typo'd path reads exactly like a judge disagreeing with a human label.
    expect(text).toContain(GOLD_SET_LOAD_FAILURE_PREFIX);
    expect(text).toContain("scenarios/no-such-scenario.yaml");
    expect(text).toContain("gold-set-with-a-bad-path");
  }, 60_000);

  it("says nothing about load failures when every gold-set scenario resolves", async () => {
    programJudge("half-judged-gold-set", (call) =>
      call.scenarioInput === "GOLD-B" ? "error" : "pass",
    );

    const chunks = await captureStderr(async () => {
      await runSuite(await config("advisory-partial-labels-config.yaml"), {
        json: false,
      });
    });

    // The same 15-of-20 pairing, reached by a judge error rather than a bad
    // path. The two are different diagnoses and must not print the same line.
    expect(chunks.join("")).not.toContain(GOLD_SET_LOAD_FAILURE_PREFIX);
  }, 60_000);

  it("prints nothing for a suite with no judge contracts", async () => {
    const chunks = await captureStderr(async () => {
      await runSuite(await config("valid-config.yaml"), { json: false });
    });

    expect(chunks.join("")).not.toContain("judge calibration");
    expect(chunks.join("")).not.toContain(NO_GOLD_SET_WARNING_HEADER);
  }, 30_000);
});

describe("no-gold-set warning", () => {
  const savedCI = process.env.CI;

  beforeEach(() => {
    resetScriptedJudge();
    delete process.env.CI;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GOOGLE_API_KEY;
  });

  afterEach(() => {
    if (savedCI === undefined) delete process.env.CI;
    else process.env.CI = savedCI;
  });

  function occurrences(text: string, needle: string): number {
    return text.split(needle).length - 1;
  }

  it("warns exactly once for a run with several judge contracts", async () => {
    programJudge("no-labels", () => "pass");
    programJudge("marked-labels", () => "pass");
    programJudge("weak-certification", () => "pass");
    programJudge("floor-too-wide", certifiedJudge(() => "pass"));
    programJudge("floor-with-a-gap", certifiedJudge(() => "pass"));

    const chunks = await captureStderr(async () => {
      await runSuite(await config("advisory-reasons-config.yaml"), {
        json: false,
      });
    });
    const text = chunks.join("");

    // Five judge contracts, four advisory reasons, but only ONE of them is
    // advisory for want of a gold set -- and the warning is per run regardless.
    expect(occurrences(text, NO_GOLD_SET_WARNING_HEADER)).toBe(1);
    expect(text).toContain("no-labels");
  }, 90_000);

  it("warns before the first trial of the run", async () => {
    programJudge("advisory-judge", () => "fail");

    const chunks = await captureStderr(async () => {
      await runSuite(await config("advisory-only-config.yaml"), {
        json: false,
      });
    });

    const warning = chunks.findIndex((c) =>
      c.includes(NO_GOLD_SET_WARNING_HEADER),
    );
    const firstProgress = chunks.findIndex((c) =>
      /SPRT:|trial \d+\/\d+/.test(c),
    );

    expect(warning).toBeGreaterThanOrEqual(0);
    expect(firstProgress).toBeGreaterThanOrEqual(0);
    expect(warning).toBeLessThan(firstProgress);
  }, 30_000);

  it("stays silent when every judge contract has a gold set, and separates labels from judged units", async () => {
    programJudge("half-judged-gold-set", (call) =>
      call.scenarioInput === "GOLD-B" ? "error" : "pass",
    );

    const chunks = await captureStderr(async () => {
      await runSuite(await config("advisory-partial-labels-config.yaml"), {
        json: false,
      });
    });
    const text = chunks.join("");

    expect(text).not.toContain(NO_GOLD_SET_WARNING_HEADER);

    // 20 entries but only 15 the judge ruled on -- materially different from a
    // 5-label gold set, and the disclosure has to say which it is.
    expect(text).toContain("20 gold labels (15 judged)");
  }, 60_000);
});
