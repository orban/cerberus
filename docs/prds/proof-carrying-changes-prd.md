# Product Requirements Document

## Proof-Carrying Changes

**Status:** Draft v0.1  
**Owner:** Founder / Product  
**Date:** July 11, 2026  
**Working category:** Change assurance for AI-accelerated software development

---

## 1. Executive summary

AI coding tools have made code generation cheap. They have not made software changes cheap to understand, validate, review, or operate.

The result is a new engineering bottleneck: teams can generate more code than senior engineers can confidently verify. Pull requests become larger, more cross-cutting, and less causally legible. Reviewers receive plausible summaries and automated comments, but not reliable evidence that the proposed change does what it claims, preserves the invariants it touches, and can be safely rolled back.

**Proof-Carrying Changes** is a GitHub-native assurance layer that requires every material software change to arrive with a structured, executable evidence package.

For each pull request, the product produces:

- a set of explicit behavioral claims;
- the repository invariants and interfaces affected by each claim;
- evidence supporting or falsifying each claim;
- identified gaps, untested paths, and unrelated changes;
- blast-radius and rollback analysis;
- a configurable merge verdict.

The product is not another AI code reviewer. It does not optimize for more comments. It optimizes for a smaller number of changes that are easier to reason about and accompanied by evidence a reviewer can trust.

The long-term product is a repository-specific model of how the system is supposed to behave, how it has changed, and which kinds of changes historically caused regressions. The initial wedge is reducing the review burden and failure rate of AI-authored pull requests.

---

## 2. Problem

### 2.1 User problem

Engineering teams adopting coding agents are seeing a rapid increase in code output, but the human review and validation process has not scaled with it.

The practical symptoms are:

- pull requests change too many things at once;
- agent summaries describe intent but omit behavioral consequences;
- tests prove code executes, not that the claimed behavior is correct;
- reviewers must reconstruct architecture, intent, and risk from the diff;
- unrelated refactors and speculative abstractions become bundled into functional changes;
- teams cannot distinguish a genuine improvement from a change that merely moved the failure;
- senior engineers become validation bottlenecks;
- merged changes later require reverts, follow-up fixes, or incident response;
- the organization accumulates code faster than it accumulates understanding.

The core failure is not code quality in the narrow sense. It is **loss of causal comprehension**.

### 2.2 Buyer problem

The economic buyer is responsible for increasing engineering throughput without allowing reliability, security, or maintainability to degrade.

They need to answer:

- Are AI coding tools actually increasing net output, or only gross code volume?
- How much senior review capacity is being consumed?
- Which repositories, agents, teams, and change types create the most downstream rework?
- Can we allow more autonomous coding without losing control?
- What evidence must exist before an agent-authored change can merge?
- Can we prove that governance exists without slowing every team to a halt?

Existing code review products produce comments. Existing CI products run tests. Existing security scanners find known patterns. Existing agent observability products preserve traces.

None of them owns the higher-level question:

> Does this change carry enough evidence to justify the behavioral claims it makes?

---

## 3. Product thesis

A software change should be treated as a bundle of falsifiable claims, not merely a diff.

Every material change should state:

1. **What behavior changes?**
2. **What behavior must remain unchanged?**
3. **What evidence supports both statements?**
4. **What was not verified?**
5. **What is the blast radius?**
6. **How can the change be reversed?**

The product becomes valuable when it moves verification earlier in the loop:

- from post-merge cleanup to pre-merge assurance;
- from generic review comments to claim-specific evidence;
- from repository-agnostic heuristics to repository-specific invariants;
- from human reconstruction of intent to machine-assisted proof packaging;
- from large opaque changes to smaller independently verifiable changes.

---

## 4. Goals

### 4.1 Primary goals

1. Reduce senior reviewer time per merged pull request.
2. Detect unsupported behavioral claims before merge.
3. Force large, multi-purpose changes to become smaller and more independently verifiable.
4. Create a repository-specific record of intended behavior, evidence, and outcomes.
5. Enable teams to safely increase the autonomy of coding agents.

### 4.2 Secondary goals

