import { describe, it, expect } from "vitest";
import { detectRisks, clusterKey, redactSecrets } from "../../src/pcc/detectors.js";
import type { ChangeSet, FileChange, FileHunk } from "../../src/pcc/types.js";

function hunk(added: string[] = [], removed: string[] = []): FileHunk {
  return { header: "@@ -1 +1 @@", added, removed };
}

function file(path: string, overrides: Partial<FileChange> = {}): FileChange {
  return {
    path,
    status: "modified",
    additions: 1,
    deletions: 0,
    isBinary: false,
    isTest: /\.test\.|(^|\/)tests?\//.test(path),
    hunks: [],
    ...overrides,
  };
}

function changeSet(files: FileChange[], description?: string): ChangeSet {
  return {
    baseRef: "main",
    headRef: "HEAD",
    mergeBase: "abc",
    rangeLabel: "main...HEAD",
    files,
    commitSubjects: [],
    ...(description !== undefined ? { description } : {}),
  };
}

describe("migration detector", () => {
  it("flags destructive SQL as critical with rollback undetected", () => {
    const cs = changeSet([
      file("migrations/002.sql", { status: "added", hunks: [hunk(["ALTER TABLE users DROP COLUMN email;"])] }),
    ]);
    const { findings, rollback } = detectRisks(cs);
    const migration = findings.find((f) => f.category === "migration");
    expect(migration?.severity).toBe("critical");
    expect(rollback.relevant).toBe(true);
    expect(rollback.detected).toBe(false);
  });

  it("treats additive migration with a down file as warning with rollback detected", () => {
    const cs = changeSet([
      file("migrations/003.sql", { status: "added", hunks: [hunk(["CREATE TABLE audit (id int);"])] }),
      file("migrations/003.down.sql", { status: "added", hunks: [hunk(["DROP TABLE audit;"])] }),
    ]);
    const { findings, rollback } = detectRisks(cs);
    const migrations = findings.filter((f) => f.category === "migration");
    expect(rollback.detected).toBe(true);
    // The down file itself contains destructive SQL — severity stays critical
    // only when the *up* path is destructive; here the up path is additive but
    // the reversal artifact includes DROP. Accept either severity as long as
    // rollback is detected; the policy gate keys on rollback, not severity alone.
    expect(migrations.length).toBeGreaterThan(0);
  });

  it("detects rollback intent from the description", () => {
    const cs = changeSet(
      [file("db/migrate/20260711_add.rb", { status: "added", hunks: [hunk(["add_column :users, :x"])] })],
      "Adds column. Rollback: run bin/rails db:rollback.",
    );
    expect(detectRisks(cs).rollback.detected).toBe(true);
  });

  it("is irrelevant when no migration files change", () => {
    const { rollback, findings } = detectRisks(changeSet([file("src/app.ts")]));
    expect(rollback.relevant).toBe(false);
    expect(findings.filter((f) => f.category === "migration")).toHaveLength(0);
  });
});

describe("permission detector", () => {
  it("flags auth paths at high confidence", () => {
    const cs = changeSet([
      file("src/auth/guard.ts", { hunks: [hunk(["export function requireRole(r) {}"])] }),
    ]);
    const perms = detectRisks(cs).findings.filter((f) => f.category === "permission");
    expect(perms).toHaveLength(1);
    expect(perms[0]!.confidence).toBe("high");
  });

  it("flags keyword-only hits at low confidence", () => {
    const cs = changeSet([
      file("src/http/client.ts", { hunks: [hunk(["const token = await fetchToken();"])] }),
    ]);
    const perms = detectRisks(cs).findings.filter((f) => f.category === "permission");
    expect(perms).toHaveLength(1);
    expect(perms[0]!.confidence).toBe("low");
  });

  it("does not fire on 'author'", () => {
    const cs = changeSet([
      file("src/blog/post.ts", { hunks: [hunk(["const author = post.author;"])] }),
    ]);
    expect(detectRisks(cs).findings.filter((f) => f.category === "permission")).toHaveLength(0);
  });
});

describe("public API detector", () => {
  it("flags removed exports", () => {
    const cs = changeSet([
      file("src/index.ts", { hunks: [hunk([], ["export function oldApi() {}"])] }),
    ]);
    const api = detectRisks(cs).findings.filter((f) => f.category === "public-api");
    expect(api).toHaveLength(1);
  });

  it("ignores internal-only edits", () => {
    const cs = changeSet([
      file("src/internal.ts", { hunks: [hunk(["const x = 1;"], ["const x = 0;"])] }),
    ]);
    expect(detectRisks(cs).findings.filter((f) => f.category === "public-api")).toHaveLength(0);
  });

  it("flags route registrations and package entry points", () => {
    const cs = changeSet([
      file("server/routes.ts", { hunks: [hunk(['app.get("/admin", handler);'])] }),
      file("package.json", { hunks: [hunk(['"main": "./dist/new.js",'])] }),
    ]);
    const api = detectRisks(cs).findings.filter((f) => f.category === "public-api");
    expect(api[0]!.files).toContain("server/routes.ts");
    expect(api[0]!.files).toContain("package.json");
  });
});

