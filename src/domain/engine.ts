import type {
  AuditPacketUpdateInput,
  AuditPlanInput,
  ControlTask,
  Deviation,
  EngineConfig,
  GateCheck,
  GateReport,
  ModelUpdateInput,
  PromptRevisionInput,
  PromptRollbackInput,
  StoredEvent,
  TaskStatus,
  TaskUpdateInput,
  Workflow,
  WorkflowEvent,
  WorkflowSeed,
  WorkflowSummary,
  WorkspaceUpdateInput,
} from './types.ts'
import { applyAuditPacketUpdate, assembleAuditPipeline, auditHealth } from './audit.ts'

export class ControlError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'ControlError'
  }
}

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
const BLOCKING_SEVERITIES = new Set(['medium', 'high', 'critical'])
const LEGAL_TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  proposed: new Set(['proposed', 'blocked']),
  ready: new Set(['ready', 'running', 'blocked', 'verified']),
  running: new Set(['running', 'ready', 'blocked', 'verified']),
  blocked: new Set(['blocked', 'ready', 'running']),
  verified: new Set(['verified']),
  stale: new Set(['stale', 'ready', 'blocked']),
}

function assert(condition: unknown, message: string, code: string): asserts condition {
  if (!condition) throw new ControlError(message, code)
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function requireRevision(workflow: Workflow, expectedRevision: number): void {
  assert(
    workflow.revision === expectedRevision,
    `Revision conflict: expected ${expectedRevision}, current ${workflow.revision}`,
    'REVISION_CONFLICT',
  )
}

function finishMutation(workflow: Workflow, at: string): Workflow {
  workflow.revision += 1
  workflow.updatedAt = at
  return workflow
}

function dependencyMap(seed: WorkflowSeed): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const task of seed.tasks) map.set(task.id, task.dependsOn)
  return map
}

function assertAcyclic(seed: WorkflowSeed): void {
  const graph = dependencyMap(seed)
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new ControlError(`Dependency cycle includes ${id}`, 'CYCLIC_GRAPH')
    if (visited.has(id)) return
    visiting.add(id)
    for (const dependency of graph.get(id) ?? []) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of graph.keys()) visit(id)
}

export function validateSeed(seed: WorkflowSeed, config: EngineConfig): void {
  assert(ID_PATTERN.test(seed.id), 'Workflow id must be a portable 1-64 character identifier', 'INVALID_ID')
  assert(seed.sessionId.trim().length > 0, 'Session id is required', 'INVALID_SESSION')
  assert(seed.title.trim().length > 0, 'Workflow title is required', 'INVALID_TITLE')
  assert(seed.objective.trim().length > 0, 'Workflow objective is required', 'INVALID_OBJECTIVE')
  assert(seed.tasks.length > 0, 'At least one task is required', 'EMPTY_GRAPH')
  assert(config.workspaceCapacity > 0, 'Workspace capacity must be positive', 'INVALID_CONFIG')
  assert(config.maxPromptChars > 0, 'Prompt limit must be positive', 'INVALID_CONFIG')
  assert(config.l4MinimumModels > 0, 'L4 minimum model count must be positive', 'INVALID_CONFIG')

  const ids = new Set<string>()
  for (const task of seed.tasks) {
    assert(ID_PATTERN.test(task.id), `Invalid task id: ${task.id}`, 'INVALID_ID')
    assert(!ids.has(task.id), `Duplicate task id: ${task.id}`, 'DUPLICATE_TASK')
    ids.add(task.id)
    assert(task.title.trim().length > 0, `Task ${task.id} needs a title`, 'INVALID_TASK')
    assert(task.generatedPrompt.trim().length > 0, `Task ${task.id} needs a generated prompt`, 'INVALID_PROMPT')
    assert(task.generatedPrompt.length <= config.maxPromptChars, `Task ${task.id} prompt is too long`, 'PROMPT_TOO_LONG')
    assert(task.claims.length > 0 && task.claims.every(claim => claim.trim().length > 0), `Task ${task.id} needs at least one explicit claim`, 'INVALID_TASK')
  }
  for (const task of seed.tasks) {
    for (const dependency of task.dependsOn) {
      assert(ids.has(dependency), `Task ${task.id} depends on missing task ${dependency}`, 'MISSING_DEPENDENCY')
      assert(dependency !== task.id, `Task ${task.id} cannot depend on itself`, 'CYCLIC_GRAPH')
    }
  }
  assertAcyclic(seed)

  const requiredDepth = seed.level === 'L4' ? 4 : seed.level === 'L3' ? 3 : Number(seed.level.slice(1))
  const actualDepth = Math.max(...seed.tasks.map(task => task.depth))
  assert(actualDepth >= requiredDepth, `${seed.level} requires explicit depth-${requiredDepth} decomposition`, 'INSUFFICIENT_DECOMPOSITION')
  if (seed.level === 'L3' || seed.level === 'L4') {
    assert(seed.tasks.length >= 3, `${seed.level} requires at least three explicit subtasks`, 'INSUFFICIENT_DECOMPOSITION')
  }
}

