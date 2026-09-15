import { defineTool } from '@deepseek-ai/dsh-tools'
import type { WorkflowStore } from './persistence.ts'
import type {
  AuditExecutionMode,
  AuditFinding,
  AuditPacketStatus,
  AuditRole,
  ControlLevel,
  DeviationInput,
  EvidenceInput,
  ModelUpdateInput,
  StructuralModel,
  TaskSeed,
  TaskStatus,
  WorkflowSeed,
  WorkspaceItem,
  WorkspaceUpdateInput,
} from './domain/types.ts'

const toolOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      workflowId: { type: 'string', required: true },
      revision: { type: 'integer', required: true },
      gatePassed: { type: 'boolean', required: true },
      detail: { type: 'string', required: true },
      stateJson: { type: 'string', required: true },
    },
  },
  render: (_args: unknown, value: { workflowId: string; revision: number; gatePassed: boolean; detail: string; stateJson: string }) => [{
    type: 'text' as const,
    text: `${value.detail}\nworkflow=${value.workflowId} revision=${value.revision} gate=${value.gatePassed ? 'PASS' : 'HOLD'}\n${value.stateJson}`,
  }],
} as const

function sessionId(exec: { agent?: { session: { header: { id: string } } } }): string {
  const id = exec.agent?.session.header.id
  if (id === undefined) throw new Error('Cybersyn tools require a calling agent session')
  return id
}

function ensureOwned(store: WorkflowStore, workflowId: string, owner: string): void {
  const workflow = store.get(workflowId)
  if (workflow === undefined) throw new Error(`Workflow ${workflowId} was not found`)
  if (workflow.sessionId !== owner) throw new Error(`Workflow ${workflowId} belongs to another session`)
}

function result(summary: { id: string; revision: number; gate: { passed: boolean } }, detail: string) {
  return { workflowId: summary.id, revision: summary.revision, gatePassed: summary.gate.passed, detail,
    stateJson: JSON.stringify({ assurance: 'T2-reported-evidence', workflow: summary }) }
}

const evidenceSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    claim: { type: 'string', required: true },
    artifact: { type: 'string', required: true },
    method: { type: 'string', required: true },
    status: { type: 'string', enum: ['passed', 'failed', 'unverified', 'blocked'], required: true },
  },
} as const

const deviationSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    labels: { type: 'array', items: { type: 'string', enum: ['A', 'B', 'C', 'D'] }, required: true },
    severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], required: true },
    description: { type: 'string', required: true },
    resolved: { type: 'boolean', required: true },
    resolution: { type: 'string', required: true },
  },
} as const

const auditFindingSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], required: true },
    summary: { type: 'string', required: true },
    evidenceRef: { type: 'string', required: true },
    recommendation: { type: 'string', required: true },
  },
} as const

