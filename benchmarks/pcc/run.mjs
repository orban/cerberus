#!/usr/bin/env node
// PCC validation benchmark runner.
//
// One command:   node benchmarks/pcc/run.mjs
// Options:       --det-runs N (default 5)   deterministic (--no-llm) runs per cell
//                --llm-runs N (default 5)   LLM-mode runs per cell (0 to skip; needs OPENAI_API_KEY)
//                --model M    (default gpt-5.2)
//
// The system under test is the REAL product pipeline: `node dist/cli.js check`
// executed inside isolated, freshly constructed git repositories that contain
// only the base tree, the head tree, and neutral two-commit history. The
// description is passed via --description-file. Expected verdicts live in
// oracle/expectations.json and are consulted only AFTER raw results are
// persisted. Nothing in the case repositories names the benchmark, the
// expected verdicts, or the historical defect.

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, cp, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BENCH_DIR = dirname(fileURLToPath(import.meta.url));
const HOST_REPO = resolve(BENCH_DIR, "..", "..");
const CLI = join(HOST_REPO, "dist", "cli.js");

// ── args ──────────────────────────────────────────────────────────────────

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}
const DET_RUNS = Number(argValue("--det-runs", "5"));
const LLM_RUNS = Number(argValue("--llm-runs", "5"));
const MODEL = argValue("--model", "gpt-5.2");

// ── exec helper ───────────────────────────────────────────────────────────

function run(cmd, args, opts = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(cmd, args, { shell: false, stdio: ["ignore", "pipe", "pipe"], ...opts });
    const out = [];
    const err = [];
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => err.push(c));
    child.on("error", rejectPromise);
    child.on("close", (code) =>
      resolvePromise({
        stdout: Buffer.concat(out).toString("utf-8"),
        stderr: Buffer.concat(err).toString("utf-8"),
        exitCode: code ?? 1,
      }),
    );
  });
}