export function createWorkflow(seed: WorkflowSeed, config: EngineConfig, at = new Date().toISOString()): Workflow {
  validateSeed(seed, config)
  const tasks: Record<string, ControlTask> = {}
  for (const task of seed.tasks) {
    const status: TaskStatus = task.dependsOn.length === 0 ? 'ready' : 'proposed'
    tasks[task.id] = {
      ...clone(task),
      status,
      effectivePrompt: task.generatedPrompt,
      promptRevision: 1,
      promptHistory: [{
        revision: 1,
        source: 'generated',
        generatedPrompt: task.generatedPrompt,
        effectivePrompt: task.generatedPrompt,
        actor: 'system',
        reason: 'initial decomposition',
        at,
      }],
      evidence: [],
      deviations: [],
    }
  }
  return {
    id: seed.id,
    sessionId: seed.sessionId,
    title: seed.title,
    domain: seed.domain,
    level: seed.level,
    objective: seed.objective,
    constraints: clone(seed.constraints),
    config: clone(config),
    revision: 1,
    createdAt: at,
    updatedAt: at,
    taskOrder: seed.tasks.map(task => task.id),
    tasks,
    workspace: [],
    models: [],
    promptAudit: [],
    auditPipelines: [],
  }
}

export function descendants(workflow: Workflow, taskId: string): string[] {
  assert(workflow.tasks[taskId] !== undefined, `Unknown task: ${taskId}`, 'UNKNOWN_TASK')
  const found = new Set<string>([taskId])
  let changed = true
  while (changed) {
    changed = false
    for (const id of workflow.taskOrder) {
      if (!found.has(id) && workflow.tasks[id]!.dependsOn.some(dependency => found.has(dependency))) {
        found.add(id)
        changed = true
      }
    }
  }
  return workflow.taskOrder.filter(id => found.has(id))
}

function dependenciesVerified(workflow: Workflow, task: ControlTask): boolean {
  return task.dependsOn.every(id => workflow.tasks[id]!.status === 'verified')
}

function hasBlockingDeviation(deviations: Deviation[]): boolean {
  return deviations.some(item => !item.resolved && BLOCKING_SEVERITIES.has(item.severity))
}

function hasCurrentPassingEvidence(task: ControlTask): boolean {
  return task.claims.every(claim => {
    const current = task.evidence.filter(item => !item.stale && item.promptRevision === task.promptRevision && item.claim === claim)
    return current.at(-1)?.status === 'passed'
  })
}

function unlockDependents(workflow: Workflow): void {
  for (const id of workflow.taskOrder) {
    const task = workflow.tasks[id]!
    if ((task.status === 'proposed' || task.status === 'stale') && dependenciesVerified(workflow, task)) {
      task.status = 'ready'
    }
  }
}