export function registerTools(store: WorkflowStore, config: { workspaceCapacity: number; maxPromptChars: number; l4MinimumModels: number }, register: (tool: ReturnType<typeof defineTool>) => unknown): void {
  register(defineTool({
    name: 'cybersyn_start',
    description: 'Start a session-bound L1-L4 assurance workflow. L3/L4 require explicit decomposed tasks and editable generated prompts.',
    parameters: {
      workflowId: { type: 'string', required: true },
      title: { type: 'string', required: true },
      domain: { type: 'string', required: true },
      level: { type: 'string', enum: ['L1', 'L2', 'L3', 'L4'], required: true },
      objective: { type: 'string', required: true },
      constraints: { type: 'array', items: { type: 'string' }, required: true },
      tasks: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            title: { type: 'string', required: true },
            depth: { type: 'integer', enum: [1, 2, 3, 4], required: true },
            dependsOn: { type: 'array', items: { type: 'string' }, required: true },
            generatedPrompt: { type: 'string', required: true },
            claims: { type: 'array', items: { type: 'string' }, required: true },
          },
        },
      },
    },
    output: toolOutput,
    async execute(args, exec) {
      const seed: WorkflowSeed = {
        id: args.workflowId,
        sessionId: sessionId(exec),
        title: args.title,
        domain: args.domain,
        level: args.level as ControlLevel,
        objective: args.objective,
        constraints: args.constraints,
        tasks: args.tasks as TaskSeed[],
      }
      const summary = await store.create(seed, config)
      return result(summary, `Started ${summary.level} Cybersyn workflow with ${summary.tasks.length} explicit tasks.`)
    },
  }))

  register(defineTool({
    name: 'cybersyn_task_update',
    description: 'Record evidence/deviations and move one task through the legal control states. Verification requires current passing evidence.',
    parameters: {
      workflowId: { type: 'string', required: true },
      taskId: { type: 'string', required: true },
      status: { type: 'string', enum: ['proposed', 'ready', 'running', 'blocked', 'verified', 'stale'], required: true },
      evidence: { type: 'array', items: evidenceSchema, required: true },
      deviations: { type: 'array', items: deviationSchema, required: true },
      expectedRevision: { type: 'integer', required: true },
    },
    output: toolOutput,
    async execute(args, exec) {
      const owner = sessionId(exec)
      ensureOwned(store, args.workflowId, owner)
      const summary = await store.updateTask(args.workflowId, {
        taskId: args.taskId,
        status: args.status as TaskStatus,
        evidence: args.evidence as EvidenceInput[],
        deviations: args.deviations as DeviationInput[],
        expectedRevision: args.expectedRevision,
      })
      return result(summary, `Task ${args.taskId} is now ${args.status}.`)
    },
  }))

  register(defineTool({
    name: 'cybersyn_workspace_update',
    description: 'Upsert or remove one selectively broadcast J-workspace item. This stores external coordination facts, never hidden reasoning.',
    parameters: {
      workflowId: { type: 'string', required: true },
      action: { type: 'string', enum: ['upsert', 'remove'], required: true },
      expectedRevision: { type: 'integer', required: true },
      item: {
        type: 'object',
        additionalProperties: false,
        required: true,
        properties: {
          id: { type: 'string', required: true },
          kind: { type: 'string', enum: ['goal', 'constraint', 'evidence', 'deviation', 'decision', 'handoff'], required: true },
          content: { type: 'string', required: true },
          sourceTaskId: { type: 'string', required: true },
          scope: { type: 'string', required: true },
          priority: { type: 'integer', enum: [1, 2, 3, 4, 5], required: true },
          removalCondition: { type: 'string', required: true },
          updatedAt: { type: 'string', required: true },
        },
      },
    },
    output: toolOutput,
    async execute(args, exec) {
      ensureOwned(store, args.workflowId, sessionId(exec))
      const input: WorkspaceUpdateInput = {
        action: args.action,
        item: args.item as WorkspaceItem,
        expectedRevision: args.expectedRevision,
      }
      const summary = await store.updateWorkspace(args.workflowId, input)
      return result(summary, `J-workspace item ${args.item.id} ${args.action === 'upsert' ? 'stored' : 'removed'}.`)
    },
  }))

  register(defineTool({
    name: 'cybersyn_model_update',
    description: 'For L4 workflows, add, update, reject, or remove an explicit competing structural model with a falsifier.',
    parameters: {
      workflowId: { type: 'string', required: true },
      action: { type: 'string', enum: ['upsert', 'remove'], required: true },
      expectedRevision: { type: 'integer', required: true },
      model: {
        type: 'object',
        additionalProperties: false,
        required: true,
        properties: {
          id: { type: 'string', required: true },
          name: { type: 'string', required: true },
          assumptions: { type: 'array', items: { type: 'string' }, required: true },
          prediction: { type: 'string', required: true },
          falsifier: { type: 'string', required: true },
          status: { type: 'string', enum: ['active', 'rejected'], required: true },
          updatedAt: { type: 'string', required: true },
        },
      },
    },
    output: toolOutput,
    async execute(args, exec) {
      ensureOwned(store, args.workflowId, sessionId(exec))
      const input: ModelUpdateInput = {
        action: args.action,
        model: args.model as StructuralModel,
        expectedRevision: args.expectedRevision,
      }
      const summary = await store.updateModel(args.workflowId, input)
      return result(summary, `Structural model ${args.model.id} ${args.action === 'upsert' ? 'stored' : 'removed'}.`)
    },
  }))

  register(defineTool({
    name: 'cybersyn_audit_plan',
    description: 'Assemble read-only, context-filtered PromptPackets for risk-selected audit roles. This tool records a plan only and never starts a subagent.',
    parameters: {
      workflowId: { type: 'string', required: true },
      pipelineId: { type: 'string', required: true },
      trigger: { type: 'string', required: true },
      taskId: { type: 'string', required: true },
      riskSignals: { type: 'array', items: { type: 'string', enum: ['A', 'B', 'C', 'D'] }, required: true },
      goalConflict: { type: 'boolean', required: true },
      requestedRoles: { type: 'array', items: { type: 'string', enum: ['goal-spec', 'measurement', 'integration-regression', 'environment'] }, required: true },
      executionMode: { type: 'string', enum: ['harness-workflow', 'harness-subagent', 'host-serial-fallback'], required: true },
      contextIndependent: { type: 'boolean', required: true },
      requiredForGate: { type: 'boolean', required: true },
      qualityRegressionRequired: { type: 'boolean', required: true },
      acceptance: { type: 'array', items: { type: 'string' }, required: true },
      artifactRefs: { type: 'array', items: { type: 'string' }, required: true },
      evidenceRefs: { type: 'array', items: { type: 'string' }, required: true },
      maxFindings: { type: 'integer', required: true },
      thresholds: {
        type: 'object',
        additionalProperties: false,
        required: true,
        properties: {
          minimumCompletionRatio: { type: 'number', required: true },
          maximumFailureRatio: { type: 'number', required: true },
          maximumTotalTokens: { type: 'integer' },
          maximumDurationMs: { type: 'integer' },
          baselineQualityScore: { type: 'number' },
          maximumQualityDrop: { type: 'number', required: true },
        },
      },
      expectedRevision: { type: 'integer', required: true },
    },
    output: toolOutput,
    async execute(args, exec) {
      ensureOwned(store, args.workflowId, sessionId(exec))
      const summary = await store.planAudit(args.workflowId, {
        pipelineId: args.pipelineId,
        trigger: args.trigger,
        taskId: args.taskId,
        riskSignals: args.riskSignals,
        goalConflict: args.goalConflict,
        requestedRoles: args.requestedRoles as AuditRole[],
        executionMode: args.executionMode as AuditExecutionMode,
        contextIndependent: args.contextIndependent,
        requiredForGate: args.requiredForGate,
        qualityRegressionRequired: args.qualityRegressionRequired,
        acceptance: args.acceptance,
        artifactRefs: args.artifactRefs,
        evidenceRefs: args.evidenceRefs,
        maxFindings: args.maxFindings,
        thresholds: args.thresholds,
        expectedRevision: args.expectedRevision,
      })
      const pipeline = summary.auditPipelines.find(item => item.id === args.pipelineId)!
      return result(summary, `Assembled ${pipeline.packets.length} read-only PromptPackets; subagents started: 0.`)
    },
  }))

  register(defineTool({
    name: 'cybersyn_audit_update',
    description: 'Project a Harness subagent/workflow lifecycle fact into a planned audit packet and recompute explicit operational/effectiveness degradation status.',
    parameters: {
      workflowId: { type: 'string', required: true },
      pipelineId: { type: 'string', required: true },
      packetId: { type: 'string', required: true },
      status: { type: 'string', enum: ['dispatched', 'running', 'completed', 'failed', 'cancelled'], required: true },
      harnessRunId: { type: 'string', required: true },
      findings: { type: 'array', items: auditFindingSchema, required: true },
      totalTokens: { type: 'integer' },
      durationMs: { type: 'integer' },
      qualityScore: { type: 'number' },
      error: { type: 'string', required: true },
      detail: { type: 'string', required: true },
      expectedRevision: { type: 'integer', required: true },
    },
    output: toolOutput,
    async execute(args, exec) {
      ensureOwned(store, args.workflowId, sessionId(exec))
      const summary = await store.updateAuditPacket(args.workflowId, {
        pipelineId: args.pipelineId,
        packetId: args.packetId,
        status: args.status as Exclude<AuditPacketStatus, 'planned'>,
        harnessRunId: args.harnessRunId,
        findings: args.findings as AuditFinding[],
        totalTokens: args.totalTokens,
        durationMs: args.durationMs,
        qualityScore: args.qualityScore,
        error: args.error,
        detail: args.detail,
        expectedRevision: args.expectedRevision,
      })
      const health = summary.auditPipelines.find(item => item.id === args.pipelineId)!.health
      return result(summary, `Audit packet ${args.packetId} is ${args.status}; operational=${health.operationalStatus}, effectiveness=${health.effectivenessStatus}.`)
    },
  }))

  register(defineTool({
    name: 'cybersyn_inspect',
    description: 'Inspect the active session workflow or a named session-owned workflow and return its current assurance-gate status.',
    parameters: { workflowId: { type: 'string' } },
    output: toolOutput,
    async execute(args, exec) {
      const owner = sessionId(exec)
      const summary = args.workflowId === undefined ? store.activeForSession(owner) : store.get(args.workflowId)
      if (summary === undefined) throw new Error('No Cybersyn workflow was found for this session')
      ensureOwned(store, summary.id, owner)
      const holds = summary.gate.checks.filter(check => !check.passed).map(check => check.id)
      return result(summary, summary.gate.passed ? 'Assurance gate passes.' : `Assurance gate holds: ${holds.join(', ')}.`)
    },
  }))
}
