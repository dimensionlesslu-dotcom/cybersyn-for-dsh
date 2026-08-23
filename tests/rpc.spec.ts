import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { JsonlWorkflowStore } from '../src/persistence.ts'
import { createRpcHandler } from '../src/rpc.ts'
import { config, l3Seed } from './fixtures.ts'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('loopback human-control RPC', () => {
  it('binds reads and prompt mutations to the owning session with revision checks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cybersyn-rpc-'))
    dirs.push(dir)
    const store = new JsonlWorkflowStore(join(dir, 'events.jsonl'))
    await store.initialize()
    await store.create(l3Seed(), config)
    const rpc = createRpcHandler(store)

    const active = await rpc('workflow.active', { sessionId: 'test-session' })
    expect(active.ok).toBe(true)
    const foreign = await rpc('workflow.get', { sessionId: 'foreign-session', workflowId: 'test-workflow' })
    expect(foreign.ok).toBe(false)

    const revised = await rpc('prompt.revise', {
      sessionId: 'test-session', workflowId: 'test-workflow', taskId: 'observe',
      replacement: 'Observe the boundary and delayed signals.', actor: 'local-human', reason: 'Boundary correction', expectedRevision: 1,
    })
    expect(revised.ok).toBe(true)
    expect(store.get('test-workflow')?.tasks[0]?.promptRevision).toBe(2)

    const staleWriter = await rpc('prompt.revise', {
      sessionId: 'test-session', workflowId: 'test-workflow', taskId: 'observe',
      replacement: 'Another edit', actor: 'local-human', reason: 'Stale tab', expectedRevision: 1,
    })
    expect(staleWriter.ok).toBe(false)
    if (!staleWriter.ok) expect(staleWriter.error.message).toMatch(/Revision conflict/)
  })
})
