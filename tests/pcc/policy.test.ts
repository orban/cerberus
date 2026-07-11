import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_POLICY,
  loadPolicy,
  matchGlob,
  evaluatePolicy,
  evaluateInvariants,
  type PolicyConfig,
} from "../../src/pcc/policy.js";
import type {
  ChangeSet,
  EvaluatedClaim,
  EvidenceLink,
  InvariantStatus,
  RiskFinding,
  RollbackStatus,
} from "../../src/pcc/types.js";

// ── Fixtures ─────────────────────────────────────────────────

const noRollback: RollbackStatus = {
  relevant: true,
  detected: false,
  explanation: "none found",
};
const rollbackOk: RollbackStatus = {
  relevant: true,
  detected: true,
  explanation: "down file present",
};
const irrelevantRollback: RollbackStatus = {
  relevant: false,
  detected: false,
  explanation: "no migrations",
};

function finding(overrides: Partial<RiskFinding>): RiskFinding {
  return {
    category: "migration",
    severity: "critical",
    confidence: "high",
    files: ["migrations/002.sql"],
    explanation: "Destructive schema change.",
    ...overrides,
  };
}

function link(overrides: Partial<EvidenceLink> = {}): EvidenceLink {
  return {
    artifact: {
      file: "tests/auth/guard.test.ts",
      testName: "guard denies anonymous",
      changedInRange: true,
      skipMarked: false,
    },
    directness: "direct",
    independent: true,
    execution: "not-verified",
    rationale: "match",
    ...overrides,
  };
}

function evaluatedClaim(overrides: {
  text?: string;
  severity?: "low" | "medium" | "high" | "critical";
  components?: string[];
  links?: EvidenceLink[];
}): EvaluatedClaim {
  const links = overrides.links ?? [];
  return {
    claim: {
      id: "c1",
      text: overrides.text ?? "Auth guard keeps denying anonymous sessions",
      kind: "invariant-preserved",
      components: overrides.components ?? ["src/auth/guard.ts"],
      severityIfFalse: overrides.severity ?? "critical",
      confidence: "llm",
    },
    links,
    status: links.length > 0 ? "supported" : "unsupported",
  };
}

function policyWith(rules: Partial<PolicyConfig["rules"]>, extra: Partial<PolicyConfig> = {}): PolicyConfig {
  return {
    ...DEFAULT_POLICY,
    ...extra,
    rules: { ...DEFAULT_POLICY.rules, ...rules },
  };
}

const emptyInput = {
  findings: [] as RiskFinding[],
  claims: [] as EvaluatedClaim[],
  invariants: [] as InvariantStatus[],
  rollback: irrelevantRollback,
};

// ── Glob matcher ─────────────────────────────────────────────

describe("matchGlob", () => {
  it("matches ** across depth", () => {
    expect(matchGlob("src/db/**", "src/db/queries/tenant.ts")).toBe(true);
    expect(matchGlob("src/db/**", "src/db/x.ts")).toBe(true);
    expect(matchGlob("src/db/**", "src/api/x.ts")).toBe(false);
  });

  it("matches * within a segment only", () => {
    expect(matchGlob("migrations/*.sql", "migrations/002.sql")).toBe(true);
    expect(matchGlob("migrations/*.sql", "migrations/sub/002.sql")).toBe(false);
  });

  it("matches leading **", () => {
    expect(matchGlob("**/migrations/*", "app/db/migrations/002.sql")).toBe(true);
    expect(matchGlob("**/migrations/*", "migrations/002.sql")).toBe(true);
  });

  it("escapes regex metacharacters in patterns", () => {
    expect(matchGlob("src/a.b/c.ts", "src/a.b/c.ts")).toBe(true);
    expect(matchGlob("src/a.b/c.ts", "src/aXb/cYts")).toBe(false);
  });
});

// ── Block rules ──────────────────────────────────────────────

