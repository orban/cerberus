import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { runSuite } from "../src/runner.js";

const fixturesDir = resolve(import.meta.dirname, "fixtures");

describe("runSuite", () => {
  it("runs a simple study with echo agent and passes", async () => {
    const config = await loadConfig(resolve(fixturesDir, "valid-config.yaml"));
    const result = await runSuite(config, { json: false });

    expect(result.status).toBe("pass");
    expect(result.studies).toHaveLength(1);
    expect(result.studies[0]!.studyName).toBe("basic-test");
    expect(result.studies[0]!.contractResults).toHaveLength(1);
    expect(result.studies[0]!.contractResults[0]!.status).toBe("pass");
    expect(result.studies[0]!.contractResults[0]!.observedRate).toBe(1.0);
  });

  it("detects failures with crash agent", async () => {
    const config = await loadConfig(resolve(fixturesDir, "crash-config.yaml"));
    const result = await runSuite(config, { json: false });

    // Crash agent exits with code 1 -> all contracts fail
    expect(result.status).toBe("fail");
    const contract = result.studies[0]!.contractResults[0]!;
    expect(contract.status).toBe("fail");
    expect(contract.observedRate).toBe(0);
  });

  it("handles timeout agent", async () => {
    const config = await loadConfig(resolve(fixturesDir, "timeout-config.yaml"));
    const result = await runSuite(config, { json: false });

    // Slow agent should time out
    expect(result.studies[0]!.contractResults[0]!.status).toBe("fail");
  }, 15_000);

  it("SPRT stops early when evidence is clear", async () => {
    const config = await loadConfig(resolve(fixturesDir, "valid-config.yaml"));
    const result = await runSuite(config, { json: false });

    const contract = result.studies[0]!.contractResults[0]!;
    // With 100% pass rate, SPRT should stop well before 30 max trials
    expect(contract.sprtStoppedEarly).toBe(true);
    expect(contract.trialsEvaluated).toBeLessThan(30);
  });

  it("aborts study when error rate exceeds threshold", async () => {
    const config = await loadConfig(resolve(fixturesDir, "abort-config.yaml"));
    const result = await runSuite(config, { json: false });

    expect(result.studies[0]!.aborted).toBe(true);
  });
});
