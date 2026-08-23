import type { EngineConfig, WorkflowSeed } from '../src/domain/types.ts'

export const config: EngineConfig = {
  workspaceCapacity: 2,
  maxPromptChars: 2_000,
  l4MinimumModels: 3,
}

export function l3Seed(id = 'test-workflow', sessionId = 'test-session'): WorkflowSeed {
  return {
    id,
    sessionId,
    title: 'Test control loop',
    domain: 'test domain',
    level: 'L3',
    objective: 'Prove control invariants',
    constraints: ['evidence required'],
    tasks: [
      { id: 'observe', title: 'Observe', depth: 1, dependsOn: [], generatedPrompt: 'Observe the system boundary.', claims: ['Boundary observed'] },
      { id: 'model', title: 'Model', depth: 2, dependsOn: ['observe'], generatedPrompt: 'Model the observed system.', claims: ['Model is explicit'] },
      { id: 'verify', title: 'Verify', depth: 3, dependsOn: ['model'], generatedPrompt: 'Verify against evidence.', claims: ['Evidence passes'] },
    ],
  }
}

export function passedEvidence(id: string, claim = 'Boundary observed') {
  return [{ id, claim, artifact: `artifact://${id}`, method: 'constructive test', status: 'passed' as const }]
}