describe("block rules", () => {
  it("shipped default never blocks a destructive migration (advisory-first)", () => {
    const result = evaluatePolicy(DEFAULT_POLICY, {
      ...emptyInput,
      findings: [finding({})],
      rollback: noRollback,
    });
    expect(result.verdict).toBe("pass-with-warnings");
  });

  it("blocks destructive migration without rollback when the rule is enabled", () => {
    const policy = policyWith({ block_destructive_migration_without_rollback: true });
    const result = evaluatePolicy(policy, {
      ...emptyInput,
      findings: [finding({})],
      rollback: noRollback,
    });
    expect(result.verdict).toBe("block");
    expect(result.reasons[0]!.ruleId).toBe("block_destructive_migration_without_rollback");
  });

  it("does not block when rollback is detected", () => {
    const policy = policyWith({ block_destructive_migration_without_rollback: true });
    const result = evaluatePolicy(policy, {
      ...emptyInput,
      findings: [finding({})],
      rollback: rollbackOk,
    });
    expect(result.verdict).not.toBe("block");
  });

  it("blocks high-confidence permission change without qualifying evidence", () => {
    const policy = policyWith({ block_permission_change_without_auth_test: true });
    const result = evaluatePolicy(policy, {
      ...emptyInput,
      findings: [finding({ category: "permission", severity: "warning", confidence: "high", files: ["src/auth/guard.ts"] })],
      claims: [evaluatedClaim({ links: [] })],
    });
    expect(result.verdict).toBe("block");
  });

  it("does not block permission change with qualifying auth evidence", () => {
    const policy = policyWith({ block_permission_change_without_auth_test: true });
    const result = evaluatePolicy(policy, {
      ...emptyInput,
      findings: [finding({ category: "permission", severity: "warning", confidence: "high", files: ["src/auth/guard.ts"] })],
      claims: [evaluatedClaim({ links: [link()] })],
    });
    expect(result.verdict).not.toBe("block");
  });

  it("keyword-only permission findings never block, even with the rule enabled", () => {
    const policy = policyWith({ block_permission_change_without_auth_test: true });
    const result = evaluatePolicy(policy, {
      ...emptyInput,
      findings: [finding({ category: "permission", severity: "info", confidence: "low", files: ["src/http/client.ts"] })],
      claims: [evaluatedClaim({ severity: "low", links: [] })],
    });
    expect(result.verdict).not.toBe("block");
  });

  it("downgrades non-independent evidence and blocks with an explanatory reason", () => {
    const policy = policyWith({ block_permission_change_without_auth_test: true });
    const result = evaluatePolicy(policy, {
      ...emptyInput,
      findings: [finding({ category: "permission", severity: "warning", confidence: "high", files: ["src/auth/guard.ts"] })],
      claims: [evaluatedClaim({ links: [link({ independent: false })] })],
    });
    expect(result.verdict).toBe("block");
    expect(result.reasons[0]!.message).toContain("downgraded to proxy");
  });

  it("skip-marked evidence does not qualify for block rules", () => {
    const policy = policyWith({ block_permission_change_without_auth_test: true });
    const result = evaluatePolicy(policy, {
      ...emptyInput,
      findings: [finding({ category: "permission", severity: "warning", confidence: "high", files: ["src/auth/guard.ts"] })],
      claims: [
        evaluatedClaim({
          links: [link({ artifact: { file: "tests/auth/guard.test.ts", testName: "x", changedInRange: true, skipMarked: true } })],
        }),
      ],
    });
    expect(result.verdict).toBe("block");
  });

  it("blocks material claims without qualifying direct evidence when enabled", () => {
    const policy = policyWith({ block_critical_claim_without_direct_evidence: true });
    const result = evaluatePolicy(policy, {
      ...emptyInput,
      claims: [evaluatedClaim({ links: [link({ directness: "proxy" })] })],
    });
    expect(result.verdict).toBe("block");
    expect(result.reasons[0]!.ruleId).toBe("block_critical_claim_without_direct_evidence");
  });
});

// ── Verdict ladder ───────────────────────────────────────────

describe("verdict ladder", () => {
  it("returns split-required above the cluster threshold", () => {
    const result = evaluatePolicy(DEFAULT_POLICY, {
      ...emptyInput,
      findings: [
        finding({
          category: "unrelated-changes",
          severity: "warning",
          explanation: "Change spans 3 weakly coupled concerns (threshold 2); consider splitting.",
          clusters: [["a"], ["b"], ["c"]],
        }),
      ],
    });
    expect(result.verdict).toBe("split-required");
  });

  it("returns needs-evidence for unsupported material claims", () => {
    const result = evaluatePolicy(DEFAULT_POLICY, {
      ...emptyInput,
      claims: [evaluatedClaim({ severity: "critical", links: [] })],
    });
    expect(result.verdict).toBe("needs-evidence");
    expect(result.reasons[0]!.ruleId).toBe("needs_evidence_material_claim");
  });

  it("returns pass-with-warnings for unsupported low-severity claims only", () => {
    const result = evaluatePolicy(DEFAULT_POLICY, {
      ...emptyInput,
      claims: [evaluatedClaim({ severity: "low", links: [] })],
    });
    expect(result.verdict).toBe("pass-with-warnings");
  });

  it("a lone low-severity intent-unknown claim never drives needs-evidence", () => {
    const result = evaluatePolicy(DEFAULT_POLICY, {
      ...emptyInput,
      claims: [
        evaluatedClaim({
          text: "Intent unknown: no task description was provided.",
          severity: "low",
          components: [],
          links: [],
        }),
      ],
    });
    expect(result.verdict).toBe("pass-with-warnings");
  });

  it("returns pass for a clean supported change", () => {
    const result = evaluatePolicy(DEFAULT_POLICY, {
      ...emptyInput,
      claims: [evaluatedClaim({ severity: "low", links: [link()] })],
    });
    expect(result.verdict).toBe("pass");
    expect(result.reasons).toHaveLength(0);
  });

  it("block wins when both block and split rules fire", () => {
    const policy = policyWith({ block_destructive_migration_without_rollback: true });
    const result = evaluatePolicy(policy, {
      ...emptyInput,
      findings: [
        finding({}),
        finding({ category: "unrelated-changes", severity: "warning", clusters: [["a"], ["b"], ["c"]] }),
      ],
      rollback: noRollback,
    });
    expect(result.verdict).toBe("block");
  });

  it("every non-pass verdict carries at least one reason", () => {
    const result = evaluatePolicy(DEFAULT_POLICY, {
      ...emptyInput,
      findings: [finding({ severity: "warning" })],
      rollback: rollbackOk,
    });
    expect(result.verdict).toBe("pass-with-warnings");
    expect(result.reasons.length).toBeGreaterThan(0);
  });
});

