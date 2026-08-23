import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  createWorkflow,
  eventWorkflowId,
  reduceEvent,
  summarize,
} from './domain/engine.ts'
import type {
  AuditPacketUpdateInput,
  AuditPlanInput,
  EngineConfig,
  ModelUpdateInput,
  PromptRevisionInput,
  PromptRollbackInput,
  StoredEvent,
  TaskUpdateInput,
  Workflow,
  WorkflowEvent,
  WorkflowSeed,
  WorkflowSummary,
  WorkspaceUpdateInput,
} from './domain/types.ts'

export class EventStoreError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'EventStoreError'
  }
}

function looksLikeIncompleteJsonRecord(line: string): boolean {
  const text = line.trim()
  if (!text.startsWith('{')) return false
  const stack: string[] = []
  let inString = false
  let escaped = false
  for (const character of text) {
    if (escaped) {
      escaped = false
      continue
    }
    if (inString && character === '\\') {
      escaped = true
      continue
    }
    if (character === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (character === '{' || character === '[') stack.push(character)
    if (character === '}' || character === ']') {
      const expected = character === '}' ? '{' : '['
      if (stack.pop() !== expected) return false
    }
  }
  return inString || stack.length > 0
}

export interface WorkflowStore {
  initialize(): Promise<void>
  create(seed: WorkflowSeed, config: EngineConfig): Promise<WorkflowSummary>
  get(workflowId: string): WorkflowSummary | undefined
  activeForSession(sessionId: string): WorkflowSummary | undefined
  updateTask(workflowId: string, input: TaskUpdateInput): Promise<WorkflowSummary>
  updateWorkspace(workflowId: string, input: WorkspaceUpdateInput): Promise<WorkflowSummary>
  updateModel(workflowId: string, input: ModelUpdateInput): Promise<WorkflowSummary>
  revisePrompt(workflowId: string, input: PromptRevisionInput): Promise<WorkflowSummary>
  rollbackPrompt(workflowId: string, input: PromptRollbackInput): Promise<WorkflowSummary>
  planAudit(workflowId: string, input: AuditPlanInput): Promise<WorkflowSummary>
  updateAuditPacket(workflowId: string, input: AuditPacketUpdateInput): Promise<WorkflowSummary>
}

export class JsonlWorkflowStore implements WorkflowStore {
  readonly #workflows = new Map<string, Workflow>()
  #nextSeq = 1
  #initialized = false
  #queue: Promise<void> = Promise.resolve()

  constructor(readonly filePath: string) {}

  async initialize(): Promise<void> {
    if (this.#initialized) return
    await mkdir(dirname(this.filePath), { recursive: true })
    let raw = ''
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (raw.length === 0) {
      this.#initialized = true
      return
    }
    const endsWithNewline = raw.endsWith('\n')
    const lines = raw.split('\n')
    if (endsWithNewline) lines.pop()
    let recoveredTail = false
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!
      if (line.trim().length === 0) {
        throw new EventStoreError(`Blank interior JSONL record at line ${index + 1}`, 'CORRUPT_LOG')
      }
      let stored: StoredEvent
      try {
        stored = JSON.parse(line) as StoredEvent
      } catch (error: unknown) {
        const incompleteTail = index === lines.length - 1 && !endsWithNewline && looksLikeIncompleteJsonRecord(line)
        if (incompleteTail) {
          const validPrefix = lines.slice(0, index)
          await writeFile(this.filePath, validPrefix.length === 0 ? '' : `${validPrefix.join('\n')}\n`, 'utf8')
          recoveredTail = true
          break
        }
        throw new EventStoreError(`Malformed JSONL record at line ${index + 1}: ${String(error)}`, 'CORRUPT_LOG')
      }
      if (!Number.isSafeInteger(stored.seq) || stored.seq !== this.#nextSeq) {
        throw new EventStoreError(`Non-contiguous sequence at line ${index + 1}`, 'CORRUPT_LOG')
      }
      this.#replay(stored)
      this.#nextSeq += 1
    }
    if (!endsWithNewline && !recoveredTail) await appendFile(this.filePath, '\n', 'utf8')
    this.#initialized = true
  }

  async create(seed: WorkflowSeed, config: EngineConfig): Promise<WorkflowSummary> {
    this.#requireInitialized()
    const workflow = createWorkflow(seed, config)
    return this.#append({ type: 'workflow.created', workflow })
  }

  get(workflowId: string): WorkflowSummary | undefined {
    this.#requireInitialized()
    const workflow = this.#workflows.get(workflowId)
    return workflow === undefined ? undefined : summarize(workflow)
  }

  activeForSession(sessionId: string): WorkflowSummary | undefined {
    this.#requireInitialized()
    const matches = [...this.#workflows.values()]
      .filter(workflow => workflow.sessionId === sessionId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    return matches[0] === undefined ? undefined : summarize(matches[0])
  }

  updateTask(workflowId: string, input: TaskUpdateInput): Promise<WorkflowSummary> {
    return this.#append({ type: 'task.updated', workflowId, input, at: new Date().toISOString() })
  }

  updateWorkspace(workflowId: string, input: WorkspaceUpdateInput): Promise<WorkflowSummary> {
    return this.#append({ type: 'workspace.updated', workflowId, input, at: new Date().toISOString() })
  }

  updateModel(workflowId: string, input: ModelUpdateInput): Promise<WorkflowSummary> {
    return this.#append({ type: 'model.updated', workflowId, input, at: new Date().toISOString() })
  }

  revisePrompt(workflowId: string, input: PromptRevisionInput): Promise<WorkflowSummary> {
    return this.#append({ type: 'prompt.revised', workflowId, input, at: new Date().toISOString() })
  }

  rollbackPrompt(workflowId: string, input: PromptRollbackInput): Promise<WorkflowSummary> {
    return this.#append({ type: 'prompt.rolled_back', workflowId, input, at: new Date().toISOString() })
  }

  planAudit(workflowId: string, input: AuditPlanInput): Promise<WorkflowSummary> {
    return this.#append({ type: 'audit.planned', workflowId, input, at: new Date().toISOString() })
  }

  updateAuditPacket(workflowId: string, input: AuditPacketUpdateInput): Promise<WorkflowSummary> {
    return this.#append({ type: 'audit.packet_updated', workflowId, input, at: new Date().toISOString() })
  }

  #requireInitialized(): void {
    if (!this.#initialized) throw new EventStoreError('Store must be initialized before use', 'NOT_INITIALIZED')
  }

  #replay(stored: StoredEvent): Workflow {
    const workflowId = eventWorkflowId(stored.event)
    const next = reduceEvent(this.#workflows.get(workflowId), stored)
    this.#workflows.set(workflowId, next)
    return next
  }

  #append(event: WorkflowEvent): Promise<WorkflowSummary> {
    this.#requireInitialized()
    const operation = async (): Promise<WorkflowSummary> => {
      const workflowId = eventWorkflowId(event)
      const stored: StoredEvent = { seq: this.#nextSeq, event }
      const next = reduceEvent(this.#workflows.get(workflowId), stored)
      await appendFile(this.filePath, `${JSON.stringify(stored)}\n`, 'utf8')
      this.#workflows.set(workflowId, next)
      this.#nextSeq += 1
      return summarize(next)
    }
    const result = this.#queue.then(operation, operation)
    this.#queue = result.then(() => undefined, () => undefined)
    return result
  }
}
