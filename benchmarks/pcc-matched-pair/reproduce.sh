#!/usr/bin/env bash
# Reproduce the PCC matched-pair cells (case-05 / case-06).
#
# The PCC engine and its benchmark exist only at the closed-branch commit
# below, so this script checks that commit out into a temporary git worktree,
# builds it, and runs the original six-case benchmark from there. It then
# prints the matched-pair rows of the resulting summary. Nothing in this
# package's results directory is modified.
#
# Environment:
#   OPENAI_API_KEY   if unset, LLM-mode cells are skipped (recorded NOT TESTED)
#   DET_RUNS         deterministic runs per cell (default 5)
#   LLM_RUNS         LLM runs per cell (default 5; 0 skips)
#   MODEL            claim-extraction model (default gpt-5.2)
#   WORKTREE         directory for the worktree (default: a fresh temp dir)
#   KEEP_WORKTREE=1  leave the worktree in place afterwards
#
# The benchmark runner at the frozen commit leaves its six constructed case
# repositories under the system temp directory and prints their path. This
# script does not remove them; that is the runner's own behaviour.

set -euo pipefail

BENCHMARK_COMMIT="c90ca80730875319b91564290f69f5d685050477"
PACKAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$PACKAGE_DIR" rev-parse --show-toplevel)"
WORKTREE="${WORKTREE:-$(mktemp -d "${TMPDIR:-/tmp}/pcc-matched-pair.XXXXXX")}"

cleanup() {
  if [ "${KEEP_WORKTREE:-0}" != "1" ]; then
    git -C "$REPO_ROOT" worktree remove --force "$WORKTREE" >/dev/null 2>&1 || true
  else
    echo "worktree kept at: $WORKTREE"
  fi
}
trap cleanup EXIT

# `cat-file -e` has no long-flag spelling.
if ! git -C "$REPO_ROOT" cat-file -e "${BENCHMARK_COMMIT}^{commit}" 2>/dev/null; then
  echo "commit $BENCHMARK_COMMIT is not in this clone; fetch feat/proof-carrying-changes first:" >&2
  echo "  git fetch origin feat/proof-carrying-changes" >&2
  exit 1
fi

echo "checking out $BENCHMARK_COMMIT into $WORKTREE"
git -C "$REPO_ROOT" worktree add --detach "$WORKTREE" "$BENCHMARK_COMMIT" >/dev/null

cd "$WORKTREE"
npm ci --no-audit --no-fund
npm run build

if [ -z "${OPENAI_API_KEY:-}" ]; then
  echo "OPENAI_API_KEY is not set: LLM-mode cells will be skipped." >&2
fi

node benchmarks/pcc/run.mjs \
  --det-runs "${DET_RUNS:-5}" \
  --llm-runs "${LLM_RUNS:-5}" \
  --model "${MODEL:-gpt-5.2}"

LATEST="$(ls -d benchmarks/pcc/results/20* | sort | tail -1)"

echo
echo "matched-pair rows from $LATEST/summary.md:"
grep --extended-regexp '^\| (fixture|case-05|case-06)' "$LATEST/summary.md"

echo
echo "records containing \"independent\": false:"
# grep exits 1 on zero matches, and zero matches is the expected result.
{ grep --files-with-matches '"independent\\": false' "$LATEST"/raw/case-05-*.json "$LATEST"/raw/case-06-*.json || true; } | wc -l

if [ "${KEEP_WORKTREE:-0}" = "1" ]; then
  echo "raw records: $WORKTREE/$LATEST/raw"
else
  echo "set KEEP_WORKTREE=1 to retain the worktree and its raw records"
fi
