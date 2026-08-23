import type {
  AuditFinding,
  AuditHealth,
  AuditHealthCheck,
  AuditPacket,
  AuditPacketStatus,
  AuditPacketUpdateInput,
  AuditPipeline,
  AuditPlanInput,
  AuditRole,
  ControlLevel,
  ControlTask,
  Workflow,
} from './types.ts'

export class AuditError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'AuditError'
  }
}

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
const FORBIDDEN_CONTEXT = ['expected_answer', 'primary_diagnosis', 'proposed_fix', 'peer_outputs']
const LEVEL_BUDGET: Record<ControlLevel, number> = { L1: 0, L2: 1, L3: 2, L4: 3 }
const ROLE_OBJECTIVES: Record<AuditRole, { objective: string; failures: string[] }> = {
  'goal-spec': {
    objective: 'Challenge goal, acceptance, and constraint consistency without guessing the primary answer.',
    failures: ['goal or acceptance is ambiguous', 'constraints conflict', 'success cannot be observed'],
  },
  measurement: {
    objective: 'Challenge whether evidence and measurement can support each material claim.',
    failures: ['evidence is missing or stale', 'method does not test the claim', 'artifact cannot be inspected'],
  },
  'integration-regression': {
    objective: 'Challenge cross-task integration and regression exposure at the system boundary.',
    failures: ['dependency effect is untested', 'local success hides a system regression', 'rollback path is absent'],
  },
  environment: {
    objective: 'Challenge environment, toolchain, and reproducibility assumptions.',
    failures: ['environment differs from the claimed target', 'result is not reproducible', 'external dependency drift is unbounded'],
  },
}

const LEGAL_TRANSITIONS: Record<AuditPacketStatus, ReadonlySet<AuditPacketStatus>> = {
  planned: new Set(['dispatched', 'running', 'completed', 'failed', 'cancelled']),
  dispatched: new Set(['running', 'completed', 'failed', 'cancelled']),
  running: new Set(['completed', 'failed', 'cancelled']),
  completed: new Set(),
  failed: new Set(['dispatched', 'running']),
  cancelled: new Set(['dispatched', 'running']),
}

function assert(condition: unknown, message: string, code: string): asserts condition {
  if (!condition) throw new AuditError(message, code)
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator
}

function roleSelection(input: AuditPlanInput, level: ControlLevel): AuditRole[] {
  const cap = LEVEL_BUDGET[level]
  assert(cap > 0, 'L1 has no subagent audit budget', 'AUDIT_LEVEL_BUDGET')
  const requested = [...new Set(input.requestedRoles)]
  if (requested.length > 0) {
    assert(requested.length <= cap, `${level} audit budget allows at most ${cap} roles`, 'AUDIT_LEVEL_BUDGET')
    return requested
  }
  const selected: AuditRole[] = []
  const add = (role: AuditRole): void => { if (!selected.includes(role)) selected.push(role) }
  if (input.goalConflict) add('goal-spec')
  for (const signal of input.riskSignals) {
    if (signal === 'B') add('measurement')
    if (signal === 'D') add('integration-regression')
    if (signal === 'A') add('measurement')
    if (signal === 'C') add('environment')
  }
  if (selected.length === 0) add('measurement')
  return selected.slice(0, cap)
}

function list(title: string, values: string[]): string {
  return `${title}:\n${values.length === 0 ? '- none supplied' : values.map(value => `- ${value}`).join('\n')}`
}