export function updateTask(workflow: Workflow, input: TaskUpdateInput, at = new Date().toISOString()): Workflow {
  requireRevision(workflow, input.expectedRevision)
  const next = clone(workflow)
  const task = next.tasks[input.taskId]
  assert(task !== undefined, `Unknown task: ${input.taskId}`, 'UNKNOWN_TASK')

  assert(LEGAL_TRANSITIONS[task.status].has(input.status), `Illegal task transition: ${task.status} -> ${input.status}`, 'ILLEGAL_TRANSITION')
  const evidenceIds = new Set(task.evidence.map(item => item.id))
  for (const evidence of input.evidence) {
    assert(ID_PATTERN.test(evidence.id), `Invalid evidence id: ${evidence.id}`, 'INVALID_EVIDENCE')
    assert(!evidenceIds.has(evidence.id), `Duplicate evidence id: ${evidence.id}`, 'DUPLICATE_EVIDENCE')
    assert(evidence.claim.trim().length > 0, `Evidence ${evidence.id} needs a claim`, 'INVALID_EVIDENCE')
    assert(evidence.artifact.trim().length > 0, `Evidence ${evidence.id} needs an artifact`, 'INVALID_EVIDENCE')
    assert(evidence.method.trim().length > 0, `Evidence ${evidence.id} needs a method`, 'INVALID_EVIDENCE')
    evidenceIds.add(evidence.id)
  }
  for (const deviation of input.deviations) {
    assert(ID_PATTERN.test(deviation.id), `Invalid deviation id: ${deviation.id}`, 'INVALID_DEVIATION')
    assert(deviation.labels.length > 0, `Deviation ${deviation.id} needs at least one A/B/C/D label`, 'INVALID_DEVIATION')
    assert(deviation.description.trim().length > 0, `Deviation ${deviation.id} needs a description`, 'INVALID_DEVIATION')
  }

  task.evidence.push(...input.evidence.map(item => ({
    ...clone(item),
    observedAt: at,
    promptRevision: task.promptRevision,
    stale: false,
  })))
  for (const deviation of input.deviations) {
    const existing = task.deviations.findIndex(item => item.id === deviation.id)
    if (existing >= 0) task.deviations[existing] = clone(deviation)
    else task.deviations.push(clone(deviation))
  }

  if (input.status === 'ready' || input.status === 'running' || input.status === 'verified') {
    assert(dependenciesVerified(next, task), `Dependencies for ${task.id} are not verified`, 'DEPENDENCY_NOT_VERIFIED')
  }
  if (input.status === 'verified') {
    assert(hasCurrentPassingEvidence(task), `Task ${task.id} lacks current passing evidence`, 'EVIDENCE_REQUIRED')
    assert(!hasBlockingDeviation(task.deviations), `Task ${task.id} has an unresolved blocking deviation`, 'DEVIATION_BLOCKS_VERIFICATION')
  }
  task.status = input.status
  if (input.status === 'verified') unlockDependents(next)
  return finishMutation(next, at)
}

function invalidateForPromptChange(workflow: Workflow, taskId: string): string[] {
  const affected = descendants(workflow, taskId)
  const running = affected.filter(id => workflow.tasks[id]!.status === 'running')
  assert(running.length === 0, `Stop running affected tasks before editing: ${running.join(', ')}`, 'RUNNING_TASK_AFFECTED')
  for (const id of affected) {
    const task = workflow.tasks[id]!
    task.status = 'stale'
    for (const evidence of task.evidence) evidence.stale = true
  }
  return affected
}

function applyPrompt(
  workflow: Workflow,
  taskId: string,
  replacement: string,
  actor: string,
  reason: string,
  source: 'human' | 'rollback',
  at: string,
): Workflow {
  assert(replacement.trim().length > 0, 'Replacement prompt cannot be empty', 'INVALID_PROMPT')
  assert(replacement.length <= workflow.config.maxPromptChars, 'Replacement prompt is too long', 'PROMPT_TOO_LONG')
  assert(actor.trim().length > 0, 'Prompt revision actor is required', 'INVALID_PROMPT')
  assert(reason.trim().length > 0, 'Prompt revision reason is required', 'INVALID_PROMPT')
  const next = clone(workflow)
  const task = next.tasks[taskId]
  assert(task !== undefined, `Unknown task: ${taskId}`, 'UNKNOWN_TASK')
  const affected = invalidateForPromptChange(next, taskId)
  const fromRevision = task.promptRevision
  task.promptRevision += 1
  task.effectivePrompt = replacement
  task.promptHistory.push({
    revision: task.promptRevision,
    source,
    generatedPrompt: task.generatedPrompt,
    effectivePrompt: replacement,
    actor,
    reason,
    at,
  })
  next.promptAudit.push({
    taskId,
    fromRevision,
    toRevision: task.promptRevision,
    actor,
    reason,
    invalidatedTaskIds: affected,
    at,
  })
  if (dependenciesVerified(next, task)) task.status = 'ready'
  return finishMutation(next, at)
}

export function revisePrompt(workflow: Workflow, input: PromptRevisionInput, at = new Date().toISOString()): Workflow {
  requireRevision(workflow, input.expectedRevision)
  return applyPrompt(workflow, input.taskId, input.replacement, input.actor, input.reason, 'human', at)
}

export function rollbackPrompt(workflow: Workflow, input: PromptRollbackInput, at = new Date().toISOString()): Workflow {
  requireRevision(workflow, input.expectedRevision)
  const task = workflow.tasks[input.taskId]
  assert(task !== undefined, `Unknown task: ${input.taskId}`, 'UNKNOWN_TASK')
  const target = task.promptHistory.find(item => item.revision === input.targetPromptRevision)
  assert(target !== undefined, `Unknown prompt revision ${input.targetPromptRevision}`, 'UNKNOWN_PROMPT_REVISION')
  return applyPrompt(workflow, input.taskId, target.effectivePrompt, input.actor, input.reason, 'rollback', at)
}

