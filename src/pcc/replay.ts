import { readFile } from "node:fs/promises";
import { EXIT_CODE } from "../types.js";
import { CerberusError, ConfigError } from "../errors.js";
import type { CheckResult, CheckVerdict } from "./types.js";
import { runCheck } from "./check.js";
import { runGit } from "./git.js";
import { persistCheck } from "./report.js";

// Historical replay (PRD §17 Phase 0): run the analysis over past ranges in
// batch and aggregate, so policies can be tuned before anyone enables gating.

export interface ReplayOptions {
  readonly cwd: string;
  readonly rangesFile?: string;
  readonly merges?: number;
  readonly policyPath?: string;
  readonly out?: (line: string) => void;
}

export interface ReplayRow {
  readonly range: string;
  readonly verdict: CheckVerdict | "runtime-error";
  readonly error?: string;
  readonly result?: CheckResult;
}

async function resolveRanges(options: ReplayOptions): Promise<string[]> {
  if (options.rangesFile !== undefined) {
    let raw: string;
    try {
      raw = await readFile(options.rangesFile, "utf-8");
    } catch {
      throw new ConfigError(`Cannot read ranges file: ${options.rangesFile}`);
    }
    const ranges = raw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));
    if (ranges.length === 0) {
      throw new ConfigError(`Ranges file is empty: ${options.rangesFile}`);
    }
    return ranges;
  }

  const n = options.merges ?? 0;
  if (!Number.isInteger(n) || n < 1) {
    throw new ConfigError(`Invalid --replay-merges value: ${String(options.merges)}`);
  }
  const log = await runGit(
    ["log", "--merges", "--first-parent", `-n`, String(n), "--format=%H"],
    options.cwd,
  );
  if (log.exitCode !== 0) {
    throw new ConfigError(`Cannot list merge commits: ${log.stderr.trim()}`);
  }
  const merges = log.stdout.split("\n").filter((l) => l.length > 0);
  if (merges.length === 0) {
    throw new ConfigError("No first-parent merge commits found to replay.");
  }
  return merges.map((sha) => `${sha}^1..${sha}`);
}

export async function replay(options: ReplayOptions): Promise<ReplayRow[]> {
  const ranges = await resolveRanges(options);
  const rows: ReplayRow[] = [];

  for (const range of ranges) {
    try {
      const result = await runCheck({
        cwd: options.cwd,
        range,
        noLlm: true,
        ...(options.policyPath !== undefined ? { policyPath: options.policyPath } : {}),
      });
      await persistCheck(result, options.cwd);
      rows.push({ range, verdict: result.verdict, result });
    } catch (e) {
      // A bad range is recorded, not fatal — the batch continues.
      const msg = e instanceof Error ? e.message : String(e);
      rows.push({ range, verdict: "runtime-error", error: msg });
    }
  }
  return rows;
}

export function renderAggregate(rows: readonly ReplayRow[]): string {
  const lines: string[] = [];
  lines.push(`Replayed ${rows.length} range(s) (deterministic mode)`);
  lines.push("");

  const verdictCounts = new Map<string, number>();
  const findingCounts = new Map<string, number>();
  const reasonCounts = new Map<string, number>();

  for (const row of rows) {
    verdictCounts.set(row.verdict, (verdictCounts.get(row.verdict) ?? 0) + 1);
    for (const f of row.result?.findings ?? []) {
      findingCounts.set(f.category, (findingCounts.get(f.category) ?? 0) + 1);
    }
    for (const r of row.result?.reasons ?? []) {
      reasonCounts.set(r.ruleId, (reasonCounts.get(r.ruleId) ?? 0) + 1);
    }
  }

  lines.push("Verdicts:");
  for (const [verdict, count] of [...verdictCounts.entries()].sort()) {
    lines.push(`  ${verdict}: ${count}`);
  }
  lines.push("Finding categories:");
  if (findingCounts.size === 0) lines.push("  (none)");
  for (const [category, count] of [...findingCounts.entries()].sort()) {
    lines.push(`  ${category}: ${count}`);
  }
  lines.push("Rule hits:");
  if (reasonCounts.size === 0) lines.push("  (none)");
  for (const [ruleId, count] of [...reasonCounts.entries()].sort()) {
    lines.push(`  ${ruleId}: ${count}`);
  }

  const errors = rows.filter((r) => r.verdict === "runtime-error");
  if (errors.length > 0) {
    lines.push("Errors:");
    for (const row of errors) {
      lines.push(`  ${row.range}: ${row.error ?? "unknown"}`);
    }
  }
  return lines.join("\n");
}

export async function runReplay(options: ReplayOptions): Promise<number> {
  const out = options.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  try {
    const rows = await replay(options);
    out(renderAggregate(rows));
    return EXIT_CODE.PASS;
  } catch (e) {
    if (e instanceof CerberusError) {
      process.stderr.write(`Error: ${e.message}\n`);
      return e.exitCode;
    }
    throw e;
  }
}
