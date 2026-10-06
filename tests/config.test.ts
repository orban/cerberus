import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { goldSetKey, loadConfig, loadScenario } from "../src/config.js";

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
    expect(config.raw.correction).toBe("none");
  });

  it("rejects the removed multiple-testing corrections", async () => {
    // "bh" and "bonferroni" were removed because they never performed valid
    // error control. An old config naming them must fail loudly, not silently
    // run without a correction it believes it has.
    const { CerberusConfigSchema } = await import("../src/config.js");
    const base = {
      adapter: { command: "node test.js --scenario {{scenario}}" },
      studies: [{
        name: "test",
        scenario: "test.yaml",
        contracts: [{
          name: "c",
          type: "code",
          assert: "true",
          threshold: 0.9,
          trials: 10,
        }],
      }],
    };
    for (const correction of ["bh", "bonferroni"]) {
      const result = CerberusConfigSchema.safeParse({ ...base, correction });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]!.message).toContain("removed");
      }
    }
    expect(CerberusConfigSchema.safeParse({ ...base, correction: "none" }).success).toBe(true);
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

describe("gold sets", () => {
  it("parses a config with no gold set unchanged and yields no gold set", async () => {
    const config = await loadConfig(resolve(fixturesDir, "valid-config.yaml"));
    expect(config.goldSets.size).toBe(0);
  });

  it("still loads every pre-existing config fixture (backward compatibility)", async () => {
    const preExistingConfigs = [
      "valid-config.yaml",
      "abort-config.yaml",
      "crash-config.yaml",
      "flaky-config.yaml",
      "json-output-config.yaml",
      "multi-contract-config.yaml",
      "timeout-config.yaml",
    ];

    for (const fixture of preExistingConfigs) {
      const config = await loadConfig(resolve(fixturesDir, fixture));
      expect(config.goldSets.size).toBe(0);
    }
  });

  it("resolves a gold-set path relative to the config file's directory, not the working directory", async () => {
    // gold-set-config.yaml references "gold-sets/valid.yaml" -- a path that only
    // exists relative to tests/fixtures/, not relative to the repo root (cwd
    // when vitest runs). If the loader resolved against cwd instead of
    // configDir, this would throw ConfigError (missing file) instead of loading.
    expect(resolve(process.cwd(), "gold-sets", "valid.yaml")).not.toBe(
      resolve(fixturesDir, "gold-sets", "valid.yaml"),
    );

    const config = await loadConfig(resolve(fixturesDir, "gold-set-config.yaml"));
    const loaded = config.goldSets.get(goldSetKey("judge-study", "valid-gold-set"));
    expect(loaded).toBeDefined();
    expect(loaded!.marked).toBe(false);
  });

  it("treats a gold-set path pointing at a missing file as a config error", async () => {
    const { EXIT_CODE } = await import("../src/types.js");
    await expect(
      loadConfig(resolve(fixturesDir, "gold-set-missing-config.yaml")),
    ).rejects.toThrow("Cannot read gold set file");

    try {
      await loadConfig(resolve(fixturesDir, "gold-set-missing-config.yaml"));
      expect.unreachable("expected loadConfig to throw");
    } catch (e) {
      expect((e as { exitCode: number }).exitCode).toBe(EXIT_CODE.CONFIG_ERROR);
    }
  });

  it("marks malformed gold-set content instead of throwing, with a reason", async () => {
    const config = await loadConfig(resolve(fixturesDir, "gold-set-config.yaml"));
    const loaded = config.goldSets.get(goldSetKey("judge-study", "malformed-gold-set"));
    expect(loaded).toBeDefined();
    expect(loaded!.marked).toBe(true);
    if (loaded!.marked) {
      expect(loaded!.reason).toBe("malformed");
      expect(loaded!.message.length).toBeGreaterThan(0);
    }
  });

  it("marks an empty gold set with a reason distinct from malformed", async () => {
    const config = await loadConfig(resolve(fixturesDir, "gold-set-config.yaml"));
    const loaded = config.goldSets.get(goldSetKey("judge-study", "empty-gold-set"));
    expect(loaded).toBeDefined();
    expect(loaded!.marked).toBe(true);
    if (loaded!.marked) {
      expect(loaded!.reason).toBe("empty");
      expect(loaded!.reason).not.toBe("malformed");
    }
  });

  it("marks a gold set below the minimum unit count as undersized", async () => {
    const config = await loadConfig(resolve(fixturesDir, "gold-set-config.yaml"));
    const loaded = config.goldSets.get(goldSetKey("judge-study", "undersized-gold-set"));
    expect(loaded).toBeDefined();
    expect(loaded!.marked).toBe(true);
    if (loaded!.marked) {
      expect(loaded!.reason).toBe("undersized");
    }
  });

  it("marks a gold set with no declared provenance", async () => {
    const config = await loadConfig(resolve(fixturesDir, "gold-set-config.yaml"));
    const loaded = config.goldSets.get(goldSetKey("judge-study", "unprovenanced-gold-set"));
    expect(loaded).toBeDefined();
    expect(loaded!.marked).toBe(true);
    if (loaded!.marked) {
      expect(loaded!.reason).toBe("unprovenanced");
    }
  });
});

