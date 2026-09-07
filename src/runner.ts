import { spawn } from "node:child_process";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

import type {
  ValidatedConfig,
  StudyConfig,
  ContractConfig,
  JudgeContractConfig,
  Scenario,
} from "./config.js";
import { loadScenario } from "./config.js";
import type {
  TrialOutput,
  TrialMeta,
  SuiteResult,
  StudyResult,
  ContractResult,
  ContractDecision,
  ConfidenceInterval,
  CalibratedState,
  GoldSetLoadResult,
  JudgeCertification,
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
import { certifyJudge } from "./calibration.js";
import {
  calibrationFloorStraddles,
  type RectifierEstimate,
} from "./correction.js";
import {
  createConfidenceSequence,
  updateConfidenceSequence,
} from "./sequence.js";
import { evaluateContract } from "./contracts.js";
import { displayProgress, type ContractProgressState } from "./output.js";

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
  fileName = "scenario.json",
): Promise<string> {
  const filePath = join(tempDir, fileName);
  await writeFile(filePath, JSON.stringify(scenario), "utf-8");
  return filePath;
}

// ── Calibrated judge contracts (KTD1, KTD2, KTD4, KTD8) ──────
//
// A judge contract backed by a gold set gates on the BIAS-CORRECTED true rate,
// not on the rate the judge says pass at. The corrected interval carries two
// terms: a sampling term from `sequence.ts` that shrinks with trials, and a
// calibration term from the gold set that does not. Their union bound is what
// makes the three-way stop honest — and what makes a run that no number of
// trials could decide say so instead of burning the budget.

/** KTD2's default: the calibration floor dominates at realistic gold-set sizes. */
const DEFAULT_CALIBRATION_ALPHA_SHARE = 2 / 3;

/**
 * The corrected point estimate moves a lot early, and a premature
 * label-limited verdict is expensive to disbelieve, so the in-run floor check
 * does not fire before this many observed trials. The predicate itself is
 * R10's, unchanged — there is no tolerance parameter anywhere.
 */
const MIN_TRIALS_FOR_LABEL_LIMITED = 50;