1. Quantify which agents, prompts, repositories, and change types produce reliable work.
2. Identify recurring missing tests and weak invariants.
3. Improve the quality of task specifications given to coding agents.
4. Provide audit evidence for organizations adopting agent-generated code.
5. Create the foundation for constraining agents during generation rather than only evaluating completed work.

### 4.3 Non-goals

The initial product will not:

- replace human code review;
- prove full program correctness;
- detect whether a human or AI wrote a line of code;
- compete with general-purpose linters, SAST tools, or dependency scanners;
- generate broad stylistic review comments;
- serve every programming language and architecture;
- automatically merge high-risk changes;
- become a general engineering analytics dashboard;
- infer business intent from nothing.

---

## 5. Target customer

### 5.1 Initial customer profile

A software company with:

- 20–200 engineers;
- GitHub as the source-control platform;
- meaningful use of Claude Code, Codex, Cursor, Copilot, or internal coding agents;
- cloud-hosted services written primarily in Python or TypeScript;
- existing CI and automated tests;
- senior engineers experiencing increasing review load;
- a CTO, VP Engineering, or Head of AI Platform actively worried about AI-generated code quality.

The best initial customers are not teams experimenting casually with AI coding. They are teams that have already crossed the point where agent output creates a review and assurance bottleneck.

### 5.2 Primary personas

#### Senior engineer / reviewer

Needs to understand whether a change is safe without manually reconstructing every implication from the diff.

Success means:

- fewer minutes spent reviewing;
- fewer irrelevant comments;
- clearer identification of the truly risky parts;
- less time requesting missing tests and PR splits;
- confidence that merge gates correspond to actual risk.

#### VP Engineering / CTO

Needs to increase throughput while controlling regressions, incidents, and review burden.

Success means:

- measurable net productivity gains;
- fewer escaped defects and emergency reverts;
- evidence that AI adoption is governed;
- visibility into where agent-generated code is reliable or unreliable.

#### AI platform / developer productivity lead

Needs a reusable policy layer across coding agents and repositories.

Success means:

- common assurance rules across tools;
- repository-specific policies;
- integration with existing CI;
- data for selecting agents, prompts, and workflows.

### 5.3 Secondary persona

#### Coding agent

Receives machine-readable requirements for what evidence it must produce before a change will be accepted.

Success means:

- fewer rejected PRs;
- clearer task boundaries;
- smaller changes;
- faster iteration toward an acceptable patch.

---

## 6. Core user workflow

### 6.1 Installation

1. Customer installs the GitHub App.
2. Customer selects repositories.
3. Product indexes repository structure, tests, service boundaries, schemas, API surfaces, ownership, and historical changes.
4. Customer chooses a default assurance policy.
5. Customer optionally connects CI and an agent-session provider.

### 6.2 Pull request analysis

When a pull request is opened or updated:

1. The product reads the task description, diff, affected dependency graph, test changes, CI output, and available agent trace.
2. It generates a **Change Contract** containing explicit claims.
3. It classifies each claim by risk and affected system boundary.
4. It maps existing evidence to each claim.
5. It identifies unsupported claims, missing evidence, untested paths, unrelated changes, and rollback gaps.
6. It publishes a GitHub Check and a compact reviewer view.
7. The policy engine returns one of:
   - pass;
   - pass with warnings;
   - needs evidence;
   - split required;
   - block.

### 6.3 Author remediation

The author or coding agent can:

- accept or edit the proposed claims;
- add evidence;
- add or update tests;
- narrow the change;
- split unrelated work;
- document an accepted risk;
- request a human override.

The product re-runs only the affected analyses after each update.

### 6.4 Post-merge learning

After merge, the product records:

- reverts;
- hotfixes;
- linked incidents;
- failed deployments;
- follow-up pull requests;
- reviewer overrides;
- claim/evidence patterns associated with later failure.

This outcome data updates repository-specific risk and evidence models.

---

## 7. Core product objects

### 7.1 Change Contract

The authoritative structured description of what the pull request claims to do.

Fields:

