import { describe, it, expect } from "vitest";
import { mapEvidence, extractTestNames, tokenize } from "../../src/pcc/evidence.js";
import type { ChangeSet, Claim, FileChange } from "../../src/pcc/types.js";

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

function changeSet(files: FileChange[]): ChangeSet {
  return {
    baseRef: "main",
    headRef: "HEAD",
    mergeBase: "abc",
    rangeLabel: "main...HEAD",
    files,
    commitSubjects: [],
  };
}

function claim(text: string, components: string[] = [], overrides: Partial<Claim> = {}): Claim {
  return {
    id: "c1",
    text,
    kind: "invariant-preserved",
    components,
    severityIfFalse: "critical",
    confidence: "llm",
    ...overrides,
  };
}

describe("extractTestNames", () => {
  it("extracts js and python test names", () => {
    const names = extractTestNames([
      'it("does not duplicate payment records", () => {',
      'test(`retries idempotently`, async () => {',
      "def test_payment_dedupe(self):",
    ]);
    expect(names).toContain("does not duplicate payment records");
    expect(names).toContain("retries idempotently");
    expect(names).toContain("test_payment_dedupe");
  });
});

describe("mapEvidence", () => {
  it("maps a new matching test as direct evidence", () => {
    const cs = changeSet([
      file("src/retry.ts"),
      file("tests/retry.test.ts", {
        status: "added",
        hunks: [
          {
            header: "@@",
            added: ['it("does not duplicate payment records", () => {', "expect(records).toHaveLength(1);"],
            removed: [],
          },
        ],
      }),
    ]);
    const evaluated = mapEvidence(cs, [
      claim("The new retry behavior does not create duplicate payment records", ["src/retry.ts"]),
    ]);
    expect(evaluated[0]!.status).toBe("supported");
    const link = evaluated[0]!.links[0]!;
    expect(link.directness).toBe("direct");
    expect(link.execution).toBe("not-verified");
    expect(link.rationale).toContain("statically mapped");
  });

  it("leaves unrelated claims unsupported", () => {
    const cs = changeSet([
      file("src/retry.ts"),
      file("tests/parser.test.ts", {
        hunks: [{ header: "@@", added: ['it("parses yaml anchors", () => {'], removed: [] }],
      }),
    ]);
    const evaluated = mapEvidence(cs, [
      claim("Unauthenticated requests to /admin continue to return 401"),
    ]);
    expect(evaluated[0]!.status).toBe("unsupported");
    expect(evaluated[0]!.links).toHaveLength(0);
  });

  it("maps pre-existing untouched test suites as proxy", () => {
    const cs = changeSet([file("src/schema/compat.ts")]);
    const evaluated = mapEvidence(
      cs,
      [claim("Schema compat checks remain enforced", ["src/schema/compat.ts"])],
      ["tests/schema/compat.test.ts"],
    );
    expect(evaluated[0]!.status).toBe("supported");
    expect(evaluated[0]!.links[0]!.directness).toBe("proxy");
    expect(evaluated[0]!.links[0]!.artifact.changedInRange).toBe(false);
  });

  it("flags co-modified impl+test with rewritten assertions as non-independent", () => {
    const cs = changeSet([
      file("src/auth/guard.ts"),
      file("tests/auth/guard.test.ts", {
        hunks: [
          {
            header: "@@",
            added: ['it("guard allows admin role", () => {', "expect(allowed).toBe(true);"],
            removed: ["expect(allowed).toBe(false);"],
          },
        ],
      }),
    ]);
    const evaluated = mapEvidence(cs, [
      claim("Guard role checks remain enforced for admin", ["src/auth/guard.ts"]),
    ]);
    const link = evaluated[0]!.links[0]!;
    expect(link.directness).toBe("direct");
    expect(link.independent).toBe(false);
  });

  it("keeps independence when only the test changed", () => {
    const cs = changeSet([
      file("tests/auth/guard.test.ts", {
        hunks: [
          {
            header: "@@",
            added: ['it("guard denies anonymous sessions", () => {', "expect(denied).toBe(true);"],
            removed: [],
          },
        ],
      }),
    ]);
    const evaluated = mapEvidence(cs, [
      claim("Guard denies anonymous sessions", ["src/auth/guard.ts"]),
    ]);
    expect(evaluated[0]!.links[0]!.independent).toBe(true);
  });

  it("marks skip-marked tests on the link", () => {
    const cs = changeSet([
      file("tests/auth/guard.test.ts", {
        hunks: [
          {
            header: "@@",
            added: ['it.skip("guard denies anonymous sessions", () => {'],
            removed: [],
          },
        ],
      }),
    ]);
    const evaluated = mapEvidence(cs, [
      claim("Guard denies anonymous sessions", ["src/auth/guard.ts"]),
    ]);
    expect(evaluated[0]!.links[0]!.artifact.skipMarked).toBe(true);
  });

  it("never maps to nonexistent artifacts", () => {
    // Candidates come only from the ChangeSet and the verified repo test
    // inventory — a fabricated path can't enter the mapping.
    const cs = changeSet([file("src/retry.ts")]);
    const evaluated = mapEvidence(cs, [claim("retry works", ["src/retry.ts"])], []);
    expect(evaluated[0]!.links).toHaveLength(0);
  });
});

describe("tokenize", () => {
  it("drops stopwords and short tokens", () => {
    const tokens = tokenize("The retry does not duplicate payment records");
    expect(tokens.has("retry")).toBe(true);
    expect(tokens.has("payment")).toBe(true);
    expect(tokens.has("the")).toBe(false);
    expect(tokens.has("not")).toBe(false);
  });
});