export function updateWorkspace(workflow: Workflow, input: WorkspaceUpdateInput, at = new Date().toISOString()): Workflow {
  requireRevision(workflow, input.expectedRevision)
  const next = clone(workflow)
  const index = next.workspace.findIndex(item => item.id === input.item.id)
  assert(ID_PATTERN.test(input.item.id), `Invalid workspace item id: ${input.item.id}`, 'INVALID_WORKSPACE_ITEM')
  assert(Number.isInteger(input.item.priority) && input.item.priority >= 1 && input.item.priority <= 5, `Workspace item ${input.item.id} needs priority 1-5`, 'INVALID_WORKSPACE_ITEM')
  if (input.action === 'remove') {
    assert(index >= 0, `Unknown workspace item: ${input.item.id}`, 'UNKNOWN_WORKSPACE_ITEM')
    next.workspace.splice(index, 1)
  } else if (index >= 0) {
    assert(input.item.content.trim().length > 0, `Workspace item ${input.item.id} needs content`, 'INVALID_WORKSPACE_ITEM')
    assert(next.tasks[input.item.sourceTaskId] !== undefined, `Unknown workspace source task: ${input.item.sourceTaskId}`, 'UNKNOWN_TASK')
    assert(input.item.scope.trim().length > 0, `Workspace item ${input.item.id} needs scope`, 'INVALID_WORKSPACE_ITEM')
    assert(input.item.removalCondition.trim().length > 0, `Workspace item ${input.item.id} needs a removal condition`, 'INVALID_WORKSPACE_ITEM')
    next.workspace[index] = { ...clone(input.item), updatedAt: at }
  } else {
    assert(next.workspace.length < next.config.workspaceCapacity, 'J-workspace capacity exceeded', 'WORKSPACE_CAPACITY')
    assert(input.item.content.trim().length > 0, `Workspace item ${input.item.id} needs content`, 'INVALID_WORKSPACE_ITEM')
    assert(next.tasks[input.item.sourceTaskId] !== undefined, `Unknown workspace source task: ${input.item.sourceTaskId}`, 'UNKNOWN_TASK')
    assert(input.item.scope.trim().length > 0, `Workspace item ${input.item.id} needs scope`, 'INVALID_WORKSPACE_ITEM')
    assert(input.item.removalCondition.trim().length > 0, `Workspace item ${input.item.id} needs a removal condition`, 'INVALID_WORKSPACE_ITEM')
    next.workspace.push({ ...clone(input.item), updatedAt: at })
  }
  return finishMutation(next, at)
}

export function updateModel(workflow: Workflow, input: ModelUpdateInput, at = new Date().toISOString()): Workflow {
  requireRevision(workflow, input.expectedRevision)
  assert(workflow.level === 'L4', 'Structural model competition is an L4 control', 'LEVEL_MISMATCH')
  const next = clone(workflow)
  const index = next.models.findIndex(model => model.id === input.model.id)
  assert(ID_PATTERN.test(input.model.id), `Invalid structural model id: ${input.model.id}`, 'INVALID_MODEL')
  if (input.action === 'remove') {
    assert(index >= 0, `Unknown structural model: ${input.model.id}`, 'UNKNOWN_MODEL')
    next.models.splice(index, 1)
  } else if (index >= 0) {
    assert(input.model.name.trim().length > 0 && input.model.prediction.trim().length > 0 && input.model.falsifier.trim().length > 0, `Structural model ${input.model.id} is incomplete`, 'INVALID_MODEL')
    next.models[index] = { ...clone(input.model), updatedAt: at }
  } else {
    assert(input.model.name.trim().length > 0 && input.model.prediction.trim().length > 0 && input.model.falsifier.trim().length > 0, `Structural model ${input.model.id} is incomplete`, 'INVALID_MODEL')
    next.models.push({ ...clone(input.model), updatedAt: at })
  }
  return finishMutation(next, at)
}

export function planAudit(workflow: Workflow, input: AuditPlanInput, at = new Date().toISOString()): Workflow {
  requireRevision(workflow, input.expectedRevision)
  const next = clone(workflow)
  next.auditPipelines.push(assembleAuditPipeline(next, input, at))
  return finishMutation(next, at)
}

export function updateAuditPacket(workflow: Workflow, input: AuditPacketUpdateInput, at = new Date().toISOString()): Workflow {
  requireRevision(workflow, input.expectedRevision)
  const next = clone(workflow)
  const index = next.auditPipelines.findIndex(pipeline => pipeline.id === input.pipelineId)
  assert(index >= 0, `Unknown audit pipeline: ${input.pipelineId}`, 'UNKNOWN_AUDIT_PIPELINE')
  next.auditPipelines[index] = applyAuditPacketUpdate(next.auditPipelines[index]!, input, at)
  return finishMutation(next, at)
}

