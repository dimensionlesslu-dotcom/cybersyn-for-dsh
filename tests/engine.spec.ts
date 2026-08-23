import { describe, expect, it } from 'vitest'
import {
  ControlError,
  createWorkflow,
  gateReport,
  revisePrompt,
  rollbackPrompt,
  updateModel,
  updateTask,
  updateWorkspace,
  validateSeed,
} from '../src/domain/engine.ts'
import { config, l3Seed, passedEvidence } from './fixtures.ts'

function verifyChain() {
  let workflow = createWorkflow(l3Seed(), config)
  for (const id of workflow.taskOrder) {
    workflow = updateTask(workflow, {
      taskId: id,
      status: 'verified',
      evidence: passedEvidence(`e-${id}`, workflow.tasks[id]!.claims[0]!),
      deviations: [],
      expectedRevision: workflow.revision,
    })
  }
  return workflow
}

describe('control engine', () => {
  it('rejects cycles and insufficient explicit L3 decomposition', () => {
    const cyclic = l3Seed()
    cyclic.tasks[0]!.dependsOn = ['verify']
    expect(() => validateSeed(cyclic, config)).toThrowError(ControlError)

    const shallow = l3Seed()
    shallow.tasks[2]!.depth = 2
    expect(() => validateSeed(shallow, config)).toThrow(/explicit depth-3/)
  })

  it('enforces legal transitions, dependency order, current evidence, and duplicate evidence ids', () => {
    let workflow = createWorkflow(l3Seed(), config)
    expect(() => updateTask(workflow, {
      taskId: 'model', status: 'running', evidence: [], deviations: [], expectedRevision: workflow.revision,
    })).toThrow(/Illegal task transition|Dependencies/)
    expect(() => updateTask(workflow, {
      taskId: 'observe', status: 'verified', evidence: [], deviations: [], expectedRevision: workflow.revision,
    })).toThrow(/current passing evidence/)
    workflow = updateTask(workflow, {
      taskId: 'observe', status: 'verified', evidence: passedEvidence('same'), deviations: [], expectedRevision: workflow.revision,
    })
    expect(() => updateTask(workflow, {
      taskId: 'observe', status: 'verified', evidence: passedEvidence('same'), deviations: [], expectedRevision: workflow.revision,
    })).toThrow(/Duplicate evidence/)
  })

  it('requires current passing evidence for every explicit claim', () => {
    const seed = l3Seed()
    seed.tasks[0]!.claims.push('Delayed inputs observed')
    const workflow = createWorkflow(seed, config)
    expect(() => updateTask(workflow, {
      taskId: 'observe', status: 'verified', evidence: passedEvidence('only-one', 'Boundary observed'), deviations: [], expectedRevision: workflow.revision,
    })).toThrow(/current passing evidence/)
  })

  it('holds the gate for unresolved material deviations', () => {
    let workflow = createWorkflow(l3Seed(), config)
    workflow = updateTask(workflow, {
      taskId: 'observe',
      status: 'blocked',
      evidence: passedEvidence('e-observe'),
      deviations: [{ id: 'd-risk', labels: ['B', 'D'], severity: 'high', description: 'Acceptance test is incomplete', resolved: false, resolution: '' }],
      expectedRevision: workflow.revision,
    })
    expect(gateReport(workflow).passed).toBe(false)
    expect(() => updateTask(workflow, {
      taskId: 'observe', status: 'verified', evidence: [], deviations: [], expectedRevision: workflow.revision,
    })).toThrow(/Illegal task transition|blocking deviation/)
  })

  it('invalidates descendants on human prompt revision and makes rollback a new auditable revision', () => {
    let workflow = verifyChain()
    expect(gateReport(workflow).passed).toBe(true)
    const oldWorkflowRevision = workflow.revision
    workflow = revisePrompt(workflow, {
      taskId: 'observe',
      replacement: 'Observe the system boundary and delayed inputs.',
      actor: 'human-reviewer',
      reason: 'Delayed inputs were omitted.',
      expectedRevision: workflow.revision,
    })
    expect(workflow.revision).toBe(oldWorkflowRevision + 1)
    expect(gateReport(workflow).passed).toBe(false)
    expect(workflow.taskOrder.every(id => workflow.tasks[id]!.evidence.every(item => item.stale))).toBe(true)
    expect(workflow.tasks.observe!.status).toBe('ready')
    expect(workflow.tasks.model!.status).toBe('stale')

    workflow = rollbackPrompt(workflow, {
      taskId: 'observe', targetPromptRevision: 1, actor: 'human-reviewer', reason: 'Return to the accepted scope.', expectedRevision: workflow.revision,
    })
    expect(workflow.tasks.observe!.promptRevision).toBe(3)
    expect(workflow.tasks.observe!.promptHistory.at(-1)?.source).toBe('rollback')
    expect(workflow.promptAudit).toHaveLength(2)
  })

  it('rejects prompt changes that would invalidate a running task and stale writers', () => {
    let workflow = createWorkflow(l3Seed(), config)
    workflow = updateTask(workflow, {
      taskId: 'observe', status: 'running', evidence: [], deviations: [], expectedRevision: workflow.revision,
    })
    expect(() => revisePrompt(workflow, {
      taskId: 'observe', replacement: 'Changed', actor: 'human', reason: 'review', expectedRevision: workflow.revision,
    })).toThrow(/Stop running/)
    expect(() => updateTask(workflow, {
      taskId: 'observe', status: 'blocked', evidence: [], deviations: [], expectedRevision: workflow.revision - 1,
    })).toThrow(/Revision conflict/)
  })

  it('bounds J-workspace and makes L4 model competition a policy gate', () => {
    let workflow = createWorkflow(l3Seed(), config)
    for (const id of ['j1', 'j2']) {
      workflow = updateWorkspace(workflow, {
        action: 'upsert',
        item: { id, kind: 'decision', content: id, sourceTaskId: 'observe', scope: 'test workflow', priority: 3, removalCondition: 'test ends', updatedAt: 'fixture' },
        expectedRevision: workflow.revision,
      })
    }
    expect(() => updateWorkspace(workflow, {
      action: 'upsert', item: { id: 'j3', kind: 'goal', content: 'overflow', sourceTaskId: 'observe', scope: 'test workflow', priority: 3, removalCondition: 'test ends', updatedAt: 'fixture' }, expectedRevision: workflow.revision,
    })).toThrow(/capacity/)

    const seed = l3Seed('l4-workflow')
    seed.level = 'L4'
    seed.tasks.push({ id: 'challenge', title: 'Challenge', depth: 4, dependsOn: ['verify'], generatedPrompt: 'Challenge all active models.', claims: ['Models discriminated'] })
    let l4 = createWorkflow(seed, config)
    for (let index = 1; index <= 2; index += 1) {
      l4 = updateModel(l4, {
        action: 'upsert',
        model: { id: `m${index}`, name: `Model ${index}`, assumptions: [], prediction: 'p', falsifier: 'f', status: 'active', updatedAt: 'fixture' },
        expectedRevision: l4.revision,
      })
    }
    expect(gateReport(l4).checks.find(check => check.id === 'l4_model_competition')?.passed).toBe(false)
    l4 = updateModel(l4, {
      action: 'upsert', model: { id: 'm3', name: 'Model 3', assumptions: [], prediction: 'p', falsifier: 'f', status: 'active', updatedAt: 'fixture' }, expectedRevision: l4.revision,
    })
    expect(gateReport(l4).checks.find(check => check.id === 'l4_model_competition')?.passed).toBe(true)
  })
})