- task or issue reference;
- author and tool provenance when available;
- intended behavior changes;
- preserved invariants;
- affected interfaces;
- data and schema changes;
- permission or security changes;
- performance expectations;
- operational and rollout requirements;
- rollback plan;
- known exclusions;
- unrelated changes detected.

### 7.2 Claim

A falsifiable statement about the proposed change.

Examples:

- “Unauthenticated requests to `/admin/*` continue to return HTTP 401.”
- “The new retry behavior does not create duplicate payment records.”
- “Existing API clients can continue using schema version 2.”
- “P95 request latency does not increase by more than 10% under the standard load profile.”
- “The migration can be rolled back without losing writes created after deployment.”

Fields:

- claim text;
- claim type;
- affected components;
- severity if false;
- evidence requirements;
- supporting evidence;
- confidence;
- status;
- reviewer disposition.

### 7.3 Evidence artifact

An executable or inspectable artifact supporting a claim.

Supported evidence types in the MVP:

- unit test;
- integration test;
- end-to-end test;
- property-based test;
- static analysis result;
- schema compatibility check;
- benchmark result;
- CI run;
- deployment or feature-flag plan;
- rollback command or migration reversal;
- code path trace;
- human attestation.

### 7.4 Invariant

A repository-specific statement that should remain true across changes.

Examples:

- every tenant-scoped query must include a tenant identifier;
- payment handlers must be idempotent;
- public API schemas are backward-compatible within a major version;
- writes to a specific table must emit an audit event;
- privileged actions require both role and resource-scope checks.

Invariants may be:

- inferred from tests and history;
- authored manually;
- imported from policy-as-code;
- promoted from repeated reviewer feedback.

### 7.5 Outcome

A post-merge signal used to evaluate whether the assurance process was correct.

Examples:

- clean deployment;
- revert;
- incident;
- hotfix;
- flaky test introduced;
- manual rollback;
- security finding;
- no follow-up work within a defined period.

---

## 8. Functional requirements

### 8.1 Repository indexing

The product must:

- build a code and dependency graph;
- identify test files and test-to-code relationships;
- identify service, package, and ownership boundaries;
- detect API, database schema, permission, dependency, and infrastructure changes;
- index historical PRs, reverts, and linked issues;
- update incrementally after each merge.

### 8.2 Claim generation

The product must:

- generate claims from issue text, PR description, diff, tests, and agent trace;
- distinguish intended changes from preserved invariants;
- prefer precise, falsifiable language;
- allow author and reviewer edits;
- preserve claim history across PR updates;
- explicitly mark uncertainty rather than fabricating intent.

### 8.3 Evidence mapping

The product must:

- map tests and CI artifacts to specific claims;
- distinguish evidence that directly exercises a claim from weak proxy evidence;
- identify claims with no evidence;
- detect tests that changed their own expected behavior without independent support;
- show why each evidence artifact is considered relevant;
- never treat an LLM assertion as sufficient evidence by itself.

### 8.4 Minimality analysis

The product must:

- cluster changed files by behavioral concern;
- identify unrelated refactors or abstractions bundled with the primary task;
- detect broad changes whose subparts can be independently merged;
- recommend a split when multiple independent claims have weak coupling;
- allow teams to configure size and coupling thresholds.

### 8.5 Risk and blast-radius analysis

The product must identify:

- affected services and downstream dependencies;
- public API changes;
- data migration risk;
- permission and authentication changes;
- concurrency and retry changes;
- dependency upgrades;
- infrastructure and deployment changes;
- test deletions or weakened assertions;
- high-churn or historically failure-prone modules.

### 8.6 Merge policy

The policy engine must support rules such as:

- block any critical claim without direct evidence;
- block permission changes without authorization tests;
- block irreversible migrations without a reviewed rollout plan;
- require split when unrelated concern count exceeds a threshold;
- require human review for high-blast-radius changes;
- permit low-risk, fully evidenced changes to pass automatically;
- allow overrides with a named owner and written rationale.

Policies must be:

- version-controlled;
- repository-specific;
- inspectable;
- explainable;
- testable against historical PRs.

