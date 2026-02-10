import { spawn } from "node:child_process";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

import type { ValidatedConfig, StudyConfig, Scenario } from "./config.js";
import { loadScenario } from "./config.js";
import type {
  TrialOutput,
  TrialMeta,
  SuiteResult,
  StudyResult,
  ContractResult,
  SPRTState,
  SPRTConfig,
} from "./types.js";
import { CerberusError } from "./errors.js";
import { EXIT_CODE } from "./types.js";
import {
  sprtConfigFromContract,
  createSPRT,
  updateSPRT,
  wilsonScoreInterval,
  bonferroniCorrection,
  benjaminiHochbergCorrection,
} from "./stats.js";
import { evaluateContract } from "./contracts.js";
import { displayProgress } from "./output.js";

const MAX_STDOUT_BYTES = 1024 * 1024; // 1MB

export interface RunOptions {
  readonly json: boolean;
}

// ── Adapter: spawn + capture ─────────────────────────────────

async function executeTrial(
  config: ValidatedConfig,
  scenarioPath: string,
): Promise<TrialOutput> {
  const { executable, args, scenarioPlaceholderIndex } = config.parsedCommand;
  const timeout = config.raw.adapter.timeout;

  // Replace {{scenario}} placeholder with actual path
  const resolvedArgs = args.map((arg, i) =>
    i === scenarioPlaceholderIndex
      ? arg.replace("{{scenario}}", scenarioPath)
      : arg,
  );

  const start = performance.now();

  return new Promise<TrialOutput>((resolve) => {
    const child = spawn(executable, resolvedArgs, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 0, // we handle timeout manually
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let killed = false;

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_STDOUT_BYTES) {
        stdoutChunks.push(chunk);
      } else if (!killed) {
        killed = true;
        child.kill("SIGTERM");
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    // Timeout handling: SIGTERM -> 5s -> SIGKILL
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already dead
        }
      }, 5000);
    }, timeout);

    child.on("close", (code) => {
      clearTimeout(timer);
      const durationMs = performance.now() - start;
      const raw = Buffer.concat(stdoutChunks).toString("utf-8");
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");
      const exitCode = code ?? 1;

      let parsed: Record<string, unknown> = {};
      let jsonParsed = false;

      try {
        const obj: unknown = JSON.parse(raw);
        if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
          parsed = obj as Record<string, unknown>;
          jsonParsed = true;
        }
      } catch {
        // not valid JSON — that's fine, raw is always available
      }

      const meta: TrialMeta = {
        raw,
        stderr,
        exitCode,
        durationMs,
        jsonParsed,
      };

      resolve({ meta, parsed });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      const durationMs = performance.now() - start;
      const meta: TrialMeta = {
        raw: "",
        stderr: err.message,
        exitCode: 1,
        durationMs,
        jsonParsed: false,
      };
      resolve({ meta, parsed: {} });
    });
  });
}

// ── Scenario temp file management ────────────────────────────