function renderPrompt(workflow: Workflow, task: ControlTask, input: AuditPlanInput, role: AuditRole): string {
  const roleSpec = ROLE_OBJECTIVES[role]
  return [
    `You are the read-only ${role} audit view for Cybersyn pipeline ${input.pipelineId}.`,
    'Do not mutate files, workflow state, prompts, evidence, or external systems. Do not contact the user.',
    `Objective: ${roleSpec.objective}`,
    `Workflow objective: ${workflow.objective}`,
    `Task: ${task.id} — ${task.title}`,
    `Effective task prompt r${task.promptRevision}: ${task.effectivePrompt}`,
    list('Acceptance', input.acceptance),
    list('Constraints', workflow.constraints),
    list('Artifact references', input.artifactRefs),
    list('Evidence references', input.evidenceRefs),
    list('Failure criteria', roleSpec.failures),
    `Excluded context: ${FORBIDDEN_CONTEXT.join(', ')}. Do not request or infer those fields.`,
    `Return at most ${input.maxFindings} Finding objects. Each Finding must contain id, severity, summary, evidenceRef, and recommendation. Use an empty array when no evidence-backed finding exists.`,
  ].join('\n\n')
}

function validateThresholds(input: AuditPlanInput): void {
  const thresholds = input.thresholds
  assert(thresholds.minimumCompletionRatio >= 0 && thresholds.minimumCompletionRatio <= 1, 'minimumCompletionRatio must be within 0..1', 'INVALID_AUDIT_THRESHOLD')
  assert(thresholds.maximumFailureRatio >= 0 && thresholds.maximumFailureRatio <= 1, 'maximumFailureRatio must be within 0..1', 'INVALID_AUDIT_THRESHOLD')
  assert(thresholds.maximumQualityDrop >= 0 && thresholds.maximumQualityDrop <= 1, 'maximumQualityDrop must be within 0..1', 'INVALID_AUDIT_THRESHOLD')
  if (thresholds.maximumTotalTokens !== undefined) assert(Number.isSafeInteger(thresholds.maximumTotalTokens) && thresholds.maximumTotalTokens > 0, 'maximumTotalTokens must be a positive integer', 'INVALID_AUDIT_THRESHOLD')
  if (thresholds.maximumDurationMs !== undefined) assert(Number.isSafeInteger(thresholds.maximumDurationMs) && thresholds.maximumDurationMs > 0, 'maximumDurationMs must be a positive integer', 'INVALID_AUDIT_THRESHOLD')
  if (thresholds.baselineQualityScore !== undefined) assert(thresholds.baselineQualityScore >= 0 && thresholds.baselineQualityScore <= 1, 'baselineQualityScore must be within 0..1', 'INVALID_AUDIT_THRESHOLD')
  if (input.qualityRegressionRequired) assert(thresholds.baselineQualityScore !== undefined, 'A required quality regression gate needs baselineQualityScore', 'MISSING_AUDIT_BASELINE')
}

export function assembleAuditPipeline(workflow: Workflow, input: AuditPlanInput, at: string): AuditPipeline {
  assert(ID_PATTERN.test(input.pipelineId), 'Audit pipeline id must be a portable 1-64 character identifier', 'INVALID_AUDIT_ID')
  assert(!workflow.auditPipelines.some(item => item.id === input.pipelineId), `Audit pipeline ${input.pipelineId} already exists`, 'AUDIT_PIPELINE_EXISTS')
  assert(input.trigger.trim().length > 0, 'Audit trigger is required', 'INVALID_AUDIT_TRIGGER')
  const task = workflow.tasks[input.taskId]
  assert(task !== undefined, `Unknown audit task: ${input.taskId}`, 'UNKNOWN_TASK')
  assert(Number.isSafeInteger(input.maxFindings) && input.maxFindings > 0 && input.maxFindings <= 20, 'maxFindings must be within 1..20', 'INVALID_AUDIT_LIMIT')
  assert(input.acceptance.every(item => item.trim().length > 0), 'Acceptance entries cannot be blank', 'INVALID_AUDIT_INPUT')
  assert(input.artifactRefs.every(item => item.trim().length > 0), 'Artifact references cannot be blank', 'INVALID_AUDIT_INPUT')
  assert(input.evidenceRefs.every(item => item.trim().length > 0), 'Evidence references cannot be blank', 'INVALID_AUDIT_INPUT')
  assert(!(input.executionMode === 'host-serial-fallback' && input.contextIndependent), 'Serial fallback cannot claim context independence', 'INVALID_AUDIT_ISOLATION')
  validateThresholds(input)
  const roles = roleSelection(input, workflow.level)
  const packets: AuditPacket[] = roles.map((role, index) => ({
    id: `${input.pipelineId}.${index + 1}-${role}`,
    role,
    taskId: task.id,
    taskPromptRevision: task.promptRevision,
    authority: 'read-only',
    excludedContext: [...FORBIDDEN_CONTEXT],
    objective: ROLE_OBJECTIVES[role].objective,
    failureCriteria: clone(ROLE_OBJECTIVES[role].failures),
    maxFindings: input.maxFindings,
    prompt: renderPrompt(workflow, task, input, role),
    status: 'planned',
    attempt: 1,
    harnessRunId: '',
    findings: [],
    error: '',
    lifecycle: [{ status: 'planned', attempt: 1, harnessRunId: '', at, detail: 'PromptPacket assembled; no subagent was started.', findingCount: 0 }],
  }))
  return {
    id: input.pipelineId,
    trigger: input.trigger,
    executionMode: input.executionMode,
    contextIndependent: input.contextIndependent,
    requiredForGate: input.requiredForGate,
    qualityRegressionRequired: input.qualityRegressionRequired,
    expectedRoles: roles,
    thresholds: clone(input.thresholds),
    packets,
    createdAt: at,
    updatedAt: at,
  }
}