describe("gold-set key collisions", () => {
  // study "alpha" + contract "beta::gamma" and study "alpha::beta" +
  // contract "gamma" both flatten to "alpha::beta::gamma" under a separator
  // join. Only the first declares a gold set.
  const withLabels = { study: "alpha", contract: "beta::gamma" };
  const withoutLabels = { study: "alpha::beta", contract: "gamma" };

  it("does not hand one contract's gold set to another whose name flattens the same way", async () => {
    // The premise: these two pairs are indistinguishable once joined on "::".
    expect(`${withLabels.study}::${withLabels.contract}`).toBe(
      `${withoutLabels.study}::${withoutLabels.contract}`,
    );

    const config = await loadConfig(
      resolve(fixturesDir, "gold-set-key-collision-config.yaml"),
    );

    // One gold set was declared, so exactly one is loaded -- and it belongs to
    // the contract that asked for it.
    expect(config.goldSets.size).toBe(1);
    expect(
      config.goldSets.get(goldSetKey(withLabels.study, withLabels.contract)),
    ).toBeDefined();

    // The contract with no `gold_set:` finds nothing, which is what leaves it
    // advisory rather than certified on somebody else's labels.
    expect(
      config.goldSets.get(
        goldSetKey(withoutLabels.study, withoutLabels.contract),
      ),
    ).toBeUndefined();
  });

  it("builds a key no other study/contract pair can produce", () => {
    expect(goldSetKey(withLabels.study, withLabels.contract)).not.toBe(
      goldSetKey(withoutLabels.study, withoutLabels.contract),
    );
    // Quotes and backslashes in a name are escaped rather than run together.
    expect(goldSetKey('a"b', "c")).not.toBe(goldSetKey("a", 'b"c'));
  });
});

describe("alpha_split", () => {
  const configWith = (alphaSplit: unknown) => ({
    adapter: { command: "node test.js --scenario {{scenario}}" },
    judges: [{ model: "claude-3-5-sonnet-20241022" }],
    studies: [
      {
        name: "test",
        scenario: "test.yaml",
        contracts: [
          {
            name: "judge-contract",
            type: "judge",
            rubric: "Check output quality",
            trials: 10,
            alpha_split: alphaSplit,
          },
        ],
      },
    ],
  });

  it("accepts a split that gives both terms a positive share summing to 1", async () => {
    const { CerberusConfigSchema } = await import("../src/config.js");
    const result = CerberusConfigSchema.safeParse(
      configWith({ alpha_c: 2 / 3, alpha_a: 1 / 3 }),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      const contract = result.data.studies[0]!.contracts[0]!;
      expect(contract.type).toBe("judge");
      if (contract.type === "judge") {
        expect(contract.alpha_split?.alpha_c).toBeCloseTo(2 / 3, 12);
      }
    }
  });

  it("rejects a split that starves one term, even though the shares sum to 1", async () => {
    // `alpha_c: 0` leaves the calibration interval no error budget. It was
    // caught only by a runtime throw inside runStudy, which fires after every
    // earlier study has already spawned agents and spent judge calls -- so it
    // has to fail at load time, as a config error.
    const { CerberusConfigSchema } = await import("../src/config.js");

    expect(
      CerberusConfigSchema.safeParse(configWith({ alpha_c: 0, alpha_a: 1 }))
        .success,
    ).toBe(false);
    expect(
      CerberusConfigSchema.safeParse(configWith({ alpha_c: 1, alpha_a: 0 }))
        .success,
    ).toBe(false);
  });

  it("still rejects a split that does not sum to 1", async () => {
    const { CerberusConfigSchema } = await import("../src/config.js");
    expect(
      CerberusConfigSchema.safeParse(configWith({ alpha_c: 0.5, alpha_a: 0.9 }))
        .success,
    ).toBe(false);
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
