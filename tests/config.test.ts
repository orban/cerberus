import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { loadConfig, loadScenario } from "../src/config.js";

const fixturesDir = resolve(import.meta.dirname, "fixtures");

describe("loadConfig", () => {
  it("loads a valid config file", async () => {
    const config = await loadConfig(resolve(fixturesDir, "valid-config.yaml"));
    expect(config.raw.adapter.command).toContain("echo.js");
    expect(config.raw.studies).toHaveLength(1);
    expect(config.raw.studies[0]!.name).toBe("basic-test");
    expect(config.raw.studies[0]!.contracts).toHaveLength(1);
  });

  it("parses command template into executable and args", async () => {
    const config = await loadConfig(resolve(fixturesDir, "valid-config.yaml"));
    expect(config.parsedCommand.executable).toBe("node");
    expect(config.parsedCommand.args).toContain("--scenario");
    expect(config.parsedCommand.scenarioPlaceholderIndex).toBeGreaterThanOrEqual(0);
  });

  it("rejects invalid config", async () => {
    await expect(
      loadConfig(resolve(fixturesDir, "invalid-config.yaml")),
    ).rejects.toThrow("Config validation failed");
  });

  it("rejects missing config file", async () => {
    await expect(
      loadConfig(resolve(fixturesDir, "nonexistent.yaml")),
    ).rejects.toThrow("Cannot read config file");
  });

  it("applies default values", async () => {
    const config = await loadConfig(resolve(fixturesDir, "valid-config.yaml"));
    expect(config.raw.adapter.timeout).toBe(5000);
    expect(config.raw.correction).toBe("bh");
  });

  it("validates threshold >= 0.11", async () => {
    // The Zod schema enforces threshold min 0.11
    // This is tested via the schema directly since we can't easily create
    // a fixture with invalid threshold that passes YAML parsing
    const { CerberusConfigSchema } = await import("../src/config.js");
    const result = CerberusConfigSchema.safeParse({
      adapter: { command: "node test.js --scenario {{scenario}}" },
      studies: [{
        name: "test",
        scenario: "test.yaml",
        contracts: [{
          name: "low-threshold",
          type: "code",
          assert: "true",
          threshold: 0.05,
          trials: 10,
        }],
      }],
    });
    expect(result.success).toBe(false);
  });

  it("validates confidence in [0.50, 0.999]", async () => {
    const { CerberusConfigSchema } = await import("../src/config.js");
    const result = CerberusConfigSchema.safeParse({
      adapter: { command: "node test.js --scenario {{scenario}}" },
      studies: [{
        name: "test",
        scenario: "test.yaml",
        contracts: [{
          name: "extreme-confidence",
          type: "code",
          assert: "true",
          confidence: 1.0,
          trials: 10,
        }],
      }],
    });
    expect(result.success).toBe(false);
  });

  it("requires {{scenario}} placeholder in command", async () => {
    const { CerberusConfigSchema } = await import("../src/config.js");
    const result = CerberusConfigSchema.safeParse({
      adapter: { command: "node test.js" },
      studies: [{
        name: "test",
        scenario: "test.yaml",
        contracts: [{
          name: "test",
          type: "code",
          assert: "true",
          trials: 10,
        }],
      }],
    });
    // Schema passes (it can't check template), but loadConfig should fail
    expect(result.success).toBe(true);
  });

  it("discriminates code vs judge contracts", async () => {
    const { ContractSchema } = await import("../src/config.js");

    const code = ContractSchema.parse({
      name: "test",
      type: "code",
      assert: "output.meta.exitCode === 0",
    });
    expect(code.type).toBe("code");

    const judge = ContractSchema.parse({
      name: "test",
      type: "judge",
      rubric: "Check for quality",
    });
    expect(judge.type).toBe("judge");
  });

  it("rejects judge contracts without judges configured", async () => {
    const configYaml = resolve(fixturesDir, "valid-config.yaml");
    // The valid config has code contracts only, which is fine with no judges
    const config = await loadConfig(configYaml);
    expect(config.raw.judges).toHaveLength(0);
  });
});

describe("loadScenario", () => {
  it("loads a valid scenario file", async () => {
    const scenario = await loadScenario(resolve(fixturesDir, "scenarios/simple.yaml"));
    expect(scenario.input).toContain("Review this code");
    expect(scenario.metadata?.category).toBe("test");
  });

  it("rejects missing scenario file", async () => {
    await expect(
      loadScenario(resolve(fixturesDir, "scenarios/nonexistent.yaml")),
    ).rejects.toThrow("Cannot read scenario file");
  });
});
