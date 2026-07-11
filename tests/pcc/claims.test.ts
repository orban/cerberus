import { describe, it, expect } from "vitest";
import {
  buildClaimPrompt,
  parseClaimsResponse,
  generateClaims,
  deterministicClaims,
} from "../../src/pcc/claims.js";
import type { ChangeSet, FileChange, RiskFinding } from "../../src/pcc/types.js";

function file(path: string, added: string[] = []): FileChange {
  return {
    path,
    status: "modified",
    additions: added.length,
    deletions: 0,
    isBinary: false,
    isTest: false,
    hunks: [{ header: "@@", added, removed: [] }],
  };
}

function changeSet(overrides: Partial<ChangeSet> = {}): ChangeSet {
  return {
    baseRef: "main",
    headRef: "HEAD",
    mergeBase: "abc",
    rangeLabel: "main...HEAD",
    files: [file("src/retry.ts", ["const retries = 3;"])],
    commitSubjects: ["add retry logic"],
    ...overrides,
  };
}

const permissionFinding: RiskFinding = {
  category: "permission",
  severity: "warning",
  confidence: "high",
  files: ["src/auth/guard.ts"],
  explanation: "Changes under auth/permission path segments.",
};

describe("buildClaimPrompt", () => {
  it("contains description, finding, and diff excerpt", () => {
    const prompt = buildClaimPrompt(
      changeSet({ description: "Make payment retries idempotent" }),
      [permissionFinding],
    );
    expect(prompt).toContain("Make payment retries idempotent");
    expect(prompt).toContain("permission");
    expect(prompt).toContain("const retries = 3;");
  });

  it("stays under the cap for oversized diffs", () => {
    const big = changeSet({
      files: Array.from({ length: 200 }, (_, i) =>
        file(`src/f${i}.ts`, Array.from({ length: 40 }, (_, j) => `const line${j} = ${j};`)),
      ),
    });
    const prompt = buildClaimPrompt(big, []);
    expect(prompt.length).toBeLessThan(12_000);
    expect(prompt).toContain("(truncated)");
  });

  it("redacts secrets from hunk excerpts", () => {
    const cs = changeSet({
      files: [file("src/config.ts", ['const key = "AKIAIOSFODNN7EXAMPLE";'])],
    });
    const prompt = buildClaimPrompt(cs, []);
    expect(prompt).toContain("[REDACTED]");
    expect(prompt).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("minimal mode omits hunk content", () => {
    const prompt = buildClaimPrompt(changeSet(), [], "minimal");
    expect(prompt).toContain("src/retry.ts");
    expect(prompt).not.toContain("const retries = 3;");
  });
});

describe("parseClaimsResponse", () => {
  const valid = JSON.stringify([
    {
      text: "Retries do not duplicate payment records",
      kind: "invariant-preserved",
      components: ["src/retry.ts"],
      severity_if_false: "critical",
    },
  ]);

  it("parses clean JSON", () => {
    const claims = parseClaimsResponse(valid);
    expect(claims).toHaveLength(1);
    expect(claims[0]!.confidence).toBe("llm");
    expect(claims[0]!.severityIfFalse).toBe("critical");
  });

  it("parses fenced JSON", () => {
    const claims = parseClaimsResponse("Here you go:\n```json\n" + valid + "\n```");
    expect(claims).toHaveLength(1);
  });

  it("parses prose-wrapped JSON", () => {
    const claims = parseClaimsResponse("My analysis: " + valid + " — done.");
    expect(claims).toHaveLength(1);
  });

  it("rejects a response missing text", () => {
    expect(() => parseClaimsResponse('[{"kind": "behavior-change"}]')).toThrow(
      "Could not parse claims",
    );
  });
});

describe("generateClaims", () => {
  it("uses injected LLM output", async () => {
    const fake = async () =>
      JSON.stringify([
        { text: "A", kind: "behavior-change", components: [], severity_if_false: "high" },
        { text: "B", kind: "invariant-preserved", components: [], severity_if_false: "low" },
      ]);
    const claims = await generateClaims(changeSet(), [], { callModel: fake, warn: () => {} });
    expect(claims).toHaveLength(2);
    expect(claims.every((c) => c.confidence === "llm")).toBe(true);
  });

  it("falls back to deterministic claims when the LLM throws", async () => {
    const failing = async () => {
      throw new Error("429");
    };
    const warnings: string[] = [];
    const claims = await generateClaims(changeSet(), [permissionFinding], {
      callModel: failing,
      warn: (m) => warnings.push(m),
    });
    expect(claims.length).toBeGreaterThan(0);
    expect(claims.every((c) => c.confidence !== "llm")).toBe(true);
    expect(warnings.some((w) => w.includes("falling back"))).toBe(true);
  });

  it("--no-llm with a permission finding yields deterministic + intent-unknown claims", async () => {
    const claims = await generateClaims(changeSet(), [permissionFinding], {
      noLlm: true,
      warn: () => {},
    });
    expect(claims.some((c) => c.confidence === "deterministic")).toBe(true);
    const unknown = claims.find((c) => c.text.includes("Intent unknown"));
    expect(unknown).toBeDefined();
    expect(unknown!.severityIfFalse).toBe("low");
  });

  it("omits the intent-unknown claim when a description exists", () => {
    const claims = deterministicClaims(
      changeSet({ description: "refactor retry" }),
      [permissionFinding],
    );
    expect(claims.some((c) => c.text.includes("Intent unknown"))).toBe(false);
  });
});
