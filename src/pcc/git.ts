import { spawn } from "node:child_process";
import type { ChangeSet, FileChange, FileHunk, FileStatus } from "./types.js";
import { CerberusError, ConfigError } from "../errors.js";
import { EXIT_CODE } from "../types.js";

// ── Spawn helper ─────────────────────────────────────────────

export interface GitOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export async function runGit(
  args: readonly string[],
  cwd: string,
): Promise<GitOutput> {
  return new Promise<GitOutput>((resolve, reject) => {
    const child = spawn("git", [...args], {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => stdoutChunks.push(c));
    child.stderr.on("data", (c: Buffer) => stderrChunks.push(c));

    child.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        exitCode: code ?? 1,
      });
    });

    child.on("error", (err) => {
      reject(
        new CerberusError(
          `Failed to spawn git: ${err.message}`,
          EXIT_CODE.RUNTIME_ERROR,
        ),
      );
    });
  });
}

async function gitOrThrow(
  args: readonly string[],
  cwd: string,
  context: string,
): Promise<string> {
  const result = await runGit(args, cwd);
  if (result.exitCode !== 0) {
    throw new ConfigError(
      `${context}: git ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout;
}

// Refs are user input. spawn(shell:false) blocks shell injection but not
// argument injection — a ref starting with "-" would parse as a git flag.
function assertSafeRef(ref: string): void {
  if (ref.startsWith("-")) {
    throw new ConfigError(`Invalid ref (must not start with "-"): ${ref}`);
  }
}

async function refExists(ref: string, cwd: string): Promise<boolean> {
  const result = await runGit(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd);
  return result.exitCode === 0;
}

// ── Base resolution ──────────────────────────────────────────

const BASE_CANDIDATES = ["origin/HEAD", "origin/main", "origin/master", "main", "master"];

export async function resolveBase(
  cwd: string,
  baseFlag?: string,
): Promise<string> {
  if (baseFlag) {
    assertSafeRef(baseFlag);
    if (!(await refExists(baseFlag, cwd))) {
      throw new ConfigError(`Base ref not found: ${baseFlag}`);
    }
    return baseFlag;
  }
  for (const candidate of BASE_CANDIDATES) {
    if (await refExists(candidate, cwd)) return candidate;
  }
  throw new ConfigError(
    "Cannot resolve a base ref: no origin/HEAD, origin/main, origin/master, main, or master. Pass one explicitly with --base.",
  );
}

// ── Range parsing ────────────────────────────────────────────
// Every range form (two-dot, three-dot, single ref) normalizes to
// merge-base(base, head)..head so endpoint-diff semantics never leak
// upstream commits into findings or the claim prompt.

export interface ResolvedRange {
  readonly baseRef: string;
  readonly headRef: string;
  readonly mergeBase: string;
  readonly label: string;
}

export async function resolveRange(
  cwd: string,
  range?: string,
  baseFlag?: string,
): Promise<ResolvedRange> {
  let baseRef: string;
  let headRef = "HEAD";

  if (range && range.includes("..")) {
    // Explicit range wins; --base is ignored.
    const [left, right] = range.split(/\.{2,3}/);
    if (!left || !right) {
      throw new ConfigError(`Cannot parse range: ${range}`);
    }
    baseRef = left;
    headRef = right;
  } else if (range) {
    // A single ref is the base; head defaults to HEAD.
    baseRef = range;
  } else {
    baseRef = await resolveBase(cwd, baseFlag);
  }

  assertSafeRef(baseRef);
  assertSafeRef(headRef);

  for (const ref of [baseRef, headRef]) {
    if (!(await refExists(ref, cwd))) {
      throw new ConfigError(`Ref not found: ${ref}`);
    }
  }

  const mergeBase = (
    await gitOrThrow(["merge-base", baseRef, headRef], cwd, "Resolving merge base")
  ).trim();

  return { baseRef, headRef, mergeBase, label: `${baseRef}...${headRef}` };
}

// ── Test-file classification ─────────────────────────────────

const TEST_PATH_PATTERNS = [
  /\.test\.[cm]?[jt]sx?$/,
  /\.spec\.[cm]?[jt]sx?$/,
  /(^|\/)test_[^/]+\.py$/,
  /_test\.py$/,
  /(^|\/)tests?\//,
  /(^|\/)__tests__\//,
];

export function isTestPath(path: string): boolean {
  return TEST_PATH_PATTERNS.some((re) => re.test(path));
}

// ── Diff parsing ─────────────────────────────────────────────

interface NameStatusEntry {
  readonly status: FileStatus;
  readonly path: string;
  readonly oldPath?: string;
}

function parseNameStatus(raw: string): NameStatusEntry[] {
  const tokens = raw.split("\0").filter((t) => t.length > 0);
  const entries: NameStatusEntry[] = [];
  let i = 0;
  while (i < tokens.length) {
    const code = tokens[i]!;
    if (code.startsWith("R") || code.startsWith("C")) {
      const oldPath = tokens[i + 1];
      const newPath = tokens[i + 2];
      if (oldPath !== undefined && newPath !== undefined) {
        entries.push({ status: "renamed", path: newPath, oldPath });
      }
      i += 3;
    } else {
      const path = tokens[i + 1];
      if (path !== undefined) {
        const status: FileStatus =
          code === "A" ? "added" : code === "D" ? "deleted" : "modified";
        entries.push({ status, path });
      }
      i += 2;
    }
  }
  return entries;
}

interface NumstatEntry {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
  readonly isBinary: boolean;
}

function parseNumstat(raw: string): Map<string, NumstatEntry> {
  const tokens = raw.split("\0").filter((t) => t.length > 0 || true);
  const entries = new Map<string, NumstatEntry>();
  let i = 0;
  while (i < tokens.length) {
    const head = tokens[i];
    if (head === undefined || head.length === 0) {
      i++;
      continue;
    }
    const parts = head.split("\t");
    const [addedStr, deletedStr, inlinePath] = [parts[0], parts[1], parts[2]];
    if (addedStr === undefined || deletedStr === undefined) {
      i++;
      continue;
    }
    const isBinary = addedStr === "-";
    const additions = isBinary ? 0 : Number(addedStr);
    const deletions = isBinary ? 0 : Number(deletedStr);
    if (inlinePath !== undefined && inlinePath.length > 0) {
      entries.set(inlinePath, { path: inlinePath, additions, deletions, isBinary });
      i += 1;
    } else {
      // Rename: "added\tdeleted\t" followed by NUL old NUL new
      const newPath = tokens[i + 2];
      if (newPath !== undefined) {
        entries.set(newPath, { path: newPath, additions, deletions, isBinary });
      }
      i += 3;
    }
  }
  return entries;
}

function parseHunks(patch: string): Map<string, FileHunk[]> {
  const perFile = new Map<string, FileHunk[]>();
  let currentFile: string | null = null;
  let currentHunk: { header: string; added: string[]; removed: string[] } | null = null;

  const flush = () => {
    if (currentFile && currentHunk) {
      const list = perFile.get(currentFile) ?? [];
      list.push({
        header: currentHunk.header,
        added: currentHunk.added,
        removed: currentHunk.removed,
      });
      perFile.set(currentFile, list);
    }
    currentHunk = null;
  };

  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      const match = line.match(/ b\/(.+)$/);
      currentFile = match?.[1] ?? null;
    } else if (line.startsWith("@@")) {
      flush();
      currentHunk = { header: line, added: [], removed: [] };
    } else if (currentHunk) {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        currentHunk.added.push(line.slice(1));
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        currentHunk.removed.push(line.slice(1));
      }
    }
  }
  flush();
  return perFile;
}

// ── ChangeSet collection ─────────────────────────────────────

export interface CollectOptions {
  readonly cwd: string;
  readonly range?: string;
  readonly base?: string;
  readonly description?: string;
}

export async function collectChangeSet(
  options: CollectOptions,
): Promise<ChangeSet> {
  const { cwd } = options;

  const inRepo = await runGit(["rev-parse", "--git-dir"], cwd);
  if (inRepo.exitCode !== 0) {
    throw new ConfigError(`Not a git repository: ${cwd}`);
  }

  const { baseRef, headRef, mergeBase, label } = await resolveRange(
    cwd,
    options.range,
    options.base,
  );

  const nameStatusRaw = await gitOrThrow(
    ["diff", "--name-status", "-M", "-z", mergeBase, headRef, "--"],
    cwd,
    "Collecting change statuses",
  );
  const numstatRaw = await gitOrThrow(
    ["diff", "--numstat", "-M", "-z", mergeBase, headRef, "--"],
    cwd,
    "Collecting change sizes",
  );
  const patchRaw = await gitOrThrow(
    ["diff", "-U0", "-M", mergeBase, headRef, "--"],
    cwd,
    "Collecting change content",
  );
  const logRaw = await gitOrThrow(
    ["log", "--format=%s", `${mergeBase}..${headRef}`, "--"],
    cwd,
    "Collecting commit subjects",
  );

  const statuses = parseNameStatus(nameStatusRaw);
  const sizes = parseNumstat(numstatRaw);
  const hunks = parseHunks(patchRaw);

  const files: FileChange[] = statuses.map((entry) => {
    const size = sizes.get(entry.path);
    return {
      path: entry.path,
      ...(entry.oldPath !== undefined ? { oldPath: entry.oldPath } : {}),
      status: entry.status,
      additions: size?.additions ?? 0,
      deletions: size?.deletions ?? 0,
      isBinary: size?.isBinary ?? false,
      isTest: isTestPath(entry.path),
      hunks: hunks.get(entry.path) ?? [],
    };
  });

  return {
    baseRef,
    headRef,
    mergeBase,
    rangeLabel: label,
    files,
    commitSubjects: logRaw.split("\n").filter((s) => s.length > 0),
    ...(options.description !== undefined
      ? { description: options.description }
      : {}),
  };
}

// ── Repo test inventory (for proxy evidence mapping) ─────────

export async function listRepoTestFiles(cwd: string): Promise<string[]> {
  const raw = await gitOrThrow(["ls-files", "-z"], cwd, "Listing repo files");
  return raw
    .split("\0")
    .filter((p) => p.length > 0)
    .filter(isTestPath);
}