export function gateReport(workflow: Workflow): GateReport {
  const checks: GateCheck[] = []
  const unverified = workflow.taskOrder.filter(id => workflow.tasks[id]!.status !== 'verified')
  checks.push({
    id: 'all_tasks_verified',
    passed: unverified.length === 0,
    detail: unverified.length === 0 ? 'Every task is verified' : `Not verified: ${unverified.join(', ')}`,
  })

  const staleEvidenceTasks = workflow.taskOrder.filter(id => {
    const task = workflow.tasks[id]!
    return !hasCurrentPassingEvidence(task)
  })
  checks.push({
    id: 'current_evidence',
    passed: staleEvidenceTasks.length === 0,
    detail: staleEvidenceTasks.length === 0 ? 'Every task has current passing evidence' : `Missing current evidence: ${staleEvidenceTasks.join(', ')}`,
  })

  const unresolved = workflow.taskOrder.flatMap(id => workflow.tasks[id]!.deviations
    .filter(item => !item.resolved && BLOCKING_SEVERITIES.has(item.severity))
    .map(item => `${id}/${item.id}`))
  checks.push({
    id: 'blocking_deviations_resolved',
    passed: unresolved.length === 0,
    detail: unresolved.length === 0 ? 'No unresolved blocking deviation' : `Unresolved: ${unresolved.join(', ')}`,
  })

  if (workflow.level === 'L4') {
    const active = workflow.models.filter(model => model.status === 'active')
    checks.push({
      id: 'l4_model_competition',
      passed: active.length >= workflow.config.l4MinimumModels,
      detail: `${active.length}/${workflow.config.l4MinimumModels} active structural models`,
    })
  }
  for (const pipeline of workflow.auditPipelines.filter(item => item.requiredForGate)) {
    const health = auditHealth(workflow, pipeline)
    const operationalPass = health.operationalStatus === 'healthy'
    checks.push({
      id: `audit_${pipeline.id}_operational`,
      passed: operationalPass,
      detail: `Subagent audit operational status: ${health.operationalStatus}.`,
    })
    if (pipeline.qualityRegressionRequired) {
      checks.push({
        id: `audit_${pipeline.id}_effectiveness`,
        passed: health.effectivenessStatus === 'non-degraded',
        detail: `Subagent audit effectiveness status: ${health.effectivenessStatus}.`,
      })
    }
  }
  return { passed: checks.every(check => check.passed), checks }
}

export function summarize(workflow: Workflow): WorkflowSummary {
  return {
    id: workflow.id,
    sessionId: workflow.sessionId,
    title: workflow.title,
    domain: workflow.domain,
    level: workflow.level,
    objective: workflow.objective,
    revision: workflow.revision,
    updatedAt: workflow.updatedAt,
    tasks: workflow.taskOrder.map(id => clone(workflow.tasks[id]!)),
    workspace: clone(workflow.workspace),
    models: clone(workflow.models),
    promptAudit: clone(workflow.promptAudit),
    auditPipelines: workflow.auditPipelines.map(pipeline => ({ ...clone(pipeline), health: auditHealth(workflow, pipeline) })),
    gate: gateReport(workflow),
  }
}

export function reduceEvent(current: Workflow | undefined, stored: StoredEvent): Workflow {
  const { event } = stored
  if (event.type === 'workflow.created') {
    assert(current === undefined, `Workflow ${event.workflow.id} already exists`, 'WORKFLOW_EXISTS')
    return clone(event.workflow)
  }
  assert(current !== undefined, `Workflow ${event.workflowId} does not exist`, 'WORKFLOW_NOT_FOUND')
  switch (event.type) {
    case 'task.updated': return updateTask(current, event.input, event.at)
    case 'workspace.updated': return updateWorkspace(current, event.input, event.at)
    case 'model.updated': return updateModel(current, event.input, event.at)
    case 'prompt.revised': return revisePrompt(current, event.input, event.at)
    case 'prompt.rolled_back': return rollbackPrompt(current, event.input, event.at)
    case 'audit.planned': return planAudit(current, event.input, event.at)
    case 'audit.packet_updated': return updateAuditPacket(current, event.input, event.at)
  }
}

export function eventWorkflowId(event: WorkflowEvent): string {
  return event.type === 'workflow.created' ? event.workflow.id : event.workflowId
}
