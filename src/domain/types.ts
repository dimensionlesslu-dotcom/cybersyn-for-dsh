export type ControlLevel = 'L1' | 'L2' | 'L3' | 'L4'
export type TaskStatus = 'proposed' | 'ready' | 'running' | 'blocked' | 'verified' | 'stale'
export type EvidenceStatus = 'passed' | 'failed' | 'unverified' | 'blocked'
export type DeviationLabel = 'A' | 'B' | 'C' | 'D'
export type Severity = 'low' | 'medium' | 'high' | 'critical'
export type AuditRole = 'goal-spec' | 'measurement' | 'integration-regression' | 'environment'
export type AuditExecutionMode = 'harness-workflow' | 'harness-subagent' | 'host-serial-fallback'
export type AuditPacketStatus = 'planned' | 'dispatched' | 'running' | 'completed' | 'failed' | 'cancelled'
export type AuditHealthStatus = 'unmeasured' | 'healthy' | 'degraded'
export type EffectivenessStatus = 'unmeasured' | 'non-degraded' | 'degraded'

export interface EngineConfig {
  workspaceCapacity: number
  maxPromptChars: number
  l4MinimumModels: number
}

export interface TaskSeed {
  id: string
  title: string
  depth: 1 | 2 | 3 | 4
  dependsOn: string[]
  generatedPrompt: string
  claims: string[]
}

export interface WorkflowSeed {
  id: string
  sessionId: string
  title: string
  domain: string
  level: ControlLevel
  objective: string
  constraints: string[]
  tasks: TaskSeed[]
}

export interface PromptRevision {
  revision: number
  source: 'generated' | 'human' | 'rollback'
  generatedPrompt: string
  effectivePrompt: string
  actor: string
  reason: string
  at: string
}

export interface EvidenceItem {
  id: string
  claim: string
  artifact: string
  method: string
  status: EvidenceStatus
  observedAt: string
  promptRevision: number
  stale: boolean
}

export interface Deviation {
  id: string
  labels: DeviationLabel[]
  severity: Severity
  description: string
  resolved: boolean
  resolution: string
}

export interface ControlTask {
  id: string
  title: string
  depth: 1 | 2 | 3 | 4
  dependsOn: string[]
  status: TaskStatus
  generatedPrompt: string
  effectivePrompt: string
  promptRevision: number
  promptHistory: PromptRevision[]
  claims: string[]
  evidence: EvidenceItem[]
  deviations: Deviation[]
}

export interface WorkspaceItem {
  id: string
  kind: 'goal' | 'constraint' | 'evidence' | 'deviation' | 'decision' | 'handoff'
  content: string
  sourceTaskId: string
  scope: string
  priority: 1 | 2 | 3 | 4 | 5
  removalCondition: string
  updatedAt: string
}

export interface StructuralModel {
  id: string
  name: string
  assumptions: string[]
  prediction: string
  falsifier: string
  status: 'active' | 'rejected'
  updatedAt: string
}

export interface PromptAuditEntry {
  taskId: string
  fromRevision: number
  toRevision: number
  actor: string
  reason: string
  invalidatedTaskIds: string[]
  at: string
}

export interface AuditFinding {
  id: string
  severity: Severity
  summary: string
  evidenceRef: string
  recommendation: string
}

export interface AuditLifecycleEntry {
  status: AuditPacketStatus
  attempt: 1 | 2
  harnessRunId: string
  at: string
  detail: string
  findingCount: number
  totalTokens?: number | undefined
  durationMs?: number | undefined
  qualityScore?: number | undefined
}

export interface AuditPacket {
  id: string
  role: AuditRole
  taskId: string
  taskPromptRevision: number
  authority: 'read-only'
  excludedContext: string[]
  objective: string
  failureCriteria: string[]
  maxFindings: number
  prompt: string
  status: AuditPacketStatus
  attempt: 1 | 2
  harnessRunId: string
  findings: AuditFinding[]
  totalTokens?: number | undefined
  durationMs?: number | undefined
  qualityScore?: number | undefined
  error: string
  lifecycle: AuditLifecycleEntry[]
}

export interface AuditThresholds {
  minimumCompletionRatio: number
  maximumFailureRatio: number
  maximumTotalTokens?: number | undefined
  maximumDurationMs?: number | undefined
  baselineQualityScore?: number | undefined
  maximumQualityDrop: number
}