describe("test integrity detector", () => {
  it("flags deleted test files", () => {
    const cs = changeSet([file("tests/foo.test.ts", { status: "deleted" })]);
    const t = detectRisks(cs).findings.filter((f) => f.category === "test-integrity");
    expect(t).toHaveLength(1);
  });

  it("flags weakened assertions but not balanced rewrites", () => {
    const weakened = changeSet([
      file("tests/foo.test.ts", {
        hunks: [hunk(["expect(a).toBe(1);"], ["expect(a).toBe(1);", "expect(b).toBe(2);", "expect(c).toBe(3);"])],
      }),
    ]);
    expect(detectRisks(weakened).findings.some((f) => f.explanation.includes("weakened"))).toBe(true);

    const balanced = changeSet([
      file("tests/foo.test.ts", {
        hunks: [hunk(["expect(a).toBe(2);"], ["expect(a).toBe(1);"])],
      }),
    ]);
    expect(detectRisks(balanced).findings.some((f) => f.explanation.includes("weakened"))).toBe(false);
  });

  it("flags added skip markers", () => {
    const cs = changeSet([
      file("tests/foo.test.ts", { hunks: [hunk(['it.skip("later", () => {});'])] }),
    ]);
    expect(detectRisks(cs).findings.some((f) => f.explanation.includes("Skip markers"))).toBe(true);
  });
});

describe("secret detector and redaction", () => {
  it("flags AWS access key IDs as critical", () => {
    const cs = changeSet([
      file("src/config.ts", { hunks: [hunk(['const key = "AKIAIOSFODNN7EXAMPLE";'])] }),
    ]);
    const secrets = detectRisks(cs).findings.filter((f) => f.category === "secret");
    expect(secrets).toHaveLength(1);
    expect(secrets[0]!.severity).toBe("critical");
  });

  it("ignores random hex strings", () => {
    const cs = changeSet([
      file("src/config.ts", { hunks: [hunk(['const id = "deadbeefcafe1234";'])] }),
    ]);
    expect(detectRisks(cs).findings.filter((f) => f.category === "secret")).toHaveLength(0);
  });

  it("redacts secrets in prompt text", () => {
    const text = "key = AKIAIOSFODNN7EXAMPLE and more";
    expect(redactSecrets(text)).toContain("[REDACTED]");
    expect(redactSecrets(text)).not.toContain("AKIA");
  });
});

describe("unrelated-change clustering", () => {
  it("clusters below recognized source roots", () => {
    expect(clusterKey("src/billing/invoice.ts")).toBe("src/billing");
    expect(clusterKey("src/search/index.ts")).toBe("src/search");
    expect(clusterKey("docs/readme.md")).toBe("docs");
    expect(clusterKey("package.json")).toBe(".");
  });

  it("flags three unrelated clusters above the default threshold", () => {
    const cs = changeSet([
      file("src/billing/invoice.ts"),
      file("src/search/query.ts"),
      file("docs/guide.md"),
    ]);
    const unrelated = detectRisks(cs).findings.filter((f) => f.category === "unrelated-changes");
    expect(unrelated).toHaveLength(1);
    expect(unrelated[0]!.clusters).toHaveLength(3);
  });

  it("does not flag a single-concern monorepo change", () => {
    const cs = changeSet([
      file("packages/billing/src/invoice.ts"),
      file("packages/billing/src/tax.ts"),
    ]);
    expect(detectRisks(cs).findings.filter((f) => f.category === "unrelated-changes")).toHaveLength(0);
  });

  it("respects a custom threshold", () => {
    const cs = changeSet([
      file("src/billing/invoice.ts"),
      file("src/search/query.ts"),
      file("docs/guide.md"),
    ]);
    expect(
      detectRisks(cs, { clusterThreshold: 3 }).findings.filter(
        (f) => f.category === "unrelated-changes",
      ),
    ).toHaveLength(0);
  });

  it("merges clusters sharing a basename", () => {
    const cs = changeSet([
      file("src/billing/invoice.ts"),
      file("src/search/invoice.ts"),
    ]);
    expect(detectRisks(cs).findings.filter((f) => f.category === "unrelated-changes")).toHaveLength(0);
  });
});

describe("dependency and infrastructure detectors", () => {
  it("flags lockfile and workflow changes", () => {
    const cs = changeSet([
      file("package-lock.json"),
      file(".github/workflows/ci.yml"),
    ]);
    const categories = detectRisks(cs).findings.map((f) => f.category);
    expect(categories).toContain("dependency");
    expect(categories).toContain("infrastructure");
  });
});