### 8.7 GitHub experience

The GitHub Check must show, in order:

1. verdict;
2. highest-risk unsupported claims;
3. behavioral claims and evidence status;
4. affected invariants;
5. unrelated-change or split recommendation;
6. rollback status;
7. detailed evidence links.

The product must avoid flooding the PR with line comments. Inline comments are reserved for evidence-critical locations.

### 8.8 Agent integration

The MVP should accept agent-session metadata when available, including:

- original task;
- prompts and tool calls;
- files inspected;
- tests run;
- intermediate plans;
- errors and retries.

The product must continue to work without agent provenance. It should evaluate the change, not attempt to determine authorship.

A later integration will expose the Change Contract and missing-evidence requirements to the coding agent before PR creation.

---

## 9. Decision logic

### 9.1 Verdict model

A pull request receives one overall verdict.

#### Pass

All material claims have sufficient evidence, no blocking policy is violated, and the change is acceptably scoped.

#### Pass with warnings

The change may merge, but low-severity claims or operational details remain weakly evidenced.

#### Needs evidence

At least one material claim lacks adequate evidence.

#### Split required

The change contains multiple weakly coupled concerns that cannot be reviewed or validated as one unit.

#### Block

A critical policy is violated, a high-severity claim is contradicted, or the change creates an unacceptable irreversible risk.

### 9.2 Evidence sufficiency

Evidence sufficiency is determined by:

- directness: does the artifact test the stated claim?
- independence: did the change merely alter both implementation and expected output together?
- coverage: which relevant paths remain untested?
- repeatability: can the evidence be rerun?
- environment fidelity: does the evidence correspond to production behavior?
- historical reliability: has this evidence type predicted outcomes in this repository?

The LLM may propose the mapping. Deterministic tools and user-visible reasoning must support the final result.

---

## 10. MVP scope

### 10.1 Supported environment

- GitHub Cloud;
- Python and TypeScript;
- monoliths and service-oriented repositories with conventional build systems;
- GitHub Actions as the initial CI provider;
- pytest, Jest, Vitest, and Playwright;
- PostgreSQL schema migrations;
- REST and GraphQL API surface detection;
- optional Claude Code, Codex, or Cursor session import where accessible.

### 10.2 MVP features

1. GitHub App installation.
2. Incremental repository indexing.
3. Change Contract generation.
4. Claim-to-test evidence mapping.
5. unsupported-claim detection.
6. schema, API, permission, and migration risk detection.
7. unrelated-change and PR-split recommendation.
8. configurable merge policy.
9. compact GitHub Check.
10. reviewer override with rationale.
11. post-merge revert and follow-up tracking.
12. basic team dashboard for review time, block reasons, and post-merge outcomes.

### 10.3 Explicitly deferred

- autonomous repair;
- automated PR splitting;
- full local IDE experience;
- broad language support;
- self-hosted enterprise deployment;
- production trace ingestion;
- natural-language policy authoring;
- automated release sequencing;
- formal verification;
- automatic merge.

---

## 11. Product principles

### 11.1 Evidence over explanation

A polished summary is not proof. The product must privilege executable, inspectable artifacts over persuasive language.

### 11.2 Claims before comments

The unit of review is the behavioral claim, not the changed line.

### 11.3 Repository-specific over generic

Generic models can propose hypotheses. Repository history, architecture, invariants, and outcomes determine what is trustworthy.

### 11.4 Smaller changes are a product outcome

The system should actively make changes easier to reason about, not merely summarize complexity after it has been created.

### 11.5 Explicit uncertainty

The product must say “intent unknown” or “evidence insufficient” rather than manufacture confidence.

### 11.6 Human override is first-class

A reviewer can accept risk, but the decision, owner, and rationale become part of the record.

### 11.7 No proof theater

The system must not reward adding low-value tests or verbose artifacts that create the appearance of rigor without constraining behavior.

---

## 12. Success metrics

### 12.1 North-star metric

**Senior reviewer minutes per successfully merged change**, adjusted for post-merge rework.

