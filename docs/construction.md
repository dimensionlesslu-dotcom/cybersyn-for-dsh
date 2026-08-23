# Construction rationale

## Steelman

Project Cybersyn's strongest contribution is not a literal transfer function for language models. It is an operational discipline: classify complexity, decompose heterogeneous work, attach evidence to requirements, diagnose feedback before acting, expose assumptions, and retain human authority over structural changes. The plugin preserves that contribution by making the discipline observable and enforceable without replacing the pure Skill's semantic judgment.

## First principles

The controllable objects are durable events, legal state transitions, prompt revisions, evidence freshness, and explicit human decisions. Hidden model activations and private reasoning are neither observable nor controllable through the Harness API. The system therefore uses:

1. a discrete-event supervisor for task state and gates;
2. an assurance projection for claims, evidence, assumptions, and deviations;
3. a capacity-limited J-workspace projection for selected coordination facts;
4. a human control path for prompt revisions with impact analysis and rollback;
5. a pure Skill that remains useful when the plugin is absent.
6. a PromptPacket assembler and observe-only audit projection that leave child execution to DeepSeek Harness;
7. a degradation detector that separates operational coverage/failure/budget signals from externally scored effectiveness regression.

## Source status

| Design element | Status | Consequence |
| --- | --- | --- |
| Feedback, delay, observation | control-engineering principle | Observe outcomes; never claim feedback guarantees stability. |
| Event supervision | engineering method | The plugin permits or rejects state transitions instead of claiming semantic success. |
| A/B/C/D deviations | project diagnostic policy inspired by FDI and STAMP | Multi-label records are allowed; the taxonomy is not presented as a theorem. |
| L1-L4 routing | project policy | Levels are visible and versioned, not treated as universal laws. |
| Evidence gate | assurance-case pattern | Every verified task requires current evidence. |
| L4 minimum structural models | configurable project policy | The default is three; the number is not called a control-law constant. |
| J-workspace | external coordination projection inspired by J-space | It shows selected reportable facts, never hidden reasoning or chain of thought. |
| Subagent audit | host-owned execution plus plugin-owned observation | PromptPackets are assembled locally; Harness lifecycle facts are projected by run id; the plugin starts no agents. |
| Degradation status | explicit project policy with externally supplied thresholds | Open pipelines and missing baselines remain unmeasured; no causal effectiveness claim is inferred. |

## Reuse decision

The official DeepSeek Harness workflow and subagent seams are the execution authority. LangGraph, Microsoft Agent Framework, OpenAI Agents SDK, and Promptfoo were inspected for durable state, lifecycle observation, context/guardrail boundaries, and thresholded regression. Their runtimes are not bundled: no candidate supplies the required task graph, assurance gate, prompt revision impact model, J-workspace semantics, and source-Skill PromptPacket contract together, and duplicating Harness orchestration would create conflicting ownership.

## Acceptance evidence

Completion requires all of the following:

- the original Skill repository has no new tracked modifications;
- a standalone npm/DSH bundle builds and packs;
- the bundled pure Skill validates and can be installed without the plugin;
- task-graph, evidence-gate, prompt-revision, persistence, RPC, and visualization tests pass;
- a packed artifact loads against the exact tested Harness packages and its tools execute;
- at least three domain fixtures pass the same domain-independent invariants;
- the final report distinguishes demonstrated behavior from unproven real-world effectiveness.
