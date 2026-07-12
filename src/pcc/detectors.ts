import type {
  ChangeSet,
  FileChange,
  RiskFinding,
  RollbackStatus,
} from "./types.js";

// ── Secret patterns (shared with claim-prompt redaction) ─────

export const SECRET_PATTERNS: readonly RegExp[] = [
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
  /\b(?:bearer|token|api[_-]?key|secret|password)\b['"]?\s*[:=]\s*['"][A-Za-z0-9_\-/+=]{16,}['"]/i,
];

const GLOBAL_SECRET_PATTERNS = SECRET_PATTERNS.map(
  (p) => new RegExp(p.source, p.flags.includes("i") ? "gi" : "g"),
);

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of GLOBAL_SECRET_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}

// Shared with evidence mapping so the two never drift.
export const SKIP_MARKER = /\.skip\s*\(|\bxit\s*\(|\bxdescribe\s*\(|@pytest\.mark\.skip/;
export const ASSERTION_LINE = /\b(expect|assert)\b/;

// ── Helpers ──────────────────────────────────────────────────

function addedLines(file: FileChange): readonly string[] {
  return file.hunks.flatMap((h) => h.added);
}

function removedLines(file: FileChange): readonly string[] {
  return file.hunks.flatMap((h) => h.removed);
}

function changedLines(file: FileChange): readonly string[] {
  return [...addedLines(file), ...removedLines(file)];
}

// ── Migration / schema ───────────────────────────────────────

const MIGRATION_PATH = /(^|\/)(migrations?|db\/migrate|alembic)\/|\.sql$|schema\.prisma$/;
const DESTRUCTIVE_SQL =
  /\b(DROP\s+(TABLE|COLUMN|INDEX)|TRUNCATE|ALTER\s+TABLE\s+\S+\s+DROP)\b/i;
const ROLLBACK_FILE = /\bdown\b|\.down\.sql$|revert/i;
const ROLLBACK_TEXT = /\b(rollback|revert|reversal|down[- ]migration)\b/i;

function detectMigrations(changeSet: ChangeSet): {
  findings: RiskFinding[];
  rollback: RollbackStatus;
} {
  const migrationFiles = changeSet.files.filter((f) => MIGRATION_PATH.test(f.path));
  if (migrationFiles.length === 0) {
    return {
      findings: [],
      rollback: { relevant: false, detected: false, explanation: "No schema or migration changes." },
    };
  }

  const destructive = migrationFiles.filter(
    (f) =>
      f.status === "deleted" ||
      addedLines(f).some((l) => DESTRUCTIVE_SQL.test(l)),
  );

  const rollbackByFile = migrationFiles.some((f) => ROLLBACK_FILE.test(f.path));
  const rollbackByText = ROLLBACK_TEXT.test(changeSet.description ?? "");
  const detected = rollbackByFile || rollbackByText;

  const findings: RiskFinding[] = [
    {
      category: "migration",
      severity: destructive.length > 0 ? "critical" : "warning",
      confidence: "high",
      files: migrationFiles.map((f) => f.path),
      explanation:
        destructive.length > 0
          ? `Destructive schema change (${destructive.map((f) => f.path).join(", ")}).`
          : "Schema or migration files changed (additive).",
      evidence: destructive
        .flatMap((f) => addedLines(f).filter((l) => DESTRUCTIVE_SQL.test(l)))
        .slice(0, 5),
    },
  ];

  return {
    findings,
    rollback: {
      relevant: true,
      detected,
      explanation: detected
        ? rollbackByFile
          ? "Reversal artifact present among changed files."
          : "Rollback described in the change description."
        : "Migration present but no reversal artifact or rollback description found.",
    },
  };
}

// ── Permission / auth ────────────────────────────────────────

const AUTH_PATH = /(^|\/)(auth|authn|authz|permissions?|acl|guards?|rbac)(\/|\.|$)/i;
const AUTH_KEYWORDS =
  /\b(auth|permission|role|acl|guard|scope|session|token|middleware)\b/i;

function detectPermissions(changeSet: ChangeSet): RiskFinding[] {
  const highFiles = changeSet.files.filter(
    (f) => !f.isTest && AUTH_PATH.test(f.path),
  );
  const lowFiles = changeSet.files.filter(
    (f) =>
      !f.isTest &&
      !AUTH_PATH.test(f.path) &&
      changedLines(f).some((l) => AUTH_KEYWORDS.test(l)),
  );

  const findings: RiskFinding[] = [];
  if (highFiles.length > 0) {
    findings.push({
      category: "permission",
      severity: "warning",
      confidence: "high",
      files: highFiles.map((f) => f.path),
      explanation: "Changes under auth/permission path segments.",
    });
  }
  if (lowFiles.length > 0) {
    findings.push({
      category: "permission",
      severity: "info",
      confidence: "low",
      files: lowFiles.map((f) => f.path),
      explanation:
        "Changed lines mention auth-related identifiers (keyword match only — low confidence).",
    });
  }
  return findings;
}

// ── Public API surface ───────────────────────────────────────

const EXPORT_LINE = /^\s*export\s+(default\s+)?(async\s+)?(function|const|class|interface|type|enum|let|var)\b/;
const ROUTE_LINE = /\b(app|router)\.(get|post|put|patch|delete)\s*\(|@app\.route\(/;
const API_SURFACE_FILE = /openapi|swagger|\.graphql$|(^|\/)urls\.py$/i;
const MANIFEST_SURFACE = /"(exports|main|bin|types)"\s*:/;

function detectPublicApi(changeSet: ChangeSet): RiskFinding[] {
  const hits: { file: string; evidence: string }[] = [];

  for (const f of changeSet.files) {
    if (f.isTest) continue;
    const removedExports = removedLines(f).filter((l) => EXPORT_LINE.test(l));
    if (removedExports.length > 0 && removedExports[0] !== undefined) {
      hits.push({ file: f.path, evidence: `removed: ${removedExports[0].trim()}` });
      continue;
    }
    if (changedLines(f).some((l) => ROUTE_LINE.test(l))) {
      hits.push({ file: f.path, evidence: "route registration changed" });
      continue;
    }
    if (API_SURFACE_FILE.test(f.path)) {
      hits.push({ file: f.path, evidence: "API surface file changed" });
      continue;
    }
    if (f.path === "package.json" && changedLines(f).some((l) => MANIFEST_SURFACE.test(l))) {
      hits.push({ file: f.path, evidence: "package entry points changed" });
    }
  }

  if (hits.length === 0) return [];
  return [
    {
      category: "public-api",
      severity: "warning",
      confidence: "high",
      files: hits.map((h) => h.file),
      explanation: "Public API surface changed.",
      evidence: hits.map((h) => `${h.file}: ${h.evidence}`).slice(0, 5),
    },
  ];
}

// ── Dependencies & infrastructure ────────────────────────────

const LOCKFILES =
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|requirements\.txt|pyproject\.toml|poetry\.lock|Gemfile\.lock)$/;
const INFRA_PATH = /(^|\/)(Dockerfile[^/]*|\.github\/workflows\/.+|.+\.tf|(k8s|kubernetes|helm|charts)\/.+)$/;
const DEP_SECTION = /"(dependencies|devDependencies|peerDependencies|optionalDependencies)"\s*:/;

function detectDependencies(changeSet: ChangeSet): RiskFinding[] {
  const findings: RiskFinding[] = [];

  const depFiles = changeSet.files.filter(
    (f) =>
      LOCKFILES.test(f.path) ||
      (f.path.endsWith("package.json") &&
        f.hunks.some(
          (h) =>
            [...h.added, ...h.removed].some((l) => DEP_SECTION.test(l)) ||
            [...h.added, ...h.removed].some((l) => /^\s*"[^"]+"\s*:\s*"[~^]?\d/.test(l)),
        )),
  );
  if (depFiles.length > 0) {
    findings.push({
      category: "dependency",
      severity: "warning",
      confidence: "high",
      files: depFiles.map((f) => f.path),
      explanation: "Dependency manifests or lockfiles changed.",
    });
  }

  const infraFiles = changeSet.files.filter((f) => INFRA_PATH.test(f.path));
  if (infraFiles.length > 0) {
    findings.push({
      category: "infrastructure",
      severity: "warning",
      confidence: "high",
      files: infraFiles.map((f) => f.path),
      explanation: "CI, container, or infrastructure configuration changed.",
    });
  }

  return findings;
}

// ── Test integrity ───────────────────────────────────────────

function detectTestIntegrity(changeSet: ChangeSet): RiskFinding[] {
  const findings: RiskFinding[] = [];

  const deleted = changeSet.files.filter((f) => f.isTest && f.status === "deleted");
  if (deleted.length > 0) {
    findings.push({
      category: "test-integrity",
      severity: "warning",
      confidence: "high",
      files: deleted.map((f) => f.path),
      explanation: "Test files deleted.",
    });
  }

  const weakened = changeSet.files.filter((f) => {
    if (!f.isTest || f.status !== "modified") return false;
    const removed = removedLines(f).filter((l) => ASSERTION_LINE.test(l)).length;
    const added = addedLines(f).filter((l) => ASSERTION_LINE.test(l)).length;
    return removed > added;
  });
  if (weakened.length > 0) {
    findings.push({
      category: "test-integrity",
      severity: "warning",
      confidence: "high",
      files: weakened.map((f) => f.path),
      explanation: "Assertions removed from existing tests (weakened coverage).",
    });
  }

  const skipped = changeSet.files.filter(
    (f) => f.isTest && addedLines(f).some((l) => SKIP_MARKER.test(l)),
  );
  if (skipped.length > 0) {
    findings.push({
      category: "test-integrity",
      severity: "warning",
      confidence: "high",
      files: skipped.map((f) => f.path),
      explanation: "Skip markers added to tests.",
    });
  }

  return findings;
}

// ── Committed secrets ────────────────────────────────────────

function detectSecrets(changeSet: ChangeSet): RiskFinding[] {
  const hits: { file: string }[] = [];
  for (const f of changeSet.files) {
    if (addedLines(f).some((l) => SECRET_PATTERNS.some((p) => p.test(l)))) {
      hits.push({ file: f.path });
    }
  }
  if (hits.length === 0) return [];
  return [
    {
      category: "secret",
      severity: "critical",
      confidence: "high",
      files: hits.map((h) => h.file),
      explanation:
        "Added lines match high-confidence secret patterns. Rotate the credential and remove it from history.",
    },
  ];
}

// ── Unrelated-change clustering ──────────────────────────────

const SOURCE_ROOTS = new Set(["src", "lib", "packages", "apps"]);

export function clusterKey(path: string): string {
  const segments = path.split("/");
  const first = segments[0];
  if (first === undefined || segments.length === 1) return ".";
  if (SOURCE_ROOTS.has(first) && segments.length > 2) {
    return `${first}/${segments[1]}`;
  }
  return first;
}

function basename(path: string): string {
  const last = path.split("/").pop() ?? path;
  return last.replace(/\.[^.]+$/, "");
}

function detectUnrelatedChanges(
  changeSet: ChangeSet,
  clusterThreshold: number,
): RiskFinding[] {
  const clusters = new Map<string, string[]>();
  for (const f of changeSet.files) {
    if (f.isTest) continue;
    const key = clusterKey(f.path);
    const list = clusters.get(key) ?? [];
    list.push(f.path);
    clusters.set(key, list);
  }

  // Light affinity merge: clusters sharing a file basename are one concern.
  const keys = [...clusters.keys()];
  for (const a of keys) {
    for (const b of keys) {
      if (a >= b) continue;
      const filesA = clusters.get(a);
      const filesB = clusters.get(b);
      if (!filesA || !filesB) continue;
      const basenamesA = new Set(filesA.map(basename));
      if (filesB.some((p) => basenamesA.has(basename(p)))) {
        clusters.set(a, [...filesA, ...filesB]);
        clusters.delete(b);
      }
    }
  }

  if (clusters.size <= clusterThreshold) return [];

  return [
    {
      category: "unrelated-changes",
      severity: "warning",
      confidence: "high",
      files: [...clusters.values()].flat(),
      explanation: `Change spans ${clusters.size} weakly coupled concerns (threshold ${clusterThreshold}); consider splitting.`,
      clusters: [...clusters.values()],
    },
  ];
}

// ── Composition ──────────────────────────────────────────────

export interface DetectorOptions {
  readonly clusterThreshold?: number;
}

export interface DetectionResult {
  readonly findings: readonly RiskFinding[];
  readonly rollback: RollbackStatus;
}

export function detectRisks(
  changeSet: ChangeSet,
  options: DetectorOptions = {},
): DetectionResult {
  const clusterThreshold = options.clusterThreshold ?? 2;
  const migrations = detectMigrations(changeSet);

  return {
    findings: [
      ...migrations.findings,
      ...detectPermissions(changeSet),
      ...detectPublicApi(changeSet),
      ...detectDependencies(changeSet),
      ...detectTestIntegrity(changeSet),
      ...detectSecrets(changeSet),
      ...detectUnrelatedChanges(changeSet, clusterThreshold),
    ],
    rollback: migrations.rollback,
  };
}
