---
name: project-cybersyn
description: Evidence-first hierarchical task control for heterogeneous, iterative, or open-ended work. Use it to decompose L3/L4 work, diagnose A/B/C/D deviations, maintain requirement evidence, expose assumptions, and keep human authority over structural changes. It works with or without the Project Cybersyn Harness plugin.
---

# Project Cybersyn

Use a closed loop only as strong as the task requires. The symbols and control-language in this Skill are qualitative engineering analogies unless a measurable system model is actually available.

## Host and authority

Host rules, permissions, and the user's latest instruction always win. Never treat this Skill as authority to run tools, change files, contact people, install software, or create subagents. Human edits to task prompts change the controller and require explicit impact review.

## Complexity routing

- L1: one clear local task. Plan briefly, act, run the relevant check, and compare with the request.
- L2: many homogeneous items. Use one repeatable procedure and batch verification.
- L3: heterogeneous modules or hidden assumptions. Show the task graph and decompose it into independently verifiable L1/L2 leaves.
- L4: objectives, environment, or structure remain contested. Keep multiple structural models, expose disagreements, and ask the human to decide value- or authority-sensitive changes.

Do not promote a task merely to display process. For L3/L4, state the active assumptions and the evidence that would falsify them.

## Runtime plugin

When `cybersyn_*` tools are available:

1. call `cybersyn_start` once the objective, levels, dependencies, prompts, and claims are explicit;
2. use `cybersyn_task_update` to record real observations, evidence, deviations, and legal status transitions;
3. use `cybersyn_workspace_update` to maintain only the small set of coordination facts needed now;
4. use `cybersyn_model_update` for L4 structural hypotheses;
5. when an independent audit is justified, use `cybersyn_audit_plan` to assemble PromptPackets, then let the host run them through its own subagent/workflow capability;
6. project paired host lifecycle facts with `cybersyn_audit_update`; do not invent run ids, metrics, findings, or completion;
7. call `cybersyn_inspect` before claiming convergence.

The visual workspace is a projection of plugin state. It is not model chain of thought. A human prompt edit creates a new revision, invalidates affected evidence, and may require tasks to be re-run.

When the tools are absent, use the same fields in a concise text ledger. Do not fail merely because the plugin is missing.

The audit assembler never starts a subagent. When the host lacks subagents, serially inspect the selected views and label the result `contextIndependent: false`; this is a fallback with a known coverage limitation, not an independent audit. Treat an open pipeline as `unmeasured`, not healthy. A quality-regression claim requires an external baseline and explicit threshold.

## Evidence loop

For each requirement or claim, record one of `passed | failed | unverified | blocked` and cite a test, inspection, source, or human confirmation. `unverified` never means passed.

Classify deviations without forcing a single label:

- A execution: the intended action did not reach the required result;
- B measurement: the observation or test is unreliable;
- C environment: a dependency, objective, or assumption changed;
- D interaction: individually acceptable parts fail when combined.

Respond by mechanism: A may justify a local correction; B freezes correction until measurement is calibrated; C resets the relevant target or assumption; D returns to interfaces and structural models.

## J-workspace

Keep a deliberately limited set of reportable coordination items:

- the active objective;
- binding constraints;
- the highest-risk unresolved deviation;
- the current structural hypothesis;
- recent human decisions;
- evidence that is about to become stale.

Every item needs a source, scope, priority, and removal decision. Do not use the workspace as a transcript or memory dump.

## L3/L4 handoff gate

Before delivery:

1. every task required by the objective is verified with current evidence;
2. dependencies are verified before dependents;
3. no stale evidence supports a current claim;
4. no unresolved high/medium deviation remains;
5. assumptions and environment are still compatible;
6. L4 has enough genuinely different structural models to expose material disagreement;
7. human decisions are recorded where authority or values, not evidence alone, determine the answer.

Read [references/runtime-protocol.md](references/runtime-protocol.md) when interpreting plugin states or prompt revisions. Read [references/audit-pipeline.md](references/audit-pipeline.md) before assembling, running, or judging a subagent audit.
