import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { ConfigError } from "./errors.js";

// ── Command template parsing ─────────────────────────────────

export interface ParsedCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly scenarioPlaceholderIndex: number; // which arg contains {{scenario}}
}

function parseCommandTemplate(command: string): ParsedCommand {
  const parts = command.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    throw new ConfigError("Adapter command is empty");
  }

  const executable = parts[0]!;
  const args = parts.slice(1);
  const scenarioIndex = args.findIndex((a) => a.includes("{{scenario}}"));

  if (scenarioIndex === -1) {
    throw new ConfigError(
      'Adapter command must contain {{scenario}} placeholder',
    );
  }

  return {
    executable,
    args,
    scenarioPlaceholderIndex: scenarioIndex,
  };
}

// ── Zod schemas ──────────────────────────────────────────────

const AdapterSchema = z.object({
  command: z.string().min(1),
  timeout: z.number().int().positive().default(30_000),
});

const CodeContractSchema = z.object({
  name: z.string().min(1),
  type: z.literal("code"),
  assert: z.string().min(1).max(10_000),
  threshold: z.number().min(0.11).max(1.0).default(0.90),
  confidence: z.number().min(0.50).max(0.999).default(0.95),
  trials: z.number().int().positive().default(50),
});

const JudgeContractSchema = z.object({
  name: z.string().min(1),
  type: z.literal("judge"),
  rubric: z.string().min(1),
  judge_panel: z.number().int().positive().default(1),
  source: z.string().optional(),
  threshold: z.number().min(0.11).max(1.0).default(0.90),
  confidence: z.number().min(0.50).max(0.999).default(0.95),
  trials: z.number().int().positive().default(50),
});

const ContractSchema = z.discriminatedUnion("type", [
  CodeContractSchema,
  JudgeContractSchema,
]);

const JudgeProviderSchema = z.object({
  model: z.string().min(1),
});

const StudySchema = z.object({
  name: z.string().min(1),
  scenario: z.string().min(1),
  contracts: z.array(ContractSchema).min(1),
  max_error_rate: z.number().min(0).max(1).default(0.20),
});

const CerberusConfigSchema = z.object({
  adapter: AdapterSchema,
  judges: z.array(JudgeProviderSchema).default([]),
  studies: z.array(StudySchema).min(1),
  correction: z.enum(["bh", "bonferroni", "none"]).default("bh"),
});

// ── Inferred types ───────────────────────────────────────────

export type CerberusConfig = z.infer<typeof CerberusConfigSchema>;
export type StudyConfig = z.infer<typeof StudySchema>;
export type ContractConfig = z.infer<typeof ContractSchema>;
export type CodeContractConfig = z.infer<typeof CodeContractSchema>;
export type JudgeContractConfig = z.infer<typeof JudgeContractSchema>;
export type JudgeProviderConfig = z.infer<typeof JudgeProviderSchema>;

// ── Validated config (post-parsing) ──────────────────────────

export interface ValidatedConfig {
  readonly raw: CerberusConfig;
  readonly parsedCommand: ParsedCommand;
  readonly configDir: string; // directory of the config file (for resolving relative paths)
}

// ── Scenario ─────────────────────────────────────────────────

const ScenarioSchema = z.object({
  input: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
});

export type Scenario = z.infer<typeof ScenarioSchema>;

// ── Loader ───────────────────────────────────────────────────

export async function loadConfig(
  configPath: string,
): Promise<ValidatedConfig> {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf-8");
  } catch {
    throw new ConfigError(`Cannot read config file: ${configPath}`);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new ConfigError(`Invalid YAML in config: ${msg}`);
  }

  const result = CerberusConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new ConfigError(`Config validation failed:\n${issues}`);
  }

  const config = result.data;

  // Validate judge contracts have at least one judge configured
  const hasJudgeContracts = config.studies.some((s) =>
    s.contracts.some((c) => c.type === "judge"),
  );
  if (hasJudgeContracts && config.judges.length === 0) {
    throw new ConfigError(
      "Judge contracts require at least one judge in the 'judges' field",
    );
  }

  const parsedCommand = parseCommandTemplate(config.adapter.command);

  return {
    raw: config,
    parsedCommand,
    configDir: dirname(resolve(configPath)),
  };
}

export async function loadScenario(scenarioPath: string): Promise<Scenario> {
  let raw: string;
  try {
    raw = await readFile(scenarioPath, "utf-8");
  } catch {
    throw new ConfigError(`Cannot read scenario file: ${scenarioPath}`);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new ConfigError(`Invalid YAML in scenario: ${msg}`);
  }

  const result = ScenarioSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new ConfigError(`Scenario validation failed:\n${issues}`);
  }

  return result.data;
}

// Re-export schemas for testing/introspection
export {
  CerberusConfigSchema,
  ContractSchema,
  StudySchema,
  ScenarioSchema,
  AdapterSchema,
};