A successful change is one that does not require a revert, linked incident, or corrective follow-up within the selected observation period.

### 12.2 Primary metrics

- median reviewer time per PR;
- percent of PRs merged without requested changes;
- escaped-defect rate;
- revert and hotfix rate;
- percent of material claims with direct evidence;
- reviewer override rate;
- false-block rate;
- percentage of PRs split after product recommendation;
- time from PR open to merge;
- post-merge corrective PRs per merged PR.

### 12.3 Guardrail metrics

- developer time added before PR creation;
- analysis latency;
- CI cost increase;
- false-positive rate by policy;
- percentage of generated claims edited by humans;
- reviewer trust score;
- rate of product bypass or disabled checks.

### 12.4 Pilot targets

These are product targets, not validated market facts.

For a design-partner pilot of at least 100 analyzed PRs:

- 25% reduction in median senior-reviewer time;
- no increase in escaped defects;
- fewer than 10% of PRs incorrectly blocked;
- at least 70% of reviewers report that the claim view is more useful than the raw AI summary;
- at least three material issues identified that existing CI and review automation did not surface;
- at least 80% of blocking verdicts judged understandable and actionable.

---

## 13. Business model

### 13.1 Initial pricing hypothesis

Price by active engineering seat with a platform minimum.

Illustrative structure:

- team: $40–$75 per active developer per month;
- business: $100–$175 per active developer per month;
- enterprise: annual contract with self-hosted runners, custom policies, SSO, audit retention, and support.

The economic case should be based on:

- senior review hours saved;
- fewer reverts and incidents;
- safer expansion of coding-agent usage;
- reduced need for manual governance processes.

### 13.2 Initial sales motion

Founder-led design partnerships with engineering leaders already experiencing AI-code review bottlenecks.

The first sale should not promise general AI governance. It should promise:

> Reduce the time senior engineers spend validating agent-authored changes without increasing post-merge failures.

### 13.3 Expansion path

1. PR assurance.
2. Agent-specific reliability scoring.
3. Pre-PR evidence requirements.
4. Generation-time constraints and task decomposition.
5. Production-trace validation.
6. Repository-level invariant management.
7. Autonomous merge for narrowly defined low-risk changes.

---

## 14. Competitive positioning

### 14.1 Alternatives

Customers may currently use:

- human review;
- GitHub branch protection;
- CI test suites;
- CodeRabbit and similar AI reviewers;
- Sonar, Snyk, Semgrep, and other static or security tools;
- agent-session and provenance tools;
- custom checklists;
- post-hoc cleanup and consulting.

### 14.2 Positioning statement

For engineering teams whose coding agents produce more changes than senior reviewers can confidently validate, Proof-Carrying Changes is a change-assurance layer that converts every pull request into explicit behavioral claims backed by executable evidence.

Unlike AI code reviewers, it does not optimize for comments. Unlike CI, it does not merely report whether tests passed. Unlike agent observability, it does not stop at preserving the trace.

It determines whether the change has earned the right to merge.

### 14.3 Defensibility

The durable asset is not the GitHub interface or a generic review model.

Defensibility comes from:

- repository-specific invariants;
- claim-to-evidence mappings;
- historical change and outcome data;
- organization-specific merge policy;
- feedback from reviewer overrides;
- failure patterns associated with agents, prompts, modules, and change types;
- integration into the generation loop.

---

## 15. Technical architecture

### 15.1 Components

#### GitHub App

- receives pull request and check events;
- reads repository metadata and authorized contents;
- publishes checks and links to the product UI.

#### Repository indexer

- parses code, tests, schemas, dependencies, and ownership;
- builds an incremental dependency and interface graph;
- stores embeddings only as a secondary retrieval mechanism, not as the source of truth.

#### Analysis orchestrator

- decomposes the PR into analysis tasks;
- invokes language-specific analyzers;
- gathers CI and test artifacts;
- runs claim generation and evidence mapping;
- applies policy.

#### Policy engine

- evaluates version-controlled rules;
- produces deterministic reasons for pass, warn, or block;
- supports dry-run evaluation against historical PRs.