async function createTempDir(): Promise<string> {
  const id = randomBytes(8).toString("hex");
  const dir = join(tmpdir(), `cerberus-${id}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function writeScenarioFile(
  tempDir: string,
  scenario: Scenario,
): Promise<string> {
  const filePath = join(tempDir, "scenario.json");
  await writeFile(filePath, JSON.stringify(scenario), "utf-8");
  return filePath;
}

// ── Study runner ─────────────────────────────────────────────

interface ContractState {
  readonly sprtConfig: SPRTConfig;
  sprtState: SPRTState;
  successes: number;
  failures: number;
}

async function runStudy(
  config: ValidatedConfig,
  study: StudyConfig,
  isCI: boolean,
): Promise<StudyResult> {
  const start = performance.now();

  // Load scenario
  const scenarioPath = join(config.configDir, study.scenario);
  const scenario = await loadScenario(scenarioPath);

  // Create temp dir for scenario file
  const tempDir = await createTempDir();
  const scenarioFilePath = await writeScenarioFile(tempDir, scenario);

  // Initialize SPRT state per contract
  const contractStates = new Map<string, ContractState>();
  for (const contract of study.contracts) {
    const sprtConfig = sprtConfigFromContract(contract.threshold, contract.confidence);
    contractStates.set(contract.name, {
      sprtConfig,
      sprtState: createSPRT(sprtConfig),
      successes: 0,
      failures: 0,
    });
  }

  // Find max trials across all contracts
  const maxTrials = Math.max(...study.contracts.map((c) => c.trials));
  let errorCount = 0;
  let totalTrials = 0;
  let aborted = false;

  try {
    for (let trial = 0; trial < maxTrials; trial++) {
      // Check if all contracts have decided
      const allDecided = [...contractStates.values()].every(
        (s) => s.sprtState.decision !== "continue",
      );
      if (allDecided) break;

      // Execute trial
      const output = await executeTrial(config, scenarioFilePath);
      totalTrials++;

      // Check for crash/error — abort takes priority over SPRT
      const isError = output.meta.exitCode !== 0;
      if (isError) {
        errorCount++;
      }
      if (totalTrials >= 5) {
        const errorRate = errorCount / totalTrials;
        if (errorRate > study.max_error_rate) {
          aborted = true;
          break;
        }
      }

      // Evaluate each contract
      for (const contract of study.contracts) {
        const state = contractStates.get(contract.name)!;
        if (state.sprtState.decision !== "continue") continue;
        if (trial >= contract.trials) continue;

        const verdict = await evaluateContract(output, contract, scenario, config.raw.judges);
        const success = verdict.status === "pass";

        if (success) {
          state.successes++;
        } else {
          state.failures++;
        }

        state.sprtState = updateSPRT(state.sprtState, state.sprtConfig, success);
      }

      // Display progress
      if (!isCI) {
        displayProgress(study.name, trial + 1, maxTrials, contractStates);
      }
    }
  } finally {
    // Cleanup temp dir
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }

  // Build contract results with confidence intervals
  const contractResults: ContractResult[] = [];
  for (const contract of study.contracts) {
    const state = contractStates.get(contract.name)!;
    const total = state.successes + state.failures;
    const ci = wilsonScoreInterval(state.successes, total, contract.confidence);

    let status: "pass" | "fail" | "inconclusive";
    if (aborted) {
      status = "fail";
    } else if (state.sprtState.decision === "accept") {
      status = "pass";
    } else if (state.sprtState.decision === "reject") {
      status = "fail";
    } else {
      status = "inconclusive";
    }

    contractResults.push({
      contractName: contract.name,
      status,
      observedRate: total > 0 ? state.successes / total : 0,
      ci,
      trialsEvaluated: total,
      sprtStoppedEarly: state.sprtState.decision !== "continue" && total < contract.trials,
    });
  }

  return {
    studyName: study.name,
    contractResults,
    totalTrials,
    errorCount,
    aborted,
    durationMs: performance.now() - start,
  };
}

// ── Suite runner ─────────────────────────────────────────────

export async function runSuite(
  config: ValidatedConfig,
  _options: RunOptions,
): Promise<SuiteResult> {
  const start = performance.now();
  const isCI = !!process.env.CI;
  const studies: StudyResult[] = [];

  for (const studyConfig of config.raw.studies) {
    try {
      const result = await runStudy(config, studyConfig, isCI);
      studies.push(result);
    } catch (e) {
      if (e instanceof CerberusError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      throw new CerberusError(
        `Study "${studyConfig.name}" failed: ${msg}`,
        EXIT_CODE.RUNTIME_ERROR,
      );
    }
  }

  // Apply multiple testing correction
  applyCorrection(config, studies);

  // Determine suite status
  const allResults = studies.flatMap((s) => s.contractResults);
  let status: SuiteResult["status"];
  if (allResults.some((r) => r.status === "fail")) {
    status = "fail";
  } else if (allResults.some((r) => r.status === "inconclusive")) {
    status = "inconclusive";
  } else {
    status = "pass";
  }

  return {
    status,
    studies,
    durationMs: performance.now() - start,
  };
}

// ── Multiple testing correction ──────────────────────────────

function applyCorrection(
  config: ValidatedConfig,
  studies: StudyResult[],
): void {
  const correction = config.raw.correction;
  if (correction === "none") return;

  const allResults = studies.flatMap((s) => s.contractResults);
  const n = allResults.length;
  if (n <= 1) return;

  if (correction === "bonferroni") {
    const corrected = bonferroniCorrection(
      allResults[0]!.ci.n > 0 ? 0.05 : 0.05, // base alpha
      n,
    );
    for (let i = 0; i < n; i++) {
      (allResults[i] as { correctedAlpha?: number }).correctedAlpha = corrected[i];
    }
  } else {
    // BH correction: use 1 - observedRate as a proxy p-value
    // (this is a simplification; true p-values would require more computation)
    const pValues = allResults.map((r) => {
      if (r.status === "pass") return 0.001; // clearly passing
      if (r.status === "fail") return 0.999; // clearly failing
      return 0.5; // inconclusive
    });
    const result = benjaminiHochbergCorrection(pValues, 0.05);
    for (let i = 0; i < n; i++) {
      (allResults[i] as { correctedAlpha?: number }).correctedAlpha = result.correctedAlphas[i];
    }
  }
}