function validateFinding(finding: AuditFinding): void {
  assert(ID_PATTERN.test(finding.id), `Invalid audit finding id: ${finding.id}`, 'INVALID_AUDIT_FINDING')
  assert(finding.summary.trim().length > 0, `Finding ${finding.id} needs a summary`, 'INVALID_AUDIT_FINDING')
  assert(finding.evidenceRef.trim().length > 0, `Finding ${finding.id} needs an evidence reference`, 'INVALID_AUDIT_FINDING')
  assert(finding.recommendation.trim().length > 0, `Finding ${finding.id} needs a recommendation`, 'INVALID_AUDIT_FINDING')
}

export function applyAuditPacketUpdate(pipeline: AuditPipeline, input: AuditPacketUpdateInput, at: string): AuditPipeline {
  const next = clone(pipeline)
  const packet = next.packets.find(item => item.id === input.packetId)
  assert(packet !== undefined, `Unknown audit packet: ${input.packetId}`, 'UNKNOWN_AUDIT_PACKET')
  assert(input.harnessRunId.trim().length > 0, 'Harness run id is required once a packet leaves planned state', 'INVALID_AUDIT_RUN')
  assert(LEGAL_TRANSITIONS[packet.status].has(input.status), `Illegal audit transition: ${packet.status} -> ${input.status}`, 'ILLEGAL_AUDIT_TRANSITION')

  const retry = (packet.status === 'failed' || packet.status === 'cancelled') && (input.status === 'dispatched' || input.status === 'running')
  if (retry) {
    assert(packet.attempt === 1, `Audit packet ${packet.id} already used its single retry`, 'AUDIT_RETRY_EXHAUSTED')
    packet.attempt = 2
    packet.findings = []
    packet.totalTokens = undefined
    packet.durationMs = undefined
    packet.qualityScore = undefined
    packet.error = ''
  } else if (packet.harnessRunId.length > 0) {
    assert(packet.harnessRunId === input.harnessRunId, 'Harness run id cannot change within one audit attempt', 'AUDIT_RUN_MISMATCH')
  }

  assert(input.findings.length <= packet.maxFindings, `Audit packet ${packet.id} exceeds maxFindings`, 'AUDIT_FINDING_LIMIT')
  const findingIds = new Set<string>()
  for (const finding of input.findings) {
    validateFinding(finding)
    assert(!findingIds.has(finding.id), `Duplicate audit finding id: ${finding.id}`, 'DUPLICATE_AUDIT_FINDING')
    findingIds.add(finding.id)
  }
  if (input.totalTokens !== undefined) assert(Number.isSafeInteger(input.totalTokens) && input.totalTokens >= 0, 'totalTokens must be a non-negative integer', 'INVALID_AUDIT_METRIC')
  if (input.durationMs !== undefined) assert(Number.isSafeInteger(input.durationMs) && input.durationMs >= 0, 'durationMs must be a non-negative integer', 'INVALID_AUDIT_METRIC')
  if (input.qualityScore !== undefined) assert(input.qualityScore >= 0 && input.qualityScore <= 1, 'qualityScore must be within 0..1', 'INVALID_AUDIT_METRIC')
  if (input.status === 'failed') assert(input.error.trim().length > 0, 'A failed audit packet needs an error', 'INVALID_AUDIT_RUN')

  packet.status = input.status
  packet.harnessRunId = input.harnessRunId
  packet.findings = clone(input.findings)
  packet.totalTokens = input.totalTokens
  packet.durationMs = input.durationMs
  packet.qualityScore = input.qualityScore
  packet.error = input.error
  packet.lifecycle.push({
    status: input.status,
    attempt: packet.attempt,
    harnessRunId: input.harnessRunId,
    at,
    detail: input.detail,
    findingCount: input.findings.length,
    totalTokens: input.totalTokens,
    durationMs: input.durationMs,
    qualityScore: input.qualityScore,
  })
  next.updatedAt = at
  return next
}