#### Evidence store

- stores metadata, hashes, results, and links to artifacts;
- avoids retaining source code by default;
- supports customer-controlled retention.

#### Outcome tracker

- observes merge, revert, incident, deployment, and follow-up signals;
- updates repository-specific risk models.

### 15.2 Use of language models

Language models may:

- propose claims;
- classify affected behavior;
- summarize architecture;
- suggest missing evidence;
- explain verdicts.

Language models may not be the sole basis for:

- a passing verdict;
- a security guarantee;
- a schema compatibility guarantee;
- a migration rollback guarantee;
- a claim that tests executed successfully.

### 15.3 Security requirements

The MVP must:

- request least-privilege GitHub permissions;
- encrypt data in transit and at rest;
- avoid training shared models on customer code;
- support ephemeral source checkout;
- store hashes and metadata where possible instead of full source;
- provide audit logs for analysis, policy, and overrides;
- support customer-hosted CI execution.

Enterprise roadmap:

- SSO and SCIM;
- private networking;
- self-hosted control plane or data plane;
- customer-managed encryption keys;
- configurable retention;
- SOC 2 Type II.

---

## 16. Risks and mitigations

### 16.1 Risk: false confidence

The product could generate authoritative-looking claims and evidence that do not actually prove behavior.

Mitigation:

- show evidence provenance;
- distinguish direct from proxy evidence;
- require deterministic execution results;
- expose uncertainty;
- measure post-merge outcomes;
- never present an LLM statement as proof.

### 16.2 Risk: excessive friction

Developers may disable the tool if it blocks too many changes or creates busywork.

Mitigation:

- begin in advisory mode;
- tune policies on historical PRs;
- block only high-confidence, high-severity cases;
- provide precise remediation;
- measure false blocks;
- keep the reviewer view compact.

### 16.3 Risk: incumbent absorption

GitHub, GitLab, Cursor, Anthropic, or an AI review vendor may add similar features.

Mitigation:

- build a vendor-neutral assurance layer;
- own repository-specific invariants and outcome data;
- integrate across agents;
- move upstream into generation-time constraints;
- focus on evidence semantics rather than generic review.

### 16.4 Risk: weak willingness to pay

Teams may complain about review burden but continue absorbing it with senior engineers.

Mitigation:

- target teams already limiting agent deployment because of validation cost;
- quantify reviewer hours and rework before the pilot;
- price against measurable labor and failure cost;
- require executive sponsorship.

### 16.5 Risk: proof theater

Teams or agents may learn to satisfy checks with low-value tests.

Mitigation:

- detect implementation-and-expectation co-modification;
- score evidence independence;
- track which evidence predicts clean outcomes;
- penalize redundant or non-discriminating tests;
- use mutation testing selectively in later versions.

### 16.6 Risk: repository understanding is too expensive

Building a useful system model may require too much setup or compute.

Mitigation:

- begin with narrow stacks;
- index incrementally;
- rely on existing tests, dependency graphs, and CI;
- ask users to declare only critical invariants;
- prove value before attempting complete architectural understanding.

---

## 17. Rollout plan

### Phase 0: Historical replay

Before live use:

- ingest 50–200 historical PRs from a design partner;
- hide future outcomes from the analysis;
- test whether the product would have identified reverted, incident-linked, or heavily revised changes;
- measure false-positive rate;
- tune repository policy.

Exit criteria:

- product identifies meaningful risk in historical failures;
- reviewer can understand the verdict;
- false-block rate is acceptable for advisory deployment.

### Phase 1: Advisory mode

- analyze all selected PRs;
- publish non-blocking checks;
- collect reviewer edits to claims and evidence mappings;
- measure reviewer time and usefulness.

Exit criteria:

- repeated reviewer use;
- stable claim quality;
- actionable recommendations;
- no material workflow disruption.

### Phase 2: Selective gating

- block only narrow high-confidence categories:
  - destructive migrations without rollback;
  - permission changes without tests;
  - critical claims with no evidence;
  - deleted or weakened safety assertions;
  - clearly unrelated bundled changes.

