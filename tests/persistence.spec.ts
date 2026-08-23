import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { JsonlWorkflowStore } from '../src/persistence.ts'
import { config, l3Seed } from './fixtures.ts'

const dirs: string[] = []

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cybersyn-store-'))
  dirs.push(dir)
  return join(dir, 'events.jsonl')
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('JSONL workflow store', () => {
  it('initializes an empty store and replays durable state', async () => {
    const file = await tempFile()
    const first = new JsonlWorkflowStore(file)
    await first.initialize()
    const created = await first.create(l3Seed(), config)
    expect(created.revision).toBe(1)
    await first.updateTask(created.id, { taskId: 'observe', status: 'running', evidence: [], deviations: [], expectedRevision: 1 })

    const replayed = new JsonlWorkflowStore(file)
    await replayed.initialize()
    expect(replayed.get(created.id)?.tasks[0]?.status).toBe('running')
    expect(replayed.get(created.id)?.revision).toBe(2)
  })

  it('repairs only an incomplete final tail and remains appendable', async () => {
    const file = await tempFile()
    const first = new JsonlWorkflowStore(file)
    await first.initialize()
    await first.create(l3Seed(), config)
    await appendFile(file, '{"seq":2', 'utf8')

    const recovered = new JsonlWorkflowStore(file)
    await recovered.initialize()
    await recovered.updateTask('test-workflow', { taskId: 'observe', status: 'running', evidence: [], deviations: [], expectedRevision: 1 })
    const lines = (await readFile(file, 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(2)

    const replayed = new JsonlWorkflowStore(file)
    await replayed.initialize()
    expect(replayed.get('test-workflow')?.revision).toBe(2)
  })

  it('fails loudly on malformed interior records', async () => {
    const file = await tempFile()
    const first = new JsonlWorkflowStore(file)
    await first.initialize()
    await first.create(l3Seed(), config)
    await appendFile(file, 'not-json\n', 'utf8')
    const corrupt = new JsonlWorkflowStore(file)
    await expect(corrupt.initialize()).rejects.toMatchObject({ code: 'CORRUPT_LOG' })
  })

  it('does not erase a malformed non-JSON final record merely because it lacks a newline', async () => {
    const file = await tempFile()
    const first = new JsonlWorkflowStore(file)
    await first.initialize()
    await first.create(l3Seed(), config)
    await appendFile(file, 'not-json', 'utf8')
    const corrupt = new JsonlWorkflowStore(file)
    await expect(corrupt.initialize()).rejects.toMatchObject({ code: 'CORRUPT_LOG' })
  })

  it('serializes concurrent writes so only one stale expected revision wins', async () => {
    const file = await tempFile()
    const store = new JsonlWorkflowStore(file)
    await store.initialize()
    await store.create(l3Seed(), config)
    const outcomes = await Promise.allSettled([
      store.updateTask('test-workflow', { taskId: 'observe', status: 'running', evidence: [], deviations: [], expectedRevision: 1 }),
      store.updateTask('test-workflow', { taskId: 'observe', status: 'blocked', evidence: [], deviations: [], expectedRevision: 1 }),
    ])
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(1)
    expect(store.get('test-workflow')?.revision).toBe(2)
  })

  it('replays subagent audit plans and paired Harness lifecycle facts', async () => {
    const file = await tempFile()
    const store = new JsonlWorkflowStore(file)
    await store.initialize()
    const created = await store.create(l3Seed(), config)
    const planned = await store.planAudit(created.id, {
      pipelineId: 'audit-replay', trigger: 'persistence proof', taskId: 'verify', riskSignals: ['B'], goalConflict: false, requestedRoles: ['measurement'],
      executionMode: 'harness-subagent', contextIndependent: true, requiredForGate: false, qualityRegressionRequired: false,
      acceptance: ['evidence is current'], artifactRefs: ['artifact://a'], evidenceRefs: ['evidence://e'], maxFindings: 2,
      thresholds: { minimumCompletionRatio: 1, maximumFailureRatio: 0, maximumQualityDrop: 0.05 }, expectedRevision: created.revision,
    })
    const packet = planned.auditPipelines[0]!.packets[0]!
    await store.updateAuditPacket(created.id, {
      pipelineId: 'audit-replay', packetId: packet.id, status: 'completed', harnessRunId: 'harness-42', findings: [],
      error: '', detail: 'paired end', expectedRevision: planned.revision,
    })

    const replayed = new JsonlWorkflowStore(file)
    await replayed.initialize()
    expect(replayed.get(created.id)?.auditPipelines[0]?.packets[0]).toMatchObject({ status: 'completed', harnessRunId: 'harness-42' })
  })
})
