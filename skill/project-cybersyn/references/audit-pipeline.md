# Subagent audit pipeline

## Boundary

`cybersyn_audit_plan` assembles transportable PromptPackets and starts zero agents. The host owns dispatch, concurrency, cancellation, cleanup, and the truth of every run id. `cybersyn_audit_update` records host facts; it is not permission to create them.

Every auditor is read-only. Exclude `expected_answer`, `primary_diagnosis`, `proposed_fix`, and `peer_outputs`. Give the auditor the task, current prompt revision, acceptance, constraints, artifact/evidence references, role-specific failure criteria, and a bounded `Finding[]` schema.

## Role routing and budget

- measurement for B or unverified evidence;
- integration-regression for D or cross-module risk;
- goal-spec for an explicit disputed goal/acceptance boundary;
- environment for C or environment drift.

A execution deviations route to measurement by default because the independent question is whether the claimed outcome was observed. Set the separate goal-conflict signal or explicitly request `goal-spec` when the target itself is disputed.

Budgets are L1 zero, L2 one, L3 two, and L4 three audit roles. Explicit requests above the budget fail rather than silently dropping a view.

## Lifecycle

`planned` means assembled only. Project real host facts through `dispatched`, `running`, and one terminal state: `completed`, `failed`, or `cancelled`. Keep one stable Harness run id per attempt. A failed or cancelled packet may be retried once; do not silently retry or overwrite its lifecycle evidence.

When a task prompt revision changes, every packet targeting the previous revision is stale and must not support the gate.

## Degradation discipline

Operational checks cover context independence, prompt freshness, completed-role coverage, failure ratio, evidence grounding, and configured token/duration budgets. Quality regression is separate: compare externally supplied terminal scores with an explicit external baseline and maximum allowed drop.

- `unmeasured` means required observations are absent or the pipeline is still open;
- `healthy` means configured operational checks passed;
- `degraded` means at least one configured operational check failed;
- effectiveness remains `unmeasured` without a baseline;
- more findings are not automatically better and zero findings are not automatically failure.

Only a pipeline explicitly marked required belongs in the delivery gate. If effectiveness is required, absence of a baseline or terminal scores holds the gate.

## Fallbacks

- no host subagent: run selected views serially, label `contextIndependent: false`, and disclose the limitation;
- one child fails: retain the other results, show a coverage gap, and allow at most one explicit retry;
- insufficient budget: prefer measurement for evidence risk and narrow the audit rather than hiding omitted roles;
- no stable net benefit in evaluation: default back to one auditor or no audit.