Exit criteria:

- low false-block rate;
- executive and reviewer trust;
- measurable reduction in review or rework.

### Phase 3: Agent feedback loop

- expose missing claims and evidence requirements to coding agents;
- require Change Contract completion before PR creation;
- suggest smaller task decomposition;
- allow verified low-risk changes to move through a faster path.

---

## 18. MVP acceptance criteria

The MVP is complete when:

1. A customer can install the GitHub App without founder intervention.
2. The system analyzes a Python or TypeScript PR within ten minutes of an update.
3. It produces editable behavioral claims tied to changed components.
4. It maps tests and CI results to individual claims.
5. It identifies at least four critical risk categories:
   - permissions;
   - schema or migration;
   - public API compatibility;
   - unrelated bundled changes.
6. It returns an explainable verdict through a GitHub Check.
7. A reviewer can override the verdict with a recorded rationale.
8. The system tracks merge, revert, and follow-up outcomes.
9. An engineering leader can view reviewer time, block reasons, overrides, and outcomes.
10. At least three design partners use the product on live pull requests.
11. At least one design partner chooses to enable a blocking policy.
12. The pilot targets in Section 12.4 are measured, even if they are not all achieved.

---

## 19. Validation plan

The first validation question is not “Do teams like the concept?”

It is:

> Are senior engineers spending enough time and credibility validating agent-authored changes that they will install a merge gate to reduce that burden?

### 19.1 Customer interviews

Interview:

- 10 CTOs or VPs Engineering;
- 10 staff or principal engineers;
- 5 developer-productivity or AI-platform leads.

Require concrete answers:

- PR volume before and after agent adoption;
- review time by seniority;
- number of reverts, hotfixes, and corrective PRs;
- categories of changes reviewers distrust;
- current merge policies;
- examples of recent agent-authored failures;
- whether agent adoption is constrained by review capacity;
- budget owner;
- procurement threshold;
- willingness to provide historical PR data.

### 19.2 Design-partner qualification

A qualified design partner must:

- use coding agents in production development;
- provide at least 50 historical PRs;
- identify a senior reviewer willing to give weekly feedback;
- provide outcome labels for reverts or incidents;
- run the product on live PRs;
- agree to measure reviewer time;
- have an executive sponsor.

### 19.3 Kill criteria

Do not continue if, after ten qualified interviews:

- review burden is mostly annoyance rather than a budgeted constraint;
- teams will not permit repository access or local analysis;
- existing CI catches nearly all meaningful failures;
- buyers prefer to hire reviewers rather than adopt gating;
- no one will enable even narrow blocking policies;
- historical replay cannot distinguish failed from clean changes better than existing tools;
- value depends primarily on generic LLM comments.

---

## 20. Open questions

1. Should the first interface begin at PR time, or as a wrapper around the coding agent before code is generated?
2. Which claim categories produce enough immediate value to justify installation?
3. Can test-to-claim mapping be made reliable enough without production traces?
4. Does the product require explicit task specifications, or can it recover intent from issues and traces?
5. How much repository-specific configuration is acceptable?
6. Should policies be expressed as YAML, code, or a higher-level DSL?
7. Which existing provenance integrations are technically and commercially available?
8. Can the product estimate reviewer time automatically?
9. How should it distinguish a legitimate cross-cutting change from an incoherent bundled change?
10. What evidence types predict clean outcomes strongly enough to support future autonomous merge?
11. Is “proof-carrying changes” understandable to buyers, or should the category be framed as agent code assurance?
12. Is the first strong wedge permission, migration, and API changes rather than general PR analysis?

---

## 21. Product narrative

Software development is moving from a world where code was expensive to produce to one where changes are cheap to propose.

That shifts the bottleneck.

The scarce resource is no longer typing. It is justified belief that a change is correct.

The winning engineering organizations will not be the ones whose agents write the most code. They will be the ones that can increase change velocity without losing the ability to understand, validate, and control what their systems are becoming.

Proof-Carrying Changes gives every proposed change a burden of proof.