async function runOrThrow(cmd, args, opts = {}) {
  const res = await run(cmd, args, opts);
  if (res.exitCode !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed (${res.exitCode}): ${res.stderr}`);
  }
  return res;
}

const GIT_ID = [
  "-c", "user.name=bench",
  "-c", "user.email=bench@localhost",
  "-c", "commit.gpgsign=false",
  "-c", "tag.gpgsign=false",
];

// ── case construction ─────────────────────────────────────────────────────

async function extractArchive(sha, destDir) {
  const tarPath = join(destDir, "..", `${sha}-${Math.floor(Math.random() * 1e9)}.tar`);
  await runOrThrow("git", ["-C", HOST_REPO, "archive", "--format=tar", "-o", tarPath, sha]);
  await runOrThrow("tar", ["-xf", tarPath, "-C", destDir]);
  await rm(tarPath, { force: true });
}

async function clearWorkingTree(dir) {
  for (const entry of await readdir(dir)) {
    if (entry === ".git") continue;
    await rm(join(dir, entry), { recursive: true, force: true });
  }
}

async function buildCase(caseSpec, workRoot) {
  const dir = join(workRoot, caseSpec.id);
  await mkdir(dir, { recursive: true });

  await runOrThrow("git", [...GIT_ID, "init", "--quiet", "-b", "main", dir]);
  const git = (args) => runOrThrow("git", [...GIT_ID, "-C", dir, ...args]);

  // base tree
  await extractArchive(caseSpec.baseArchive, dir);
  if (caseSpec.baseOverlay) {
    await cp(join(BENCH_DIR, "fixtures", caseSpec.baseOverlay), dir, { recursive: true });
  }
  await git(["add", "-A"]);
  await git(["commit", "--quiet", "-m", caseSpec.baseCommitSubject]);
  const baseSha = (await git(["rev-parse", "HEAD"])).stdout.trim();

  // head tree
  if (caseSpec.headArchive !== caseSpec.baseArchive) {
    await clearWorkingTree(dir);
    await extractArchive(caseSpec.headArchive, dir);
  } else if (caseSpec.baseOverlay && !caseSpec.headOverlay) {
    throw new Error(`${caseSpec.id}: base overlay without head overlay would produce an inverted diff`);
  }
  if (caseSpec.headOverlay) {
    await cp(join(BENCH_DIR, "fixtures", caseSpec.headOverlay), dir, { recursive: true });
  }
  await git(["add", "-A"]);
  await git(["commit", "--quiet", "-m", caseSpec.headCommitSubject]);
  const headSha = (await git(["rev-parse", "HEAD"])).stdout.trim();

  const changed = (await git(["diff", "--name-only", baseSha, headSha])).stdout
    .split("\n").filter(Boolean);
  if (changed.length === 0) throw new Error(`${caseSpec.id}: empty diff — fixture construction bug`);

  return { dir, baseSha, headSha, changedFiles: changed };
}

// ── product invocation ────────────────────────────────────────────────────

async function invokeCheck(builtCase, { policyPath, mode, model }) {
  const args = [
    CLI, "check", `${builtCase.baseSha}..${builtCase.headSha}`,
    "--json",
    "--description-file", join(BENCH_DIR, "fixtures", builtCase.spec.description),
  ];
  if (policyPath) args.push("--policy", policyPath);
  if (mode === "det") args.push("--no-llm");
  else args.push("--model", model);

  const started = Date.now();
  const res = await run("node", args, { cwd: builtCase.dir });
  const wallMs = Date.now() - started;

  let parsed = null;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    // preserved raw; scored as runtime-error
  }
  return { args: args.slice(1), exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr, wallMs, parsed };
}

// ── scoring (expectations loaded only here, after raw persistence) ────────

function scoreRun(expectation, parsed, exitCode) {
  if (!parsed) {
    return { pass: false, actual: "runtime-error", evidentiaryReason: false };
  }
  const actual = parsed.verdict;
  const allowed = expectation.mustBe ?? null;
  const forbidden = expectation.mustNotBe ?? null;
  let pass;
  if (allowed) pass = allowed.includes(actual);
  else pass = !forbidden.includes(actual);
  const evidentiaryReason = (parsed.reasons ?? []).some((r) =>
    (expectation.evidentiaryRuleIds ?? []).includes(r.ruleId),
  );
  // When the expectation names evidentiary rules, a refusal only counts if it
  // cites one of them. Refusing for an unrelated reason (e.g. PR size) is
  // refused-for-the-wrong-reason and scores as a failure.
  if (pass && expectation.evidentiaryRuleIds && !evidentiaryReason) {
    pass = false;
  }
  return { pass, actual, evidentiaryReason, exitCode };
}

function extractForSummary(parsed) {
  if (!parsed) return { claims: [], evidence: [], unsupported: [], reasons: [] };
  const claims = (parsed.claims ?? []).map((c) => ({
    id: c.id, text: c.text, kind: c.kind, severityIfFalse: c.severityIfFalse,
    confidence: c.confidence, status: c.status,
  }));
  const evidence = (parsed.claims ?? []).flatMap((c) =>
    (c.evidence ?? []).map((e) => ({
      claim: c.id, file: e.file, testName: e.testName, directness: e.directness,
      independent: e.independent, skipMarked: e.skipMarked, execution: e.execution,
    })),
  );
  const unsupported = [
    ...(parsed.claims ?? []).filter((c) => c.status === "unsupported").map((c) => `claim ${c.id}: ${c.text}`),
    ...(parsed.invariants ?? []).filter((i) => i.affected && i.requiresEvidence && !i.evidenced)
      .map((i) => `invariant ${i.name}: affected, requires evidence, none qualifies`),
  ];
  return { claims, evidence, unsupported, reasons: parsed.reasons ?? [] };
}

// ── main ──────────────────────────────────────────────────────────────────

async function main() {
  if (!existsSync(CLI)) {
    throw new Error(`dist/cli.js not found — run \`npm run build\` in ${HOST_REPO} first.`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const resultsDir = join(BENCH_DIR, "results", stamp);
  const rawDir = join(resultsDir, "raw");
  await mkdir(rawDir, { recursive: true });

  // 1. Independent mathematical oracle first — if the oracle cannot confirm
  //    the historical defect and the corrected boundaries, nothing else means
  //    anything.
  process.stderr.write("Running independent SPRT oracle...\n");
  const oracle = await run("node", [join(BENCH_DIR, "oracle", "sprt-oracle.mjs")]);
  await writeFile(join(resultsDir, "oracle-results.json"), oracle.stdout);
  if (oracle.exitCode !== 0) {
    throw new Error("Mathematical oracle FAILED — see oracle-results.json. Aborting benchmark.");
  }
  process.stderr.write("Oracle confirmed defect + corrected boundaries.\n");

  // 2. Build isolated case repositories.
  const manifest = JSON.parse(await readFile(join(BENCH_DIR, "fixtures", "manifest.json"), "utf-8"));
  const workRoot = await mkdtemp(join(tmpdir(), "chk-"));
  const built = [];
  for (const spec of manifest.cases) {
    const b = await buildCase(spec, workRoot);
    b.spec = spec;
    built.push(b);
    process.stderr.write(`Built ${spec.id}: ${b.changedFiles.length} changed file(s)\n`);
  }
  await writeFile(join(resultsDir, "construction.json"), JSON.stringify(
    built.map((b) => ({ id: b.spec.id, dir: b.dir, baseSha: b.baseSha, headSha: b.headSha, changedFiles: b.changedFiles })),
    null, 2));

  // 3. Run the matrix. Raw output is persisted per run BEFORE any scoring.
  const policies = [
    { name: "default", path: null },
    { name: "strict", path: join(BENCH_DIR, "fixtures", "policies", "strict.yaml") },
  ];
  const modes = [];
  if (DET_RUNS > 0) modes.push({ name: "det", runs: DET_RUNS });
  if (LLM_RUNS > 0) {
    if (process.env.OPENAI_API_KEY) modes.push({ name: "llm", runs: LLM_RUNS });
    else process.stderr.write("OPENAI_API_KEY not set — skipping LLM mode (recorded as NOT TESTED).\n");
  }

  const records = [];
  for (const b of built) {
    for (const policy of policies) {
      for (const mode of modes) {
        for (let i = 1; i <= mode.runs; i++) {
          const inv = await invokeCheck(b, { policyPath: policy.path, mode: mode.name, model: MODEL });
          const key = `${b.spec.id}-${policy.name}-${mode.name}-run${i}`;
          await writeFile(join(rawDir, `${key}.json`), JSON.stringify({
            fixture: b.spec.id, policy: policy.name, mode: mode.name, run: i,
            model: mode.name === "llm" ? MODEL : null,
            invocation: inv.args, exitCode: inv.exitCode, wallMs: inv.wallMs,
            stdout: inv.stdout, stderr: inv.stderr,
          }, null, 2));
          records.push({ fixture: b.spec.id, policy: policy.name, mode: mode.name, run: i, key, inv });
          process.stderr.write(`${key}: verdict=${inv.parsed?.verdict ?? "PARSE-ERROR"} exit=${inv.exitCode} ${inv.wallMs}ms\n`);
        }
      }
    }
  }

  // 4. Score. Expectations are read only now.
  const expectations = JSON.parse(await readFile(join(BENCH_DIR, "oracle", "expectations.json"), "utf-8"));
  const cells = new Map();
  for (const r of records) {
    const cellKey = `${r.fixture}|${r.policy}|${r.mode}`;
    if (!cells.has(cellKey)) cells.set(cellKey, []);
    cells.get(cellKey).push(r);
  }

  const summary = { generatedAt: stamp, model: MODEL, detRuns: DET_RUNS, llmRuns: LLM_RUNS,
    llmTested: modes.some((m) => m.name === "llm"), cells: [] };

  for (const [cellKey, cellRecords] of cells) {
    const [fixture, policy, mode] = cellKey.split("|");
    const expectation = expectations.cases[fixture];
    const runs = cellRecords.map((r) => {
      const score = scoreRun(expectation, r.inv.parsed, r.inv.exitCode);
      const detail = extractForSummary(r.inv.parsed);
      return {
        run: r.run, raw: `raw/${r.key}.json`,
        expected: expectation.mustBe ?? { not: expectation.mustNotBe },
        actual: score.actual, pass: score.pass,
        evidentiaryReason: score.evidentiaryReason,
        exitCode: r.inv.exitCode, latencyMs: r.inv.wallMs,
        model: mode === "llm" ? MODEL : null, costTokens: "not-exposed-by-product",
        claimsExtracted: detail.claims, evidenceCited: detail.evidence,
        unsupportedObligations: detail.unsupported,
        explanation: detail.reasons,
      };
    });
    const verdictCounts = {};
    for (const r of runs) verdictCounts[r.actual] = (verdictCounts[r.actual] ?? 0) + 1;
    summary.cells.push({
      fixture, policy, mode, scenario: expectation.scenario,
      runs, verdictCounts,
      consistent: Object.keys(verdictCounts).length === 1,
      cellPass: runs.every((r) => r.pass),
    });
  }

  await writeFile(join(resultsDir, "summary.json"), JSON.stringify(summary, null, 2));

  // 5. Human-readable summary.
  const lines = [`# PCC benchmark ${stamp}`, ""];
  lines.push(`| fixture | policy | mode | expected | verdicts (n) | consistent | evidentiary reason | cell pass |`);
  lines.push(`|---|---|---|---|---|---|---|---|`);
  for (const c of summary.cells) {
    const exp = expectations.cases[c.fixture];
    const expLabel = exp.mustBe ? exp.mustBe.join("/") : `NOT ${exp.mustNotBe.join("/")}`;
    const verdicts = Object.entries(c.verdictCounts).map(([v, n]) => `${v}×${n}`).join(", ");
    const evid = c.runs.some((r) => r.evidentiaryReason) ? "yes" : "no";
    lines.push(`| ${c.fixture} | ${c.policy} | ${c.mode} | ${expLabel} | ${verdicts} | ${c.consistent} | ${evid} | ${c.cellPass ? "PASS" : "FAIL"} |`);
  }
  lines.push("", `Raw, unedited product output: results/${stamp}/raw/`, "");
  await writeFile(join(resultsDir, "summary.md"), lines.join("\n"));
  process.stdout.write(lines.join("\n") + "\n");
  process.stdout.write(`\nResults: ${resultsDir}\n(case repositories left at ${workRoot} for inspection)\n`);
}

main().catch((e) => {
  process.stderr.write(`benchmark error: ${e.message}\n`);
  process.exit(1);
});