export interface AuditPipeline {
  id: string
  trigger: string
  executionMode: AuditExecutionMode
  contextIndependent: boolean
  requiredForGate: boolean
  qualityRegressionRequired: boolean
  expectedRoles: AuditRole[]
  thresholds: AuditThresholds
  packets: AuditPacket[]
  createdAt: string
  updatedAt: string
}

export interface AuditHealthCheck {
  id: string
  status: 'pass' | 'fail' | 'unmeasured' | 'not-applicable'
  detail: string
}

export interface AuditHealth {
  operationalStatus: AuditHealthStatus
  effectivenessStatus: EffectivenessStatus
  completedRoleRatio: number
  failureRatio: number
  totalTokens?: number | undefined
  durationMs?: number | undefined
  qualityScore?: number | undefined
  checks: AuditHealthCheck[]
}

export interface AuditPipelineView extends AuditPipeline {
  health: AuditHealth
}

export interface Workflow {
  id: string
  sessionId: string
  title: string
  domain: string
  level: ControlLevel
  objective: string
  constraints: string[]
  config: EngineConfig
  revision: number
  createdAt: string
  updatedAt: string
  taskOrder: string[]
  tasks: Record<string, ControlTask>
  workspace: WorkspaceItem[]
  models: StructuralModel[]
  promptAudit: PromptAuditEntry[]
  auditPipelines: AuditPipeline[]
}

export interface GateCheck {
  id: string
  passed: boolean
  detail: string
}

export interface GateReport {
  passed: boolean
  checks: GateCheck[]
}

export interface WorkflowSummary {
  id: string
  sessionId: string
  title: string
  domain: string
  level: ControlLevel
  objective: string
  revision: number
  updatedAt: string
  tasks: ControlTask[]
  workspace: WorkspaceItem[]
  models: StructuralModel[]
  promptAudit: PromptAuditEntry[]
  auditPipelines: AuditPipelineView[]
  gate: GateReport
}

export interface EvidenceInput {
  id: string
  claim: string
  artifact: string
  method: string
  status: EvidenceStatus
}

export interface DeviationInput {
  id: string
  labels: DeviationLabel[]
  severity: Severity
  description: string
  resolved: boolean
  resolution: string
}

export interface TaskUpdateInput {
  taskId: string
  status: TaskStatus
  evidence: EvidenceInput[]
  deviations: DeviationInput[]
  expectedRevision: number
}

export interface PromptRevisionInput {
  taskId: string
  replacement: string
  actor: string
  reason: string
  expectedRevision: number
}

export interface PromptRollbackInput {
  taskId: string
  targetPromptRevision: number
  actor: string
  reason: string
  expectedRevision: number
}

export interface WorkspaceUpdateInput {
  action: 'upsert' | 'remove'
  item: WorkspaceItem
  expectedRevision: number
}

export interface ModelUpdateInput {
  action: 'upsert' | 'remove'
  model: StructuralModel
  expectedRevision: number
}

export interface AuditPlanInput {
  pipelineId: string
  trigger: string
  taskId: string
  riskSignals: DeviationLabel[]
  goalConflict: boolean
  requestedRoles: AuditRole[]
  executionMode: AuditExecutionMode
  contextIndependent: boolean
  requiredForGate: boolean
  qualityRegressionRequired: boolean
  acceptance: string[]
  artifactRefs: string[]
  evidenceRefs: string[]
  maxFindings: number
  thresholds: AuditThresholds
  expectedRevision: number
}

export interface AuditPacketUpdateInput {
  pipelineId: string
  packetId: string
  status: Exclude<AuditPacketStatus, 'planned'>
  harnessRunId: string
  findings: AuditFinding[]
  totalTokens?: number | undefined
  durationMs?: number | undefined
  qualityScore?: number | undefined
  error: string
  detail: string
  expectedRevision: number
}

export type WorkflowEvent =
  | { type: 'workflow.created'; workflow: Workflow }
  | { type: 'task.updated'; workflowId: string; input: TaskUpdateInput; at: string }
  | { type: 'workspace.updated'; workflowId: string; input: WorkspaceUpdateInput; at: string }
  | { type: 'model.updated'; workflowId: string; input: ModelUpdateInput; at: string }
  | { type: 'prompt.revised'; workflowId: string; input: PromptRevisionInput; at: string }
  | { type: 'prompt.rolled_back'; workflowId: string; input: PromptRollbackInput; at: string }
  | { type: 'audit.planned'; workflowId: string; input: AuditPlanInput; at: string }
  | { type: 'audit.packet_updated'; workflowId: string; input: AuditPacketUpdateInput; at: string }

export interface StoredEvent {
  seq: number
  event: WorkflowEvent
}
