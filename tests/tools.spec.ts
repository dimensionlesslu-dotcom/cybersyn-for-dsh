import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { JsonlWorkflowStore } from '../src/persistence.ts'
import { registerTools } from '../src/tools.ts'
import { config, l3Seed } from './fixtures.ts'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('model-facing tools', () => {
  it('registers seven tools, exposes audit assembly, and binds execution to the calling session', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cybersyn-tools-'))
    dirs.push(dir)
    const store = new JsonlWorkflowStore(join(dir, 'events.jsonl'))
    await store.initialize()
    const tools: ReturnType<typeof defineTool>[] = []
    registerTools(store, config, tool => tools.push(tool))
    expect(tools.map(tool => tool.name)).toEqual([
      'cybersyn_start', 'cybersyn_task_update', 'cybersyn_workspace_update', 'cybersyn_model_update',
      'cybersyn_audit_plan', 'cybersyn_audit_update', 'cybersyn_inspect',
    ])

    const start = tools[0]!
    const seed = l3Seed('tool-workflow', 'ignored-seed-session')
    const output = await start.execute({
      workflowId: seed.id,
      title: seed.title,
      domain: seed.domain,
      level: seed.level,
      objective: seed.objective,
      constraints: seed.constraints,
      tasks: seed.tasks,
    }, { agent: { session: { header: { id: 'actual-calling-session' } } } } as never)
    expect(output).toMatchObject({ workflowId: 'tool-workflow', revision: 1, gatePassed: false })
    expect(store.get('tool-workflow')?.sessionId).toBe('actual-calling-session')

    const planOutput = await tools[4]!.execute({
      workflowId: 'tool-workflow', pipelineId: 'tool-audit', trigger: 'test', taskId: 'verify', riskSignals: ['B'], goalConflict: false, requestedRoles: [],
      executionMode: 'harness-workflow', contextIndependent: true, requiredForGate: false, qualityRegressionRequired: false,
      acceptance: ['evidence current'], artifactRefs: [], evidenceRefs: [], maxFindings: 2,
      thresholds: { minimumCompletionRatio: 1, maximumFailureRatio: 0, maximumQualityDrop: 0.05 }, expectedRevision: 1,
    }, { agent: { session: { header: { id: 'actual-calling-session' } } } } as never)
    expect(planOutput).toMatchObject({ workflowId: 'tool-workflow', revision: 2 })
    const packetState = JSON.parse((planOutput as { stateJson: string }).stateJson)
    expect(packetState.assurance).toBe('T2-reported-evidence')
    expect(packetState.workflow.auditPipelines[0].packets[0].prompt).toBeTruthy()
    expect(store.get('tool-workflow')?.auditPipelines[0]?.packets[0]?.status).toBe('planned')

    await expect(tools[6]!.execute({ workflowId: 'tool-workflow' }, {} as never)).rejects.toThrow(/calling agent session/)
  })
})