function clampUnit(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/**
 * `alpha_split`'s two fields are PROPORTIONS of the contract's alpha, not
 * absolute levels — the schema requires them to sum to 1. Total coverage is
 * `1 - alphaA - alphaC = confidence`. The split is fixed here, before the run,
 * and is never revisited once it is clear which term dominates.
 */
function resolveAlphaSplit(contract: JudgeContractConfig): {
  alphaA: number;
  alphaC: number;
} {
  const alpha = 1 - contract.confidence;
  const calibrationShare =
    contract.alpha_split?.alpha_c ?? DEFAULT_CALIBRATION_ALPHA_SHARE;
  const samplingShare =
    contract.alpha_split?.alpha_a ?? 1 - DEFAULT_CALIBRATION_ALPHA_SHARE;

  const alphaC = alpha * calibrationShare;
  const alphaA = alpha * samplingShare;

  if (!(alphaC > 0 && alphaC < 1) || !(alphaA > 0 && alphaA < 1)) {
    throw new CerberusError(
      `Contract "${contract.name}": alpha_split must give both the sampling and the calibration term a positive share of alpha`,
      EXIT_CODE.CONFIG_ERROR,
    );
  }

  return { alphaA, alphaC };
}

/**
 * The judge's verdict on each DISTINCT gold-set scenario.
 *
 * A gold set names scenarios and carries a human label for each; it carries no
 * agent output, so the only way to ask the judge what it thinks of a labelled
 * scenario is to run the agent on it and judge the result. Distinct scenarios
 * are run once each — `certifyJudge` keys verdicts by scenario, so repeated
 * entries share a verdict and cost nothing extra.
 *
 * A scenario that cannot be loaded, or that the judge errored on, is left out
 * of the map rather than guessed at: `reliabilityMatrix` reads an absent
 * verdict as a missing rating, which is what it is.
 */
async function judgeGoldSet(
  config: ValidatedConfig,
  contract: JudgeContractConfig,
  load: GoldSetLoadResult,
  tempDir: string,
): Promise<Map<string, boolean>> {
  const verdicts = new Map<string, boolean>();
  const entries = load.goldSet?.entries ?? [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (seen.has(entry.scenario)) continue;
    seen.add(entry.scenario);

    let scenario: Scenario;
    try {
      scenario = await loadScenario(join(config.configDir, entry.scenario));
    } catch {
      continue; // unrated unit, not a run-ending error
    }

    const scenarioFilePath = await writeScenarioFile(
      tempDir,
      scenario,
      `gold-${seen.size}.json`,
    );
    const output = await executeTrial(config, scenarioFilePath);
    const verdict = await evaluateContract(
      output,
      contract,
      scenario,
      config.raw.judges,
    );
    if (verdict.status === "error") continue;
    verdicts.set(entry.scenario, verdict.status === "pass");
  }

  return verdicts;
}

function createCalibratedState(
  certification: JudgeCertification,
  rectifier: RectifierEstimate,
  alphaA: number,
): CalibratedState {
  // R10: the floor guard runs before trial 1. When the calibration interval
  // alone already straddles the threshold, no number of trials can produce a
  // decisive result, so the contract starts stopped rather than spending a
  // budget of judge calls to arrive at the same answer.
  const refused = certification.floorStraddlesThreshold;

  return {
    sequence: createConfidenceSequence(alphaA),
    calibration: rectifier.interval,
    delta: rectifier.delta,
    decision: refused ? "inconclusive" : "continue",
    stopReason: refused ? "label-limited" : null,
    observations: 0,
    judgedSuccesses: 0,
    interval: { lower: 0, upper: 1, center: 0, n: 0 },
  };
}

/**
 * One trial's judged verdict, folded into the corrected estimand and passed
 * through the three-way stop. Immutable like `updateSPRT`: a new state out,
 * the old one untouched.
 */
function updateCalibrated(
  state: CalibratedState,
  contract: { readonly threshold: number; readonly trials: number },
  success: boolean,
): CalibratedState {
  if (state.decision !== "continue") return state;

  const sequence = updateConfidenceSequence(state.sequence, success ? 1 : 0);
  const observations = state.observations + 1;
  const judgedSuccesses = state.judgedSuccesses + (success ? 1 : 0);
  const judgedRate = judgedSuccesses / observations;

  // KTD2: union bound, summed ON ENDPOINTS. Wilson intervals are asymmetric,
  // so centre-plus-summed-half-widths is a different — and wrong — interval.
  // The sequence's raw running-intersection endpoints are used rather than its
  // reported (already unit-clamped) ones, because clamping a term before the
  // sum can move an endpoint the anti-conservative way. Clamp LAST, once.
  const lower = sequence.lower + state.calibration.lower;
  const upper = sequence.upper + state.calibration.upper;
  const interval: ConfidenceInterval = {
    lower: clampUnit(lower),
    upper: clampUnit(upper),
    center: clampUnit(judgedRate + state.delta),
    n: observations,
  };

  const threshold = contract.threshold;
  const stopped = (
    decision: ContractDecision,
    stopReason: CalibratedState["stopReason"],
  ): CalibratedState => ({
    ...state,
    sequence,
    observations,
    judgedSuccesses,
    interval,
    decision,
    stopReason,
  });

  if (interval.lower > threshold) return stopped("accept", "decisive");
  if (interval.upper < threshold) return stopped("reject", "decisive");

  // R8/R9's label-limited stop is R10's floor guard re-evaluated, so the guard
  // and the stop are ONE predicate and the diagnosis is true by construction.
  //
  // The first argument is the RUNNING JUDGED RATE, never the corrected
  // estimate: `calibration` is an interval on `delta`, the offset from judged
  // to corrected, so anchoring it on `judged + delta` would apply delta twice.
  if (
    observations >= MIN_TRIALS_FOR_LABEL_LIMITED &&
    calibrationFloorStraddles(judgedRate, state.calibration, threshold)
  ) {
    return stopped("inconclusive", "label-limited");
  }

  if (observations >= contract.trials) {
    return stopped("inconclusive", "sampling-limited");
  }

  return { ...state, sequence, observations, judgedSuccesses, interval };
}

// ── Study runner ─────────────────────────────────────────────

interface SPRTContractState {
  readonly kind: "sprt";
  readonly sprtConfig: SPRTConfig;
  sprtState: SPRTState;
  successes: number;
  failures: number;
}

interface CalibratedContractState {
  readonly kind: "calibrated";
  /** U5's certification, kept for the reporting units downstream. */
  readonly certification: JudgeCertification;
  calibrated: CalibratedState;
  successes: number;
  failures: number;
}

type ContractState = SPRTContractState | CalibratedContractState;

function contractDecision(state: ContractState): ContractDecision {
  return state.kind === "sprt"
    ? state.sprtState.decision
    : state.calibrated.decision;
}

function newSPRTState(contract: ContractConfig): SPRTContractState {
  const sprtConfig = sprtConfigFromContract(
    contract.threshold,
    contract.confidence,
  );
  return {
    kind: "sprt",
    sprtConfig,
    sprtState: createSPRT(sprtConfig),
    successes: 0,
    failures: 0,
  };
}

/**
 * Route each contract to its path. Code contracts are exact oracles and
 * uncalibrated judge contracts have nothing to correct with, so both keep the
 * SPRT path untouched; only a judge contract whose gold set yields a rectifier
 * gets the calibrated one.
 */
async function initContractStates(
  config: ValidatedConfig,
  study: StudyConfig,
  tempDir: string,
): Promise<Map<string, ContractState>> {
  const states = new Map<string, ContractState>();

  for (const contract of study.contracts) {
    if (contract.type === "judge") {
      const load = config.goldSets.get(`${study.name}::${contract.name}`);
      if (load) {
        const { alphaA, alphaC } = resolveAlphaSplit(contract);
        const certification = certifyJudge({
          goldSet: load,
          judgeVerdicts: await judgeGoldSet(config, contract, load, tempDir),
          threshold: contract.threshold,
          alphaC,
        });

        // A gold set the judge never ruled on pairs nothing, so there is no
        // rectifier and nothing to correct with — that contract falls back to
        // the raw judged rate like any uncalibrated one.
        const rectifier = certification.rectifier;
        if (rectifier !== null) {
          states.set(contract.name, {
            kind: "calibrated",
            certification,
            calibrated: createCalibratedState(certification, rectifier, alphaA),
            successes: 0,
            failures: 0,
          });
          continue;
        }
      }
    }

    states.set(contract.name, newSPRTState(contract));
  }

  return states;
}

function progressView(
  states: ReadonlyMap<string, ContractState>,
): Map<string, ContractProgressState> {
  const view = new Map<string, ContractProgressState>();
  for (const [name, state] of states) {
    view.set(name, {
      decision: contractDecision(state),
      successes: state.successes,
      failures: state.failures,
    });
  }
  return view;
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

  // Find max trials across all contracts
  const maxTrials = Math.max(...study.contracts.map((c) => c.trials));
  let errorCount = 0;
  let totalTrials = 0;
  let aborted = false;

  const contractResults: ContractResult[] = [];

  try {
    const scenarioFilePath = await writeScenarioFile(tempDir, scenario);

    // Certification runs before the first trial, so a contract the floor guard
    // refuses never spends a judge call on the trial loop at all.
    const contractStates = await initContractStates(config, study, tempDir);

    for (let trial = 0; trial < maxTrials; trial++) {
      // Check if all contracts have decided
      const allDecided = [...contractStates.values()].every(
        (s) => contractDecision(s) !== "continue",
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
        if (contractDecision(state) !== "continue") continue;

        if (state.kind === "sprt") {
          if (trial >= contract.trials) continue;

          const verdict = await evaluateContract(output, contract, scenario, config.raw.judges);
          const success = verdict.status === "pass";

          if (success) {
            state.successes++;
          } else {
            state.failures++;
          }

          state.sprtState = updateSPRT(state.sprtState, state.sprtConfig, success);
          continue;
        }

        // The calibrated budget counts OBSERVED trials, which errors do not
        // advance, so it cannot be read off the loop counter.
        if (state.calibrated.observations >= contract.trials) continue;

        const verdict = await evaluateContract(output, contract, scenario, config.raw.judges);

        // KTD8: a judge API failure is availability noise, not accuracy
        // evidence. Folding it in as a failure would contaminate the corrected
        // rate with an error process the gold set never calibrated against, so
        // it advances neither the sequence nor the trial count.
        if (verdict.status === "error") continue;

        const success = verdict.status === "pass";
        if (success) {
          state.successes++;
        } else {
          state.failures++;
        }

        state.calibrated = updateCalibrated(state.calibrated, contract, success);
      }

      // Display progress
      if (!isCI) {
        displayProgress(study.name, trial + 1, maxTrials, progressView(contractStates));
      }
    }

    // Build contract results with confidence intervals
    for (const contract of study.contracts) {
      const state = contractStates.get(contract.name)!;
      const decision = contractDecision(state);

      let status: "pass" | "fail" | "inconclusive";
      if (aborted) {
        status = "fail";
      } else if (decision === "accept") {
        status = "pass";
      } else if (decision === "reject") {
        status = "fail";
      } else {
        status = "inconclusive";
      }

      if (state.kind === "sprt") {
        const total = state.successes + state.failures;
        const result: ContractResult = {
          contractName: contract.name,
          status,
          observedRate: total > 0 ? state.successes / total : 0,
          ci: wilsonScoreInterval(state.successes, total, contract.confidence),
          trialsEvaluated: total,
          sprtStoppedEarly: decision !== "continue" && total < contract.trials,
        };
        // Judge contracts only, so a code contract's shape is byte-identical
        // to what it was before this unit.
        contractResults.push(
          contract.type === "judge" ? { ...result, calibrated: false } : result,
        );
        continue;
      }

      const { observations, judgedSuccesses, interval, delta, stopReason } =
        state.calibrated;
      const judgedRate = observations > 0 ? judgedSuccesses / observations : 0;

      contractResults.push({
        contractName: contract.name,
        status,
        // R4: with a gold set, the reported rate is the corrected estimate.
        observedRate: observations > 0 ? clampUnit(judgedRate + delta) : 0,
        ci: interval,
        trialsEvaluated: observations,
        sprtStoppedEarly: decision !== "continue" && observations < contract.trials,
        calibrated: true,
        ...(stopReason === null ? {} : { stopReason }),
        judgedRate,
      });
    }
  } finally {
    // Cleanup temp dir
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
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
