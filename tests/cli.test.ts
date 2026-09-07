import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, copyFile, rm, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EXIT_CODE } from "../src/types.js";
import { NO_GOLD_SET_WARNING_HEADER } from "../src/output.js";

// Real process, real exit code.
//
// Every other exit-code test runs `runSuite` in-process and maps the result
// with a hand-copy of the ternary in `src/cli.ts`. That asserts on the copy:
// it stays green if `cli.ts` maps a status to the wrong code, if `persistResult`
// throws, or if human-readable text lands on stdout and corrupts `--json` for
// whatever is parsing it. The whole point of the gating work is that an
// advisory judge cannot flip CI's exit code, and CI reads the process's code,
// not a SuiteResult.
//
// The CLI is driven through `tsx` rather than `dist/`, so the source under test
// is always the current source and no build artifact has to exist or be fresh.

const repoRoot = resolve(import.meta.dirname, "..");
const cliEntry = resolve(repoRoot, "src", "cli.ts");
const tsxEntry = resolve(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const fixturesDir = resolve(import.meta.dirname, "fixtures");

interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** An isolated working directory, so `.cerberus/runs/` lands nowhere real. */
let workDir: string;

/**
 * Every relative path in the generated configs -- the agent and the scenario --
 * is relative to `workDir`, which is both the config's directory and the child's
 * cwd. Nothing reaches back into the repo, and no path with a space in it is
 * ever split by the adapter's whitespace-delimited command template.
 */
async function writeWorkspace(): Promise<void> {
  await mkdir(join(workDir, "agents"), { recursive: true });
  await mkdir(join(workDir, "scenarios"), { recursive: true });

  for (const agent of ["echo.js", "crash.js"]) {
    await copyFile(
      join(fixturesDir, "agents", agent),
      join(workDir, "agents", agent),
    );
  }

  await writeFile(
    join(workDir, "scenarios", "simple.yaml"),
    "input: Review this code\nmetadata:\n  category: test\n",
    "utf-8",
  );

  await writeFile(
    join(workDir, "pass.yaml"),
    `adapter:
  command: "node ./agents/echo.js --scenario {{scenario}}"
  timeout: 5000

studies:
  - name: passing-study
    scenario: scenarios/simple.yaml
    contracts:
      - name: exits-cleanly
        type: code
        assert: "output.meta.exitCode === 0"
        threshold: 0.90
        confidence: 0.95
        trials: 30
`,
    "utf-8",
  );

  await writeFile(
    join(workDir, "fail.yaml"),
    `adapter:
  command: "node ./agents/crash.js --scenario {{scenario}}"
  timeout: 5000

studies:
  - name: failing-study
    scenario: scenarios/simple.yaml
    max_error_rate: 0.90
    contracts:
      - name: exits-cleanly
        type: code
        assert: "output.meta.exitCode === 0"
        threshold: 0.90
        confidence: 0.95
        trials: 5
`,
    "utf-8",
  );

  // A judge contract with no gold set, so it cannot gate. No API key is set in
  // the child's environment, so `evaluateWithPanel` throws before it builds a
  // request -- the verdict is an error, the contract fails, and nothing
  // touches the network. Before the gating work this suite exited 1.
  await writeFile(
    join(workDir, "advisory.yaml"),
    `adapter:
  command: "node ./agents/echo.js --scenario {{scenario}}"
  timeout: 5000

judges:
  - model: "claude-3-5-sonnet-20241022"

studies:
  - name: advisory-study
    scenario: scenarios/simple.yaml
    contracts:
      - name: advisory-judge
        type: judge
        rubric: "Check output quality"
        threshold: 0.90
        confidence: 0.95
        trials: 6
`,
    "utf-8",
  );
}

function runCli(args: readonly string[]): Promise<CliRun> {
  return new Promise((resolvePromise, rejectPromise) => {
    const env = { ...process.env };
    // Offline, always: a judge that finds a key would try to reach a provider.
    delete env.OPENAI_API_KEY;
    delete env.ANTHROPIC_API_KEY;
    delete env.GOOGLE_API_KEY;
    // The runner suppresses the progress display entirely under CI, so whether
    // stderr carries anything would otherwise depend on the machine the suite
    // runs on. Unset it in the child so both streams are the same either way.
    delete env.CI;

    const child = spawn(process.execPath, [tsxEntry, cliEntry, ...args], {
      cwd: workDir,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    child.on("error", rejectPromise);
    child.on("close", (code) => {
      resolvePromise({ code: code ?? -1, stdout, stderr });
    });
  });
}

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "cerberus-cli-"));
  await writeWorkspace();
}, 30_000);

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true }).catch(() => {});
});