// ── Invariants ───────────────────────────────────────────────

describe("invariants", () => {
  const tenantPolicy: PolicyConfig = {
    ...DEFAULT_POLICY,
    invariants: [
      {
        name: "tenant-scoping",
        description: "Tenant-scoped queries include a tenant identifier",
        paths: ["src/db/**"],
        requires_evidence: true,
        severity: "critical",
      },
    ],
  };

  function dbChangeSet(): ChangeSet {
    return {
      baseRef: "main",
      headRef: "HEAD",
      mergeBase: "abc",
      rangeLabel: "main...HEAD",
      files: [
        {
          path: "src/db/queries.ts",
          status: "modified",
          additions: 3,
          deletions: 1,
          isBinary: false,
          isTest: false,
          hunks: [],
        },
      ],
      commitSubjects: [],
    };
  }

  it("marks affected invariants without evidence and drives needs-evidence", () => {
    const statuses = evaluateInvariants(tenantPolicy, dbChangeSet(), []);
    expect(statuses[0]!.affected).toBe(true);
    expect(statuses[0]!.evidenced).toBe(false);

    const result = evaluatePolicy(tenantPolicy, {
      ...emptyInput,
      invariants: statuses,
    });
    expect(result.verdict).toBe("needs-evidence");
    expect(result.reasons[0]!.ruleId).toBe("needs_evidence_invariant");
  });

  it("counts qualifying tenant-related evidence", () => {
    const claims = [
      evaluatedClaim({
        text: "Tenant scoping preserved",
        components: ["src/db/queries.ts"],
        links: [
          link({
            artifact: {
              file: "tests/db/tenant-scoping.test.ts",
              testName: "includes tenant id in every query",
              changedInRange: true,
              skipMarked: false,
            },
          }),
        ],
      }),
    ];
    const statuses = evaluateInvariants(tenantPolicy, dbChangeSet(), claims);
    expect(statuses[0]!.evidenced).toBe(true);
  });

  it("leaves untouched invariants unaffected", () => {
    const cs: ChangeSet = { ...dbChangeSet(), files: [] };
    const statuses = evaluateInvariants(tenantPolicy, cs, []);
    expect(statuses[0]!.affected).toBe(false);
  });
});

// ── Policy loading ───────────────────────────────────────────

describe("loadPolicy", () => {
  it("loads a valid policy and applies defaults", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cerberus-policy-"));
    const path = join(dir, "pcc-policy.yaml");
    await writeFile(
      path,
      `version: 1\nrules:\n  block_destructive_migration_without_rollback: true\n`,
      "utf-8",
    );
    const policy = await loadPolicy(path);
    expect(policy.rules.block_destructive_migration_without_rollback).toBe(true);
    expect(policy.rules.block_permission_change_without_auth_test).toBe(false);
    expect(policy.thresholds.max_unrelated_clusters).toBe(2);
    await rm(dir, { recursive: true, force: true });
  });

  it("rejects malformed YAML with exit-2 error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cerberus-policy-"));
    const path = join(dir, "bad.yaml");
    await writeFile(path, "version: [unclosed\n  nope", "utf-8");
    await expect(loadPolicy(path)).rejects.toMatchObject({ exitCode: 2 });
    await rm(dir, { recursive: true, force: true });
  });

  it("rejects schema-invalid policy naming the problem", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cerberus-policy-"));
    const path = join(dir, "invalid.yaml");
    await writeFile(path, "version: 2\n", "utf-8");
    await expect(loadPolicy(path)).rejects.toThrow(/version/);
    await rm(dir, { recursive: true, force: true });
  });

  it("rejects a missing policy file", async () => {
    await expect(loadPolicy("/nonexistent/pcc-policy.yaml")).rejects.toMatchObject({
      exitCode: 2,
    });
  });
});
