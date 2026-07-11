import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { runCheck, parseOverride } from "../../src/pcc/check.js";
import { renderMarkdown, renderJson, persistCheck } from "../../src/pcc/report.js";
import { DEFAULT_POLICY, type PolicyConfig } from "../../src/pcc/policy.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cerberus-pcc-e2e-"));
  git(dir, "init", "--initial-branch=main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
  return dir;
}

async function commitFiles(
  dir: string,
  files: Record<string, string>,
  message: string,
): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content, "utf-8");
  }
  git(dir, "add", "--all");
  git(dir, "commit", "--message", message);
}

const gatingPolicy: PolicyConfig = {
  ...DEFAULT_POLICY,
  rules: {
    ...DEFAULT_POLICY.rules,
    block_permission_change_without_auth_test: true,
  },
};

describe("E2E: runCheck verdicts and exit codes", () => {
  let repo: string;

  beforeAll(async () => {
    repo = await makeRepo();
    await commitFiles(repo, { "src/app.ts": "export const app = 1;\n" }, "base");
  });

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("clean single-concern change with a matching test exits 0", async () => {
    git(repo, "checkout", "-b", "clean-change", "main");
    await commitFiles(
      repo,
      {
        "src/parser.ts": "export function parseAnchor(s: string) { return s; }\n",
        "tests/parser.test.ts": 'it("parseAnchor parses anchor strings", () => { expect(parseAnchor("a")).toBe("a"); });\n',
      },
      "add parser",
    );
    const result = await runCheck({ cwd: repo, range: "main..clean-change", noLlm: true });
    expect(["pass", "pass-with-warnings"]).toContain(result.verdict);
    expect(result.effectiveExitCode).toBe(0);
    git(repo, "checkout", "main");
  });

  it("auth change without tests: default policy warns, gating policy blocks, advisory clamps", async () => {
    git(repo, "checkout", "-b", "auth-change", "main");
    await commitFiles(
      repo,
      { "src/auth/guard.ts": "export function requireRole(role: string) { return role; }\n" },
      "change guard",
    );

    const advisoryDefault = await runCheck({ cwd: repo, range: "main..auth-change", noLlm: true });
    expect(advisoryDefault.verdict).toBe("pass-with-warnings");
    expect(advisoryDefault.effectiveExitCode).toBe(0);

    const gated = await runCheck({
      cwd: repo,
      range: "main..auth-change",
      noLlm: true,
      policy: gatingPolicy,
    });
    expect(gated.verdict).toBe("block");
    expect(gated.effectiveExitCode).toBe(1);
    expect(gated.reasons.some((r) => r.ruleId === "block_permission_change_without_auth_test")).toBe(true);

    const clamped = await runCheck({
      cwd: repo,
      range: "main..auth-change",
      noLlm: true,
      policy: gatingPolicy,
      advisory: true,
    });
    expect(clamped.verdict).toBe("block");
    expect(clamped.effectiveExitCode).toBe(0);
    git(repo, "checkout", "main");
  });

  it("--override records owner and rationale and clamps the exit", async () => {
    const result = await runCheck({
      cwd: repo,
      range: "main..auth-change",
      noLlm: true,
      policy: gatingPolicy,
      override: "jane: accepted, hotfix window",
    });
    expect(result.verdict).toBe("block");
    expect(result.effectiveExitCode).toBe(0);
    expect(result.override).toEqual({
      owner: "jane",
      rationale: "accepted, hotfix window",
      overriddenVerdict: "block",
    });

    const json = JSON.parse(renderJson(result));
    expect(json.override.owner).toBe("jane");
    expect(json.verdict).toBe("block");
    expect(json.effectiveExitCode).toBe(0);
  });

  it("rejects an override without a rationale", () => {
    expect(() => parseOverride("jane")).toThrow(/owner.*rationale|rationale/i);
    expect(() => parseOverride("jane: ")).toThrow();
  });

  it("three-cluster change yields split-required with clusters named", async () => {
    git(repo, "checkout", "-b", "sprawl", "main");
    await commitFiles(
      repo,
      {
        "src/billing/invoice.ts": "export const invoice = 1;\n",
        "src/search/query.ts": "export const query = 1;\n",
        "docs/guide.md": "# Guide\n",
      },
      "sprawling change",
    );
    const result = await runCheck({ cwd: repo, range: "main..sprawl", noLlm: true });
    expect(result.verdict).toBe("split-required");
    expect(result.effectiveExitCode).toBe(3);
    const report = renderMarkdown(result);
    expect(report).toContain("Cluster 1");
    expect(report).toContain("src/billing/invoice.ts");
    git(repo, "checkout", "main");
  });

  it("empty range is an explicit pass with a no-changes note", async () => {
    const result = await runCheck({ cwd: repo, range: "main..main", noLlm: true });
    expect(result.verdict).toBe("pass");
    expect(result.noChanges).toBe(true);
    expect(result.effectiveExitCode).toBe(0);
    expect(renderMarkdown(result)).toContain("No changes analyzed");
  });

  it("unknown ref rejects with exit-2 error", async () => {
    await expect(
      runCheck({ cwd: repo, range: "ghost..main", noLlm: true }),
    ).rejects.toMatchObject({ exitCode: 2 });
  });
});

describe("E2E: report and persistence", () => {
  let repo: string;

  beforeAll(async () => {
    repo = await makeRepo();
    await commitFiles(repo, { "src/app.ts": "export const app = 1;\n" }, "base");
    git(repo, "checkout", "-b", "migration-change", "main");
    await commitFiles(
      repo,
      { "migrations/002.sql": "ALTER TABLE users DROP COLUMN email;\n" },
      "drop email column",
    );
  });

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("renders sections in the PRD §8.7 order", async () => {
    const result = await runCheck({ cwd: repo, range: "main..migration-change", noLlm: true });
    const report = renderMarkdown(result);

    const order = [
      "# Cerberus Check:",
      "## Highest-Risk Unsupported Claims",
      "## Claims",
      "## Affected Invariants",
      "## Split Recommendation",
      "## Rollback Status",
      "## Risk Findings",
    ];
    const positions = order.map((h) => report.indexOf(h));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(report).toContain("Not detected");
    expect(report).toContain("statically mapped — execution not verified");
  });

  it("emits schema-stable JSON with version and effective exit", async () => {
    const result = await runCheck({ cwd: repo, range: "main..migration-change", noLlm: true });
    const parsed = JSON.parse(renderJson(result));
    expect(parsed.version).toBe(1);
    expect(typeof parsed.verdict).toBe("string");
    expect(typeof parsed.effectiveExitCode).toBe("number");
    expect(Array.isArray(parsed.claims)).toBe(true);
    expect(Array.isArray(parsed.findings)).toBe(true);
    expect(Array.isArray(parsed.reasons)).toBe(true);
  });

  it("persists results under .cerberus/checks/", async () => {
    const result = await runCheck({ cwd: repo, range: "main..migration-change", noLlm: true });
    const path = await persistCheck(result, repo);
    await expect(access(path)).resolves.toBeUndefined();
    expect(path).toContain(join(".cerberus", "checks"));
  });
});