describe("CLI process exit codes", () => {
  it("exits 0 on a passing suite and writes only JSON to stdout", async () => {
    const run = await runCli(["run", "-c", "pass.yaml", "--json"]);

    expect(run.code).toBe(EXIT_CODE.PASS);

    // The whole of stdout has to parse. A single stray human-readable line
    // here breaks every consumer piping `--json` into a parser.
    const parsed = JSON.parse(run.stdout);
    expect(parsed.version).toBe(1);
    expect(parsed.status).toBe("pass");
    expect(parsed.studies[0].name).toBe("passing-study");
    expect(parsed.studies[0].contracts[0].gating).toBe(true);

    // ...and the human-readable progress went to the other stream.
    expect(run.stderr).toContain("SPRT:");
  }, 60_000);

  it("exits 1 on a failing suite", async () => {
    const run = await runCli(["run", "-c", "fail.yaml", "--json"]);

    expect(run.code).toBe(EXIT_CODE.FAIL);
    expect(JSON.parse(run.stdout).status).toBe("fail");
  }, 60_000);

  it("exits 0 on an advisory-only suite that would have failed", async () => {
    const run = await runCli(["run", "-c", "advisory.yaml", "--json"]);

    // The claim this change exists to make, asserted on a real process.
    expect(run.code).toBe(EXIT_CODE.PASS);

    const contract = JSON.parse(run.stdout).studies[0].contracts[0];
    expect(contract.gating).toBe(false);
    expect(contract.advisoryReasons).toEqual(["no-gold-set"]);
    // The verdict it would have had is still reported...
    expect(contract.status).toBe("fail");

    // ...and turning a red build green is announced, on stderr, not stdout.
    expect(run.stderr).toContain(NO_GOLD_SET_WARNING_HEADER);
    expect(run.stdout).not.toContain(NO_GOLD_SET_WARNING_HEADER);
  }, 60_000);

  it("exits 2 on a config error, with the message on stderr", async () => {
    const run = await runCli(["run", "-c", "no-such-config.yaml"]);

    expect(run.code).toBe(EXIT_CODE.CONFIG_ERROR);
    expect(run.stderr).toContain("Cannot read config file");
    expect(run.stdout).toBe("");
  }, 60_000);

  it("renders a human-readable table when --json is not passed", async () => {
    const run = await runCli(["run", "-c", "pass.yaml"]);

    expect(run.code).toBe(EXIT_CODE.PASS);
    expect(run.stdout).toContain("exits-cleanly");
    expect(run.stdout).toContain("Suite:");
    // Not JSON, so nothing should be trying to parse it.
    expect(() => JSON.parse(run.stdout)).toThrow();
  }, 60_000);

  it("persists the run record under the working directory", async () => {
    await runCli(["run", "-c", "pass.yaml", "--json"]);

    // `persistResult` is wired in `cli.ts` alone and runs after the result is
    // written but before the exit, so nothing in-process covers it.
    const runs = await readdir(join(workDir, ".cerberus", "runs"));
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.every((name) => name.endsWith(".json"))).toBe(true);
  }, 60_000);
});
