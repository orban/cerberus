import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { collectChangeSet, isTestPath, resolveRange } from "../../src/pcc/git.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cerberus-pcc-git-"));
  git(dir, "init", "--initial-branch=main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
  return dir;
}

async function commitFile(
  dir: string,
  path: string,
  content: string,
  message: string,
): Promise<void> {
  const full = join(dir, path);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, content, "utf-8");
  git(dir, "add", "--all");
  git(dir, "commit", "--message", message);
}

describe("isTestPath", () => {
  it("classifies common test paths", () => {
    expect(isTestPath("tests/foo.test.ts")).toBe(true);
    expect(isTestPath("src/foo.test.ts")).toBe(true);
    expect(isTestPath("src/foo.spec.tsx")).toBe(true);
    expect(isTestPath("pkg/test_utils.py")).toBe(true);
    expect(isTestPath("pkg/utils_test.py")).toBe(true);
    expect(isTestPath("src/__tests__/foo.ts")).toBe(true);
  });

  it("does not classify near-misses", () => {
    expect(isTestPath("src/contest.ts")).toBe(false);
    expect(isTestPath("src/attestation.ts")).toBe(false);
    expect(isTestPath("src/latest.py")).toBe(false);
  });
});

describe("collectChangeSet", () => {
  let repo: string;

  beforeAll(async () => {
    repo = await makeRepo();
    await commitFile(repo, "src/keep.ts", "export const keep = 1;\n", "base");
    git(repo, "branch", "base-marker");
    git(repo, "checkout", "-b", "feature");
    await commitFile(repo, "src/added.ts", "export const a = 1;\n", "add file");
    await commitFile(repo, "src/keep.ts", "export const keep = 2;\n", "modify file");
  });

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("reports added and modified files with counts and hunks", async () => {
    const cs = await collectChangeSet({ cwd: repo, range: "base-marker..feature" });
    const added = cs.files.find((f) => f.path === "src/added.ts");
    const modified = cs.files.find((f) => f.path === "src/keep.ts");

    expect(added?.status).toBe("added");
    expect(added?.additions).toBe(1);
    expect(modified?.status).toBe("modified");
    expect(modified?.hunks.some((h) => h.added.some((l) => l.includes("keep = 2")))).toBe(true);
    expect(modified?.hunks.some((h) => h.removed.some((l) => l.includes("keep = 1")))).toBe(true);
    expect(cs.commitSubjects).toContain("add file");
  });

  it("normalizes every dot form to merge-base semantics", async () => {
    const twoDot = await collectChangeSet({ cwd: repo, range: "base-marker..feature" });
    const threeDot = await collectChangeSet({ cwd: repo, range: "base-marker...feature" });
    const single = await collectChangeSet({ cwd: repo, range: "base-marker" });

    for (const cs of [twoDot, threeDot, single]) {
      expect(cs.files.map((f) => f.path).sort()).toEqual(["src/added.ts", "src/keep.ts"]);
    }
  });

  it("does not leak upstream commits into a behind-base feature range", async () => {
    // Advance main past the feature fork point with a destructive migration.
    git(repo, "checkout", "main");
    await commitFile(repo, "migrations/001.sql", "DROP TABLE users;\n", "upstream migration");
    git(repo, "checkout", "feature");

    const cs = await collectChangeSet({ cwd: repo, range: "main...feature" });
    expect(cs.files.map((f) => f.path)).not.toContain("migrations/001.sql");
    expect(cs.commitSubjects).not.toContain("upstream migration");
  });

  it("reports a rename as a rename, not delete+add", async () => {
    git(repo, "checkout", "-b", "rename-branch", "feature");
    await rename(join(repo, "src/added.ts"), join(repo, "src/renamed.ts"));
    git(repo, "add", "--all");
    git(repo, "commit", "--message", "rename file");

    const cs = await collectChangeSet({ cwd: repo, range: "feature..rename-branch" });
    expect(cs.files).toHaveLength(1);
    expect(cs.files[0]!.status).toBe("renamed");
    expect(cs.files[0]!.path).toBe("src/renamed.ts");
    expect(cs.files[0]!.oldPath).toBe("src/added.ts");
    git(repo, "checkout", "feature");
  });

  it("handles binary files without hunks", async () => {
    git(repo, "checkout", "-b", "binary-branch", "feature");
    await writeFile(join(repo, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    git(repo, "add", "--all");
    git(repo, "commit", "--message", "add binary");

    const cs = await collectChangeSet({ cwd: repo, range: "feature..binary-branch" });
    const bin = cs.files.find((f) => f.path === "logo.png");
    expect(bin?.isBinary).toBe(true);
    expect(bin?.hunks).toHaveLength(0);
    git(repo, "checkout", "feature");
  });

  it("yields an empty ChangeSet for a rangeless diff, not an error", async () => {
    const cs = await collectChangeSet({ cwd: repo, range: "feature..feature" });
    expect(cs.files).toHaveLength(0);
  });

  it("rejects unknown refs with an exit-2 error", async () => {
    await expect(
      collectChangeSet({ cwd: repo, range: "no-such-ref..feature" }),
    ).rejects.toMatchObject({ exitCode: 2 });
  });

  it("rejects refs that look like flags", async () => {
    await expect(
      collectChangeSet({ cwd: repo, base: "--upload-pack=/bin/sh" }),
    ).rejects.toMatchObject({ exitCode: 2 });
  });

  it("rejects non-repositories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cerberus-pcc-notrepo-"));
    await expect(collectChangeSet({ cwd: dir })).rejects.toMatchObject({ exitCode: 2 });
    await rm(dir, { recursive: true, force: true });
  });
});

describe("resolveRange base fallback", () => {
  it("falls back to local main when no remote exists", async () => {
    const repo = await makeRepo();
    await commitFile(repo, "a.txt", "one\n", "base");
    git(repo, "checkout", "-b", "topic");
    await commitFile(repo, "b.txt", "two\n", "topic change");

    const resolved = await resolveRange(repo);
    expect(resolved.baseRef).toBe("main");
    expect(resolved.headRef).toBe("HEAD");
    await rm(repo, { recursive: true, force: true });
  });

  it("prefers remote-tracking origin/main over local branches", async () => {
    const origin = await makeRepo();
    await commitFile(origin, "a.txt", "one\n", "base");

    const clone = await mkdtemp(join(tmpdir(), "cerberus-pcc-clone-"));
    execFileSync("git", ["clone", "--quiet", origin, clone], { encoding: "utf-8" });
    git(clone, "config", "user.email", "test@example.com");
    git(clone, "config", "user.name", "Test");
    // Simulate a CI checkout: remote-tracking ref exists, origin/HEAD and local main removed.
    git(clone, "checkout", "--detach");
    git(clone, "branch", "-D", "main");
    git(clone, "remote", "set-head", "origin", "--delete");

    const resolved = await resolveRange(clone);
    expect(resolved.baseRef).toBe("origin/main");

    await rm(origin, { recursive: true, force: true });
    await rm(clone, { recursive: true, force: true });
  });
});