function check(id: string, status: AuditHealthCheck['status'], detail: string): AuditHealthCheck {
  return { id, status, detail }
}

export function auditHealth(workflow: Workflow, pipeline: AuditPipeline): AuditHealth {
  const checks: AuditHealthCheck[] = []
  const completed = pipeline.packets.filter(packet => packet.status === 'completed')
  const terminal = pipeline.packets.every(packet => packet.status === 'completed' || packet.status === 'failed' || packet.status === 'cancelled')
  const completedRoleRatio = ratio(new Set(completed.map(packet => packet.role)).size, pipeline.expectedRoles.length)
  const terminalEntries = pipeline.packets.flatMap(packet => packet.lifecycle.filter(entry => entry.status === 'completed' || entry.status === 'failed' || entry.status === 'cancelled'))
  const failureEntries = terminalEntries.filter(entry => entry.status === 'failed' || entry.status === 'cancelled')
  const failureRatio = ratio(failureEntries.length, terminalEntries.length)

  checks.push(check(
    'context_independence',
    pipeline.contextIndependent ? 'pass' : 'fail',
    pipeline.contextIndependent ? 'Host declared independent audit context.' : 'Serial/shared-context fallback cannot provide an independent second view.',
  ))

  const stale = pipeline.packets.filter(packet => workflow.tasks[packet.taskId]?.promptRevision !== packet.taskPromptRevision)
  checks.push(check(
    'prompt_freshness',
    stale.length === 0 ? 'pass' : 'fail',
    stale.length === 0 ? 'Every PromptPacket targets the current task prompt revision.' : `Stale packets: ${stale.map(packet => packet.id).join(', ')}`,
  ))

  checks.push(check(
    'role_completion',
    terminal ? (completedRoleRatio >= pipeline.thresholds.minimumCompletionRatio ? 'pass' : 'fail') : 'unmeasured',
    terminal
      ? `${completed.length}/${pipeline.expectedRoles.length} roles completed; threshold ${pipeline.thresholds.minimumCompletionRatio}.`
      : `${completed.length}/${pipeline.expectedRoles.length} roles completed; pipeline still open.`,
  ))
  checks.push(check(
    'run_failure_ratio',
    terminal ? (failureRatio <= pipeline.thresholds.maximumFailureRatio ? 'pass' : 'fail') : 'unmeasured',
    terminal
      ? `${failureEntries.length}/${terminalEntries.length} terminal attempts failed or cancelled; threshold ${pipeline.thresholds.maximumFailureRatio}.`
      : 'Failure ratio is not final while packets are open.',
  ))

  const ungrounded = completed.flatMap(packet => packet.findings.filter(finding => finding.evidenceRef.trim().length === 0).map(finding => `${packet.id}/${finding.id}`))
  checks.push(check(
    'evidence_grounding',
    terminal ? (ungrounded.length === 0 ? 'pass' : 'fail') : 'unmeasured',
    terminal ? (ungrounded.length === 0 ? 'Every reported finding has an evidence reference.' : `Ungrounded findings: ${ungrounded.join(', ')}`) : 'Grounding is evaluated after terminal settlement.',
  ))

  const tokenValues = terminalEntries.map(entry => entry.totalTokens)
  const totalTokens = tokenValues.every(value => value !== undefined) ? (tokenValues as number[]).reduce((sum, value) => sum + value, 0) : undefined
  if (pipeline.thresholds.maximumTotalTokens === undefined) {
    checks.push(check('token_budget', 'not-applicable', 'No token budget threshold configured.'))
  } else if (!terminal || totalTokens === undefined) {
    checks.push(check('token_budget', 'unmeasured', 'Terminal token usage is incomplete.'))
  } else {
    checks.push(check('token_budget', totalTokens <= pipeline.thresholds.maximumTotalTokens ? 'pass' : 'fail', `${totalTokens}/${pipeline.thresholds.maximumTotalTokens} total tokens.`))
  }

  const durationValues = terminalEntries.map(entry => entry.durationMs)
  const durationMs = durationValues.every(value => value !== undefined) ? (durationValues as number[]).reduce((sum, value) => sum + value, 0) : undefined
  if (pipeline.thresholds.maximumDurationMs === undefined) {
    checks.push(check('duration_budget', 'not-applicable', 'No duration threshold configured.'))
  } else if (!terminal || durationMs === undefined) {
    checks.push(check('duration_budget', 'unmeasured', 'Terminal duration measurements are incomplete.'))
  } else {
    checks.push(check('duration_budget', durationMs <= pipeline.thresholds.maximumDurationMs ? 'pass' : 'fail', `${durationMs}/${pipeline.thresholds.maximumDurationMs} ms cumulative duration.`))
  }

  const qualityValues = completed.map(packet => packet.qualityScore)
  const qualityScore = qualityValues.length > 0 && qualityValues.every(value => value !== undefined)
    ? (qualityValues as number[]).reduce((sum, value) => sum + value, 0) / qualityValues.length
    : undefined
  if (pipeline.thresholds.baselineQualityScore === undefined) {
    checks.push(check('quality_regression', 'not-applicable', 'No external baseline supplied; effectiveness remains unmeasured.'))
  } else if (!terminal || qualityScore === undefined) {
    checks.push(check('quality_regression', 'unmeasured', 'A baseline exists, but terminal quality scores are incomplete.'))
  } else {
    const drop = pipeline.thresholds.baselineQualityScore - qualityScore
    checks.push(check('quality_regression', drop <= pipeline.thresholds.maximumQualityDrop ? 'pass' : 'fail', `Observed ${qualityScore.toFixed(3)} vs baseline ${pipeline.thresholds.baselineQualityScore.toFixed(3)}; drop ${drop.toFixed(3)} (max ${pipeline.thresholds.maximumQualityDrop}).`))
  }

  const operationalChecks = checks.filter(item => item.id !== 'quality_regression' && item.status !== 'not-applicable')
  const operationalStatus = operationalChecks.some(item => item.status === 'fail')
    ? 'degraded'
    : operationalChecks.some(item => item.status === 'unmeasured') ? 'unmeasured' : 'healthy'
  const qualityCheck = checks.find(item => item.id === 'quality_regression')!
  const effectivenessStatus = qualityCheck.status === 'fail' ? 'degraded' : qualityCheck.status === 'pass' ? 'non-degraded' : 'unmeasured'

  return { operationalStatus, effectivenessStatus, completedRoleRatio, failureRatio, totalTokens, durationMs, qualityScore, checks }
}
