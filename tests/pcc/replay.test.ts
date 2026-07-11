import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { replay, renderAggregate, runReplay } from "../../src/pcc/replay.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
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

describe("replay", () => {
  let repo: string;

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), "cerberus-pcc-replay-"));
    git(repo, "init", "--initial-branch=main");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test");
    git(repo, "config", "commit.gpgsign", "false");
    git(repo, "config", "tag.gpgsign", "false");
    git(repo, "config", "tag.forceSignAnnotated", "false");
    await commitFiles(repo, { "src/app.ts": "export const app = 1;\n" }, "base");
    git(repo, "tag", "r0");

    // Range 1: clean change.
    await commitFiles(repo, { "src/clean.ts": "export const clean = 1;\n" }, "clean change");
    git(repo, "tag", "r1");

    // Range 2: destructive migration.
    await commitFiles(
      repo,
      { "migrations/001.sql": "DROP TABLE users;\n" },
      "destructive migration",
    );
    git(repo, "tag", "r2");

    // Range 3: multi-cluster sprawl.
    await commitFiles(
      repo,
      {
        "src/billing/invoice.ts": "export const invoice = 1;\n",
        "src/search/query.ts": "export const query = 1;\n",
        "docs/guide.md": "# Guide\n",
      },
      "sprawl",
    );
    git(repo, "tag", "r3");
  });

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("aggregates verdicts and finding categories across seeded ranges", async () => {
    const rangesFile = join(repo, "ranges.txt");
    await writeFile(rangesFile, "r0..r1\nr1..r2\nr2..r3\n", "utf-8");

    const rows = await replay({ cwd: repo, rangesFile });
    expect(rows).toHaveLength(3);
    // Deterministic mode with no description always carries an unsupported
    // intent-unknown claim, so even the clean range warns rather than passes.
    expect(rows[0]!.verdict).toBe("pass-with-warnings");
    // The destructive migration's deterministic claim is critical and has no
    // mapped evidence — material-unsupported drives needs-evidence even under
    // the advisory-first default (which only disables hard blocks).
    expect(rows[1]!.verdict).toBe("needs-evidence");
    expect(rows[2]!.verdict).toBe("split-required");

    const aggregate = renderAggregate(rows);
    expect(aggregate).toContain("Replayed 3 range(s)");
    expect(aggregate).toContain("pass-with-warnings: 1");
    expect(aggregate).toContain("needs-evidence: 1");
    expect(aggregate).toContain("split-required: 1");
    expect(aggregate).toContain("migration: 1");
    expect(aggregate).toContain("unrelated-changes: 1");
  });

  it("records an unresolvable range as an error row without aborting the batch", async () => {
    const rangesFile = join(repo, "ranges-with-bad.txt");
    await writeFile(rangesFile, "r0..r1\nghost..r2\n", "utf-8");

    const rows = await replay({ cwd: repo, rangesFile });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.verdict).toBe("pass-with-warnings");
    expect(rows[1]!.verdict).toBe("runtime-error");
    expect(renderAggregate(rows)).toContain("ghost..r2");
  });

  it("skips comments and blank lines in the ranges file", async () => {
    const rangesFile = join(repo, "ranges-comments.txt");
    await writeFile(rangesFile, "# tuning corpus\n\nr0..r1\n", "utf-8");
    const rows = await replay({ cwd: repo, rangesFile });
    expect(rows).toHaveLength(1);
  });

  it("returns exit 2 for an unreadable ranges file", async () => {
    const lines: string[] = [];
    const code = await runReplay({
      cwd: repo,
      rangesFile: join(repo, "missing.txt"),
      out: (l) => lines.push(l),
    });
    expect(code).toBe(2);
  });

  it("rejects an invalid --replay-merges value", async () => {
    const code = await runReplay({ cwd: repo, merges: 0, out: () => {} });
    expect(code).toBe(2);
  });

  it("derives ranges from first-parent merge commits", async () => {
    // Create a merge commit.
    git(repo, "checkout", "-b", "feature", "r1");
    await commitFiles(repo, { "src/feat.ts": "export const feat = 1;\n" }, "feature work");
    git(repo, "checkout", "main");
    git(repo, "merge", "--no-ff", "--no-edit", "feature");

    const rows = await replay({ cwd: repo, merges: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.range).toMatch(/\^1\.\./);
    expect(rows[0]!.verdict).not.toBe("runtime-error");
  });
});
