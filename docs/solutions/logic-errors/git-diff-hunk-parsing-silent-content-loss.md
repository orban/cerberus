---
title: Git diff hunk parsing silently loses content three ways
date: 2026-07-11
category: logic-errors
module: pcc
problem_type: logic_error
component: tooling
symptoms:
  - "Files with non-ASCII names had zero hunks — every content detector (secrets, destructive SQL, weakened assertions) saw an empty file"
  - "Paths containing spaces produced empty hunks even after fixing quoting"
  - "Added lines like '++counter;' and removed lines like '-- sql comment' were absent from parsed hunks"
root_cause: logic_error
resolution_type: code_fix
severity: high
tags: [git, unified-diff, parsing, quotepath, hunks, detector-evasion]
---

# Git diff hunk parsing silently loses content three ways

## Problem

`parseHunks` in `src/pcc/git.ts` keys hunks by filename extracted from `diff --git` header lines and filters content lines against `+++`/`---` prefixes. Three independent git behaviors made it silently drop content — and because the consumer is a risk-detection gate, lost hunks meant detectors passed files they never actually inspected. Adversarial review framing: a contributor could evade secret/SQL/test-integrity detection just by using a non-ASCII filename.

## Symptoms

- `hunks.get(path)` returned `[]` for files with non-ASCII names, while `--name-status -z` listed them fine
- A regression test for a path containing `' b/'` (e.g. `src/a b/c.ts`) still got empty hunks after the quoting fix
- Added `++counter;` / removed `-- sql comment` lines never appeared in any hunk

## What Didn't Work

- **Matching the `diff --git a/... b/...` line with `/ b\/(.+)$/`** — two failures: git's default `core.quotepath=true` renders non-ASCII paths as quoted C-escaped strings (`"a/\346\227\245..."`) in patch headers while `-z` plumbing emits raw bytes, so the keys never match; and for paths containing `' b/'` the regex anchors on the first occurrence inside the *a*-path and captures garbage.
- **Deriving the filename from `+++ b/<path>` without trimming** — closer, but the test still failed: git appends a **trailing tab** to `---`/`+++` header paths that contain spaces (GNU diff timestamp-separator convention), so the key was `"src/a b/c.ts\t"`.

## Solution

Three coordinated changes in `src/pcc/git.ts` (commit 54d6628):

1. Run the patch diff with quoting off so header paths match the `-z` plumbing output:

```ts
gitOrThrow(
  ["-c", "core.quotepath=false", "diff", "-U0", "-M", mergeBase, headRef, "--"],
  cwd, "Collecting change content",
),
```

2. Derive the hunk key from the unambiguous `---`/`+++` header lines (which only appear while `currentHunk` is null), stripping the trailing tab; keep the `diff --git` regex only as a fallback. Deleted files (`+++ /dev/null`) key by the stashed old path so they match their name-status entry:

```ts
} else if (!currentHunk && line.startsWith("--- a/")) {
  pendingOldFile = line.slice(6).replace(/\t$/, "");
} else if (!currentHunk && line.startsWith("+++ ")) {
  const target = line.slice(4).replace(/\t$/, "");
  currentFile = target.startsWith("b/") ? target.slice(2) : (pendingOldFile ?? currentFile);
}
```

3. Drop the `!line.startsWith("+++")` / `!line.startsWith("---")` exclusions inside the hunk-body branch. They were dead guards for their intended purpose — file headers only occur between `diff --git` and the first `@@`, where `currentHunk` is null — so the only lines they ever matched were genuine content: an added line whose content starts with `++` renders as `+++...`, a removed SQL comment `-- x` renders as `--- x`.

## Why This Works

Unified-diff structure guarantees the fix's invariants: header lines (`---`/`+++`) appear only outside hunk bodies, and inside a hunk every line starts with exactly one `+`, `-`, space, or `\`. So (a) header-derived keys are safe to read when `currentHunk` is null, and (b) prefix-testing beyond the first character inside a hunk can only misclassify content. Turning off `core.quotepath` makes the patch stream byte-identical to the `-z` plumbing streams, restoring the key equality the map join depends on.

## Prevention

- When joining output from multiple git commands by path, force identical path encoding on every command — either `-z` everywhere or `-c core.quotepath=false` on the porcelain ones. Mixed encodings fail only on non-ASCII input, which fixtures rarely include.
- Regression tests now cover the full space: UTF-8 filename, `' b/'` path, `++`/`--` content lines, deleted-file hunks (`tests/pcc/git.test.ts`).
- When writing multi-commit test fixtures for range diffs, remember the range diff is the *net* endpoint diff: a line added then replaced on the same branch never appears as removed. Seed "before" state on the base branch.
- Trailing-tab gotcha generalizes: any parser of `---`/`+++` lines must strip `\t$` before using the path.

## Related Issues

- orban/cerberus#2–#21 — residual review findings from the same review pass (see `docs/residual-review-findings/feat-proof-carrying-changes.md`)
- Found by the adversarial + correctness reviewers in ce-code-review run `20260711-173547-cc0ca90b`; the trailing-tab behavior was discovered when the first regression test failed
