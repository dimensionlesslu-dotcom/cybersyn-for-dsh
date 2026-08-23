import type { WorkflowStore } from './persistence.ts'

type RpcSuccess = { ok: true; value: unknown }
type RpcFailure = { ok: false; error: { code: 'internal'; message: string; details: Record<string, never> } }
export type CybersynRpcResult = RpcSuccess | RpcFailure

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('RPC payload must be an object')
  return value as Record<string, unknown>
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key]
  if (typeof field !== 'string' || field.trim().length === 0) throw new Error(`${key} must be a non-empty string`)
  return field
}

function integerField(value: Record<string, unknown>, key: string): number {
  const field = value[key]
  if (!Number.isSafeInteger(field)) throw new Error(`${key} must be an integer`)
  return field as number
}

function assertOwned(store: WorkflowStore, workflowId: string, sessionId: string): void {
  const workflow = store.get(workflowId)
  if (workflow === undefined) throw new Error(`Workflow ${workflowId} was not found`)
  if (workflow.sessionId !== sessionId) throw new Error(`Workflow ${workflowId} does not belong to this session`)
}

export function createRpcHandler(store: WorkflowStore) {
  return async (endpoint: string, payload: unknown): Promise<CybersynRpcResult> => {
    try {
      const body = record(payload)
      const sessionId = stringField(body, 'sessionId')
      switch (endpoint) {
        case 'workflow.active':
          return { ok: true, value: store.activeForSession(sessionId) ?? null }
        case 'workflow.get': {
          const workflowId = stringField(body, 'workflowId')
          assertOwned(store, workflowId, sessionId)
          return { ok: true, value: store.get(workflowId) }
        }
        case 'prompt.revise': {
          const workflowId = stringField(body, 'workflowId')
          assertOwned(store, workflowId, sessionId)
          const value = await store.revisePrompt(workflowId, {
            taskId: stringField(body, 'taskId'),
            replacement: stringField(body, 'replacement'),
            actor: stringField(body, 'actor'),
            reason: stringField(body, 'reason'),
            expectedRevision: integerField(body, 'expectedRevision'),
          })
          return { ok: true, value }
        }
        case 'prompt.rollback': {
          const workflowId = stringField(body, 'workflowId')
          assertOwned(store, workflowId, sessionId)
          const value = await store.rollbackPrompt(workflowId, {
            taskId: stringField(body, 'taskId'),
            targetPromptRevision: integerField(body, 'targetPromptRevision'),
            actor: stringField(body, 'actor'),
            reason: stringField(body, 'reason'),
            expectedRevision: integerField(body, 'expectedRevision'),
          })
          return { ok: true, value }
        }
        default:
          throw new Error(`Unknown Cybersyn RPC endpoint: ${endpoint}`)
      }
    } catch (error: unknown) {
      return {
        ok: false,
        error: { code: 'internal', message: error instanceof Error ? error.message : String(error), details: {} },
      }
    }
  }
}
