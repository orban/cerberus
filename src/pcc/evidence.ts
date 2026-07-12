import type {
  ChangeSet,
  Claim,
  EvaluatedClaim,
  EvidenceLink,
  FileChange,
} from "./types.js";
import { ASSERTION_LINE, SKIP_MARKER } from "./detectors.js";

// ── Test name extraction ─────────────────────────────────────

const JS_TEST_NAME = /\b(?:it|test|describe)\s*\(\s*['"`](.+?)['"`]/g;
const PY_TEST_NAME = /\bdef\s+(test_\w+)/g;

export function extractTestNames(lines: readonly string[]): string[] {
  const names: string[] = [];
  for (const line of lines) {
    for (const match of line.matchAll(JS_TEST_NAME)) {
      if (match[1] !== undefined) names.push(match[1]);
    }
    for (const match of line.matchAll(PY_TEST_NAME)) {
      if (match[1] !== undefined) names.push(match[1]);
    }
  }
  return names;
}

// ── Tokenization & affinity ──────────────────────────────────

const STOPWORDS = new Set([
  "the", "and", "for", "not", "with", "that", "this", "are", "was", "when",
  "then", "does", "into", "from", "have", "has", "can", "will", "must",
  "should", "test", "tests", "spec", "src",
]);

export function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2 && !STOPWORDS.has(t)),
  );
}

function overlap(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared;
}

// A mapping is "strong" when the test shares at least MIN_SHARED_TOKENS
// with the claim's text+components. Tuned for terse real-world test names:
// two meaningful shared tokens beats a raw ratio on short strings.
const MIN_SHARED_TOKENS = 2;

// ── Mapping ──────────────────────────────────────────────────

interface TestCandidate {
  readonly file: string;
  readonly testName?: string;
  readonly changedInRange: boolean;
  readonly skipMarked: boolean;
  readonly assertionsRewritten: boolean;
  readonly tokens: Set<string>;
}

function assertionsRewritten(file: FileChange): boolean {
  const removed = file.hunks.flatMap((h) => h.removed).filter((l) => ASSERTION_LINE.test(l));
  const added = file.hunks.flatMap((h) => h.added).filter((l) => ASSERTION_LINE.test(l));
  return removed.length > 0 && added.length > 0;
}

function collectCandidates(
  changeSet: ChangeSet,
  repoTestFiles: readonly string[],
): TestCandidate[] {
  const candidates: TestCandidate[] = [];

  for (const f of changeSet.files) {
    if (!f.isTest || f.status === "deleted") continue;
    const addedLines = f.hunks.flatMap((h) => h.added);
    const skipMarked = addedLines.some((l) => SKIP_MARKER.test(l));
    const rewritten = assertionsRewritten(f);
    const names = extractTestNames(addedLines);
    const pathTokens = tokenize(f.path);
    if (names.length === 0) {
      candidates.push({
        file: f.path,
        changedInRange: true,
        skipMarked,
        assertionsRewritten: rewritten,
        tokens: pathTokens,
      });
    }
    for (const name of names) {
      candidates.push({
        file: f.path,
        testName: name,
        changedInRange: true,
        skipMarked,
        assertionsRewritten: rewritten,
        tokens: new Set([...tokenize(name), ...pathTokens]),
      });
    }
  }

  const changedPaths = new Set(changeSet.files.map((f) => f.path));
  for (const path of repoTestFiles) {
    if (changedPaths.has(path)) continue;
    candidates.push({
      file: path,
      changedInRange: false,
      skipMarked: false,
      assertionsRewritten: false,
      tokens: tokenize(path),
    });
  }

  return candidates;
}

function claimTokens(claim: Claim): Set<string> {
  return new Set([
    ...tokenize(claim.text),
    ...claim.components.flatMap((c) => [...tokenize(c)]),
  ]);
}

function implementationFiles(changeSet: ChangeSet): Set<string> {
  return new Set(changeSet.files.filter((f) => !f.isTest).map((f) => f.path));
}

export function mapEvidence(
  changeSet: ChangeSet,
  claims: readonly Claim[],
  repoTestFiles: readonly string[] = [],
): EvaluatedClaim[] {
  const candidates = collectCandidates(changeSet, repoTestFiles);
  const implFiles = implementationFiles(changeSet);

  return claims.map((claim) => {
    const tokens = claimTokens(claim);
    const links: EvidenceLink[] = [];

    for (const candidate of candidates) {
      const shared = overlap(tokens, candidate.tokens);
      if (shared < MIN_SHARED_TOKENS) continue;

      // Non-independent when the claim's implementation files changed in the
      // same range AND the evidencing test rewrote its expectations.
      const claimTouchesImpl =
        claim.components.length === 0 ||
        claim.components.some((c) => implFiles.has(c));
      const independent = !(
        candidate.changedInRange &&
        candidate.assertionsRewritten &&
        claimTouchesImpl
      );

      links.push({
        artifact: {
          file: candidate.file,
          testName: candidate.testName,
          changedInRange: candidate.changedInRange,
          skipMarked: candidate.skipMarked,
        },
        directness: candidate.changedInRange ? "direct" : "proxy",
        independent,
        execution: "not-verified",
        rationale: `${shared} shared token(s) between claim and ${
          candidate.testName ? `test "${candidate.testName}"` : "test file"
        } (statically mapped — execution not verified)`,
      });
    }

    // Deduplicate: keep the strongest link per file (named beats file-level).
    const byFile = new Map<string, EvidenceLink>();
    for (const link of links) {
      const existing = byFile.get(link.artifact.file);
      if (!existing || (link.artifact.testName && !existing.artifact.testName)) {
        byFile.set(link.artifact.file, link);
      }
    }
    const finalLinks = [...byFile.values()];

    return {
      claim,
      links: finalLinks,
      status: finalLinks.length > 0 ? "supported" : "unsupported",
    };
  });
}
