# Running `cerberus check` in GitHub Actions

`cerberus check` analyzes a pull request into a Change Contract — behavioral
claims, deterministic risk findings, claim-to-test evidence mapping, and a
policy verdict — and renders a compact report. This guide wires it into a
GitHub Actions workflow in advisory mode (always green; the verdict lives in
the report).

## Security posture

- **Use the `pull_request` trigger, not `pull_request_target`.**
  `pull_request` runs fork PRs without secrets, which is the safe default.
  `pull_request_target` exposes repository secrets (including any LLM API key
  you configure) to workflows triggered by attacker-controlled forks. If you
  must use `pull_request_target`, never check out or execute code from the
  head ref in the job that holds secrets — run `cerberus check` with `--no-llm`
  there instead.
- **Scope permissions to the minimum.** The workflow below requests
  `contents: read` only (plus job-level `pull-requests: write` when you
  include the optional sticky-comment step — GitHub Actions does not allow
  `permissions` on individual steps).
- **LLM data handling.** With an API key configured, claim generation sends
  redacted diff excerpts to the model provider (secrets matching
  high-confidence patterns are replaced with `[REDACTED]` first). To send only
  per-file stats and detector findings — no raw diff content — add
  `--llm-content minimal`. To keep everything local, use `--no-llm`.
  Data-use posture is your provider agreement's: Anthropic, OpenAI, and
  Google's standard API terms do not train on API inputs, but verify the tier
  you use.

## Workflow

```yaml
name: cerberus-check
on:
  pull_request:

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # full history so merge-base resolution works

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - run: npm ci && npm run build

      # Pass the PR description so claims reflect stated intent.
      - name: Write PR description
        env:
          PR_BODY: ${{ github.event.pull_request.body }}
        run: printf '%s' "$PR_BODY" > /tmp/pr-description.txt

      - name: Cerberus check (advisory)
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }} # optional; omit to run deterministic-only
        run: |
          node dist/cli.js check "origin/${{ github.base_ref }}...HEAD" \
            --description-file /tmp/pr-description.txt \
            --advisory | tee /tmp/cerberus-report.md
          cat /tmp/cerberus-report.md >> "$GITHUB_STEP_SUMMARY"
```

## Optional: sticky PR comment

The job summary is easy to miss on a green check. This optional step keeps the
report visible on the PR itself, updating one comment per PR instead of
stacking new ones. `permissions` is only valid at the workflow or job level,
so grant the write scope on the job:

```yaml
jobs:
  check:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write # only needed for the sticky-comment step
    steps:
      # ... steps from the workflow above ...

      - name: Post report as sticky comment
        if: github.event_name == 'pull_request'
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          gh pr comment ${{ github.event.pull_request.number }} \
            --body-file /tmp/cerberus-report.md --edit-last --create-if-none
```

## Moving to gating

The shipped default policy is advisory-first: the block rules exist but ship
disabled, so `cerberus check` never exits 1 until you opt in. After tuning on
history (`cerberus check --replay-merges 50`), enable narrow gates in a
version-controlled `pcc-policy.yaml`:

```yaml
version: 1
rules:
  block_destructive_migration_without_rollback: true
  block_permission_change_without_auth_test: true
invariants:
  - name: tenant-scoping
    description: Tenant-scoped queries include a tenant identifier
    paths: ["src/db/**"]
    requires_evidence: true
    severity: critical
```

Then drop `--advisory` from the workflow. Exit codes: 0 pass or
pass-with-warnings, 1 block, 3 needs-evidence or split-required, 2 config
error, 4 runtime error. A reviewer can record an accepted risk with
`--override "owner: rationale"`, which exits 0 while persisting who accepted
what and why.
