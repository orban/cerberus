import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pc from "picocolors";
import type { SuiteResult, StudyResult, ContractResult, SPRTState } from "./types.js";

const isCI = !!process.env.CI;

// ── Progress display ─────────────────────────────────────────

interface ContractStateInfo {
  readonly sprtState: SPRTState;
  readonly successes: number;
  readonly failures: number;
}

export function displayProgress(
  studyName: string,
  trial: number,
  maxTrials: number,
  contractStates: Map<string, ContractStateInfo>,
): void {
  if (isCI) {
    // CI mode: simple line logging
    const decided = [...contractStates.values()].filter(
      (s) => s.sprtState.decision !== "continue",
    ).length;
    process.stderr.write(
      `  ${studyName}: trial ${trial}/${maxTrials} (${decided}/${contractStates.size} contracts decided)\n`,
    );
    return;
  }

  // TTY mode: overwrite line with progress bar
  const barWidth = 20;
  const filled = Math.round((trial / maxTrials) * barWidth);
  const bar = "\u2588".repeat(filled) + "\u2591".repeat(barWidth - filled);
  const decided = [...contractStates.values()].filter(
    (s) => s.sprtState.decision !== "continue",
  ).length;

  const sprtLabel =
    decided === contractStates.size
      ? pc.green("all decided")
      : `${decided}/${contractStates.size} decided`;

  process.stderr.write(
    `\r  ${bar}  ${trial}/${maxTrials}  SPRT: ${sprtLabel}`,
  );

  // Clear to end of line
  process.stderr.write("\x1B[K");
}

export function clearProgress(): void {
  if (!isCI) {
    process.stderr.write("\r\x1B[K");
  }
}

// ── Result table ─────────────────────────────────────────────

function statusBadge(status: string): string {
  switch (status) {
    case "pass":
      return pc.green(pc.bold("PASS"));
    case "fail":
      return pc.red(pc.bold("FAIL"));
    case "inconclusive":
      return pc.yellow(pc.bold("INCONCLUSIVE"));
    case "error":
      return pc.red(pc.bold("ERROR"));
    default:
      return status;
  }
}

function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function formatCI(ci: ContractResult["ci"]): string {
  const lower = Math.round(ci.lower * 100);
  const upper = Math.round(ci.upper * 100);
  return `[CI: ${lower}\u2013${upper}%]`;
}

function formatTrials(result: ContractResult): string {
  const suffix = result.sprtStoppedEarly ? ", early stop" : "";
  return `(${result.trialsEvaluated} trials${suffix})`;
}

export function formatResults(suiteResult: SuiteResult): void {
  clearProgress();
  process.stdout.write("\n");

  for (const study of suiteResult.studies) {
    formatStudy(study);
  }

  // Suite summary
  const totalContracts = suiteResult.studies.reduce(
    (sum, s) => sum + s.contractResults.length,
    0,
  );
  const passedContracts = suiteResult.studies.reduce(
    (sum, s) => sum + s.contractResults.filter((c) => c.status === "pass").length,
    0,
  );

  process.stdout.write(
    `\nSuite: ${statusBadge(suiteResult.status)} (${passedContracts}/${totalContracts} contracts satisfied)\n`,
  );
}

function formatStudy(study: StudyResult): void {
  if (study.aborted) {
    process.stdout.write(
      pc.red(`Study: ${study.studyName} (ABORTED - error rate exceeded)\n`),
    );
    return;
  }

  // Find max contract name length for alignment
  const maxNameLen = Math.max(
    ...study.contractResults.map((c) => c.contractName.length),
  );

  process.stdout.write(`Contracts:\n`);

  for (const result of study.contractResults) {
    const name = result.contractName.padEnd(maxNameLen);
    const badge = statusBadge(result.status);
    const rate = formatPercent(result.observedRate).padStart(6);
    const ci = formatCI(result.ci);
    const trials = formatTrials(result);

    process.stdout.write(`  ${name}  ${badge}  ${rate} ${ci}  ${trials}\n`);
  }
}

// ── JSON output ──────────────────────────────────────────────

export function writeJsonOutput(result: SuiteResult): string {
  return JSON.stringify(
    {
      version: 1,
      status: result.status,
      studies: result.studies.map((s) => ({
        name: s.studyName,
        totalTrials: s.totalTrials,
        errorCount: s.errorCount,
        aborted: s.aborted,
        durationMs: Math.round(s.durationMs),
        contracts: s.contractResults.map((c) => ({
          name: c.contractName,
          status: c.status,
          observedRate: c.observedRate,
          ci: {
            lower: c.ci.lower,
            upper: c.ci.upper,
          },
          trialsEvaluated: c.trialsEvaluated,
          sprtStoppedEarly: c.sprtStoppedEarly,
        })),
      })),
      durationMs: Math.round(result.durationMs),
    },
    null,
    2,
  );
}

// ── Result persistence ────────────────────────────────────────

export async function persistTimestampedJson(
  dir: string,
  json: string,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = join(dir, `${timestamp}.json`);
  await writeFile(filePath, json + "\n", "utf-8");
  return filePath;
}

export async function persistResult(result: SuiteResult): Promise<string> {
  return persistTimestampedJson(join(".cerberus", "runs"), writeJsonOutput(result));
}
