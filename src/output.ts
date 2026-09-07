import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pc from "picocolors";
import type {
  SuiteResult,
  StudyResult,
  ContractResult,
  ContractDecision,
  AdvisoryReason,
} from "./types.js";

const isCI = !!process.env.CI;

// ── Progress display ─────────────────────────────────────────

/**
 * What the progress line needs from a contract, and nothing more. A calibrated
 * judge contract has no `SPRTState` to hand over -- it tracks a confidence
 * sequence and a three-way stop instead -- so the display reads the decision
 * directly rather than reaching through a state type only half the contracts
 * have.
 */
export interface ContractProgressState {
  readonly decision: ContractDecision;
  readonly successes: number;
  readonly failures: number;
}

export function displayProgress(
  studyName: string,
  trial: number,
  maxTrials: number,
  contractStates: ReadonlyMap<string, ContractProgressState>,
): void {
  if (isCI) {
    // CI mode: simple line logging
    const decided = [...contractStates.values()].filter(
      (s) => s.decision !== "continue",
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
    (s) => s.decision !== "continue",
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

// ── Pre-run disclosure (R12) ─────────────────────────────────
//
// Everything below goes to `process.stderr`. `process.stdout` is reserved for
// JSON output, and a run whose results are being piped into a parser must not
// have its calibration notes land in the same stream.

function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

/**
 * What a judge contract's certification said, in the shape the disclosure
 * needs. Built by the runner once certification is done and before the first
 * trial, so an unresolvable threshold is visible in the first second rather
 * than after a full budget of judge calls.
 */
export interface JudgeDisclosure {
  readonly contractName: string;
  readonly threshold: number;
  /** `null` when the contract has no gold set at all. */
  readonly goldSetSize: number | null;
  /** Entries the judge also ruled on. `null` with no gold set. */
  readonly pairedUnits: number | null;
  /** Half the calibration interval's width. `null` when nothing paired. */
  readonly floorHalfWidth: number | null;
  readonly gating: boolean;
  readonly advisoryReasons: readonly AdvisoryReason[];
  /** Meaningful only when `calibration-floor` is a reason; see R12. */
  readonly labelsNeeded: number | null;
}

/** Why a contract runs advisory, in one clause each (R12). */
const ADVISORY_CAUSE: Record<AdvisoryReason, string> = {
  "no-gold-set": "no gold set, so the judge has never been measured against humans",
  "marked-gold-set": "the gold set was marked unusable",
  certification: "the judge did not certify pass against its gold set",
  "calibration-floor": "the calibration interval alone straddles the threshold",
};

/** What would change that (R12). The floor's remedy is refined by R12's estimate. */
const ADVISORY_REMEDY: Record<AdvisoryReason, string> = {
  "no-gold-set": "add a `gold_set:` of human labels to let it gate",
  "marked-gold-set": "fix the gold set the loader rejected",
  certification: "sharpen the rubric or the judge until it agrees with the labels",
  "calibration-floor": "add gold labels to narrow the calibration interval",
};

function advisoryLines(
  reasons: readonly AdvisoryReason[],
  labelsNeeded: number | null,
  goldSetSize: number | undefined,
  hasLabelsEstimate: boolean,
): readonly string[] {
  return reasons.map((reason) => {
    const remedy =
      reason === "calibration-floor"
        ? labelsRemedy(labelsNeeded, goldSetSize, hasLabelsEstimate)
        : ADVISORY_REMEDY[reason];
    return `advisory (does not gate): ${ADVISORY_CAUSE[reason]} — ${remedy}`;
  });
}

/**
 * R12's labels estimate in words. The three cases are genuinely different
 * answers and none of them is a missing number:
 *
 * - a figure: that many labels in total closes the gap;
 * - present and `null`: the threshold sits on the calibration band's centre,
 *   where no gold-set size separates it;
 * - absent: the floor was never the reason, so nothing was ever solved for.
 */
function labelsRemedy(
  labelsNeeded: number | null,
  goldSetSize: number | undefined,
  hasEstimate: boolean,
): string {
  if (typeof labelsNeeded === "number") {
    const more =
      goldSetSize === undefined
        ? null
        : Math.max(0, labelsNeeded - goldSetSize);
    const increment = more === null ? "" : ` (${more} more)`;
    return `about ${labelsNeeded} gold labels in total${increment} would resolve it`;
  }
  if (hasEstimate) {
    return "the threshold sits on the centre of the calibration band, so no gold-set size separates it";
  }
  return "more gold labels would narrow it, though this run computed no estimate of how many";
}

function disclosureLine(d: JudgeDisclosure): string {
  const verdict = d.gating
    ? pc.green("gating")
    : pc.cyan(`advisory: ${d.advisoryReasons.map((r) => ADVISORY_CAUSE[r]).join("; ")}`);

  if (d.goldSetSize === null) {
    // The cause is already in the phrase "no gold set", so repeating the
    // advisory clause here would say it twice. Name the remedy instead.
    return `    ${d.contractName}: no gold set — ${pc.cyan(
      `advisory, cannot gate: ${ADVISORY_REMEDY["no-gold-set"]}`,
    )}`;
  }

  const paired =
    d.pairedUnits !== null && d.pairedUnits !== d.goldSetSize
      ? ` (${d.pairedUnits} judged)`
      : "";
  const floor =
    d.floorHalfWidth === null
      ? "no calibration floor (no labelled unit was judged)"
      : `calibration floor ±${formatPercent(d.floorHalfWidth)}`;

  return `    ${d.contractName}: ${d.goldSetSize} gold labels${paired}, ${floor} against a ${formatPercent(d.threshold)} threshold — ${verdict}`;
}

/**
 * The floor disclosure, printed once per study before its trial loop begins.
 * Silent for a study with no judge contracts, so a code-only suite reads
 * exactly as it did before.
 */
export function displayJudgeDisclosure(
  studyName: string,
  disclosures: readonly JudgeDisclosure[],
): void {
  if (disclosures.length === 0) return;

  const lines = [`  ${studyName}: judge calibration`];
  for (const d of disclosures) {
    lines.push(disclosureLine(d));
    if (d.advisoryReasons.includes("calibration-floor")) {
      lines.push(
        `      ${labelsRemedy(d.labelsNeeded, d.goldSetSize ?? undefined, true)}`,
      );
    }
  }
  process.stderr.write(`${lines.join("\n")}\n`);
}

/**
 * A stable, greppable first line for the one-time warning. Tests and CI log
 * scrapers match on this exact string, so it does not vary with the count.
 */
export const NO_GOLD_SET_WARNING_HEADER =
  "WARNING: judge contracts without a gold set cannot fail CI";

/**
 * Printed at most once per run, before the first trial, when the run contains a
 * judge contract that is advisory only because it has no gold set.
 *
 * No config in the wild has a gold set yet, so on upgrade every existing judge
 * contract goes advisory and a suite that fails CI today exits 0. That is the
 * intended behaviour, but it turns a red build green — the one direction a
 * change must never move silently. A team reading only the exit code or
 * grepping for a pass/fail line would otherwise see nothing at all.
 */
export function displayNoGoldSetWarning(
  contractNames: readonly string[],
): void {
  const n = contractNames.length;
  const rule = "─".repeat(64);
  const lines = [
    pc.yellow(rule),
    pc.yellow(pc.bold(NO_GOLD_SET_WARNING_HEADER)),
    "",
    `  ${n === 1 ? "1 judge contract has" : `${n} judge contracts have`} no human labels to calibrate against,`,
    "  so their verdicts are reported and then excluded from the exit code:",
    ...contractNames.map((name) => `    - ${name}`),
    "",
    "  A suite that failed on one of these before will now exit 0.",
    "  Give each contract a `gold_set:` of human labels to let it gate again.",
    pc.yellow(rule),
  ];
  process.stderr.write(`${lines.join("\n")}\n`);
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

/**
 * An advisory contract is NOT a failing one. It reports the verdict it would
 * have had, in lower case and without the failure badge, because nothing about
 * it drives CI's exit — reusing `FAIL` here would read as a red build.
 */
function wouldHaveBeen(status: ContractResult["status"]): string {
  return status === "inconclusive" ? "would be inconclusive" : `would ${status}`;
}

function contractBadge(result: ContractResult): string {
  if (result.gating) return statusBadge(result.status);
  return `${pc.cyan(pc.bold("ADVISORY"))} ${pc.dim(`(${wouldHaveBeen(result.status)})`)}`;
}

/**
 * R9's diagnosis: what stopped the contract, and what would move it.
 *
 * A contract that is BOTH advisory for the calibration floor and stopped
 * label-limited has one fact, not two -- the floor guard and the label-limited
 * stop are the same predicate. The advisory line already spells out the cause
 * and the remedy, so this line only names the stop.
 */
function stopReasonLine(result: ContractResult): string | null {
  if (result.stopReason === undefined || result.stopReason === "decisive") {
    return null;
  }
  if (result.stopReason === "sampling-limited") {
    return "stopped sampling-limited: the trial budget ran out while a decision was still reachable — more trials would resolve it";
  }
  if (result.advisoryReasons?.includes("calibration-floor")) {
    return "stopped label-limited: no decision was reachable, for the reason above";
  }
  return `stopped label-limited: the calibration interval alone straddles the threshold — ${labelsRemedy(
    result.labelsNeeded ?? null,
    result.goldSetSize,
    "labelsNeeded" in result,
  )}`;
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

  // Suite summary. The satisfied count is over the GATING contracts only:
  // an advisory contract cannot be unsatisfied in a way that matters here, and
  // counting it would make a vacuously passing suite look part-failed.
  const all = suiteResult.studies.flatMap((s) => s.contractResults);
  const gating = all.filter((c) => c.gating);
  const passedContracts = gating.filter((c) => c.status === "pass").length;
  const advisoryCount = all.length - gating.length;
  const advisoryNote =
    advisoryCount === 0
      ? ""
      : pc.cyan(`; ${advisoryCount} advisory, not gating`);

  process.stdout.write(
    `\nSuite: ${statusBadge(suiteResult.status)} (${passedContracts}/${gating.length} contracts satisfied${advisoryNote})\n`,
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
    const badge = contractBadge(result);
    const rate = formatPercent(result.observedRate).padStart(6);
    const ci = formatCI(result.ci);
    const trials = formatTrials(result);

    process.stdout.write(`  ${name}  ${badge}  ${rate} ${ci}  ${trials}\n`);

    // The diagnosis hangs under the contract it belongs to, so a reader never
    // has to infer why a contract will not gate or why it did not decide.
    const notes = [
      ...(result.gating
        ? []
        : advisoryLines(
            result.advisoryReasons ?? [],
            result.labelsNeeded ?? null,
            result.goldSetSize,
            "labelsNeeded" in result,
          )),
      ...(stopReasonLine(result) === null ? [] : [stopReasonLine(result)!]),
    ];
    for (const note of notes) {
      process.stdout.write(`      ${pc.dim(note)}\n`);
    }
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
        // Every field is whitelisted explicitly and the existing ones are
        // never renamed or dropped: `persistResult` writes these records under
        // `.cerberus/runs/`, and an old record must stay parseable by a new
        // reader. New fields are spread in only where they are defined, so an
        // uncalibrated contract's shape is today's plus `gating` and nothing
        // else. `labelsNeeded` keys off PRESENCE rather than value -- present
        // and `null` is its own answer (no gold-set size separates the
        // threshold), which absent would have flattened away.
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
          gating: c.gating,
          ...(c.calibrated === undefined ? {} : { calibrated: c.calibrated }),
          ...(c.judgedRate === undefined ? {} : { judgedRate: c.judgedRate }),
          ...(c.stopReason === undefined ? {} : { stopReason: c.stopReason }),
          ...(c.advisoryReasons === undefined
            ? {}
            : { advisoryReasons: c.advisoryReasons }),
          ...(c.goldSetSize === undefined ? {} : { goldSetSize: c.goldSetSize }),
          ...(c.pairedUnits === undefined ? {} : { pairedUnits: c.pairedUnits }),
          ...("labelsNeeded" in c ? { labelsNeeded: c.labelsNeeded ?? null } : {}),
        })),
      })),
      durationMs: Math.round(result.durationMs),
    },
    null,
    2,
  );
}

// ── Result persistence ────────────────────────────────────────

export async function persistResult(result: SuiteResult): Promise<string> {
  const dir = join(".cerberus", "runs");
  await mkdir(dir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = join(dir, `${timestamp}.json`);
  const json = writeJsonOutput(result);
  await writeFile(filePath, json + "\n", "utf-8");
  return filePath;
}
