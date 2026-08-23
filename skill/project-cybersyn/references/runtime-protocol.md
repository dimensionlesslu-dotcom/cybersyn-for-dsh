# Runtime protocol

## Task states

`proposed` waits for dependencies. `ready` is legal to execute. `running` is active. `blocked` needs a decision or repaired precondition. `verified` has current passed evidence. `stale` means an upstream prompt or result changed and earlier verification cannot be reused.

## Prompt layers

The generated prompt is the machine proposal. The human patch is the explicit human-controlled addition or correction. The effective prompt is their rendered combination. Editing never mutates a running prompt: the runtime rejects an edit when the target or an affected descendant is running.

Each accepted edit creates a prompt revision. Evidence on the edited task and all descendants becomes stale. Rollback creates another revision rather than deleting history.

## Assurance gate

The runtime gate is structural. It proves only that configured invariants hold: legal dependencies, current evidence, resolved blocking deviations, L4 model count, and any explicitly required audit health/effectiveness thresholds. An open or unmeasured required audit holds the gate. The gate does not prove that evidence is truthful or that the real-world objective is valuable. The Skill and human reviewer remain responsible for those semantic judgments.

## J-workspace boundary

The runtime J-workspace is an external, limited-capacity broadcast board inspired by selective global-workspace findings. It is not access to the model's internal J-space, consciousness, hidden activations, or private reasoning.
