# Independent validation protocol

`assumption-auditor` and the validation views are read-only observers. They receive
the original task, the minimum required artifacts, and raw evidence. They do not
receive the primary diagnosis, expected answer, proposed fix, or peer outputs.

Each result is a `Finding[]` item with traceable supporting evidence. A finding with
no directly locatable evidence is `unverified`; it may request a discriminating test,
but it cannot by itself fail an acceptance item or create a delivery block.

## Views

- `goal-spec`: goal and acceptance validity, hidden assumptions, and conflicts.
- `measurement`: evidence quality, repeatability, coverage gaps, and false passes.
- `integration-regression`: cross-module boundaries, interfaces, and regressions.
- `environment`: versions, policies, resources, and other changing external inputs.

The default route is the primary Agent's single flow: do not start an audit subagent
or assemble multi-angle packets unless the user explicitly asks or a specific verification gap justifies its cost and the host/user has authorized delegation. If an audit is authorized, choose one risk-selected
view first (measurement for an unverified/B signal, integration-regression for
cross-module/D risk, goal-spec for goal conflict, or environment for external drift).
The three-view orthogonal set remains opt-in and should not become the default until
fresh observations show a stable net benefit. At most one parallel round is run per
audit point, and a failed view is preserved as a coverage gap rather than silently
retried.

The packet assembler only creates transportable prompt packets. The host Agent
decides whether to start subagents, how to run them in parallel, and whether any
write action needs explicit authorization.

## Assumption auditor contract

The auditor returns:

```json
{
  "assumption": "...",
  "evidence_for": [],
  "evidence_against": [],
  "unverified_gap": "...",
  "cheapest_discriminating_test": "...",
  "affected_requirements": ["R1"],
  "deviation_types": ["B", "C"],
  "decision": "continue | recalibrate | reset-goal | restructure | ask-user",
  "confidence": "high | medium | low"
}
```

`confidence` is an evidence-quality label, not a probability. The auditor never
edits repository or state files and never contacts the user directly.
