import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createWorkflow, updateTask, gateReport } from './lib/core.js'
import { validateTask, parseAction, actionFields, gateIssues, requireValue, fail } from './contract.mjs'
import { validateBackend, complete } from './backend.mjs'
import { acquire, Journal, readJournal, hash } from './journal.mjs'
import { within, readArtifact, writeArtifact, verifyArtifacts } from './files.mjs'

const defaults = { maxSteps: 16, maxToolCalls: 32, maxTokens: 128000, maxOutputTokens: 2000,
  maxContextBytes: 16000, maxMs: 180000, callTimeoutMs: 30000, maxRepairs: 2, maxNoProgress: 3 }
const terminal = new Set(['accepted', 'blocked', 'cancelled', 'budget_exhausted', 'indeterminate'])

function limitsOf(values = {}) {
  requireValue(values && typeof values === 'object' && !Array.isArray(values), 'limits must be an object')
  const limits = { ...defaults, ...values }
  requireValue(Object.keys(values).every(key => Object.hasOwn(defaults, key)), 'unknown limit')
  requireValue(Object.values(limits).every(n => Number.isSafeInteger(n) && n > 0), 'limits must be positive integers')
  requireValue(limits.maxOutputTokens <= limits.maxTokens, 'output limit exceeds total budget')
  return limits
}

function assertSeparation(workspace, directory) {
  mkdirSync(workspace, { recursive: true }); mkdirSync(directory, { recursive: true })
  const root = realpathSync(workspace), stateDir = realpathSync(directory)
  requireValue(!within(root, stateDir) && !within(stateDir, root), 'workspace and trusted state must not contain each other')
  return { root, stateDir }
}

function projection(state, ledger) {
  let workflow = createWorkflow({
    id: state.task.id, sessionId: state.runId, title: state.task.objective,
    objective: state.task.objective, domain: 'bounded-artifact', level: state.task.level ?? 'L1',
    constraints: state.task.constraints ?? [], tasks: state.task.requirements.map(r => ({
      id: r.id, title: r.description, depth: 1, dependsOn: [], generatedPrompt: r.description, claims: [r.id],
    })),
  }, { workspaceCapacity: 6, maxPromptChars: 24000, l4MinimumModels: 0 })
  for (const row of ledger) {
    if (row.status !== 'passed') continue
    workflow = updateTask(workflow, { taskId: row.requirement_id, status: 'verified',
      evidence: [{ id: `e-${row.requirement_id}`, claim: row.requirement_id, artifact: row.artifact, method: row.evidence[0].summary, status: 'passed' }],
      deviations: [], expectedRevision: workflow.revision })
  }
  return gateReport(workflow)
}

export function inspectState(state) {
  const artifacts = Object.fromEntries(state.task.requirements.map(r => {
    try { return [r.check.path, readArtifact(state.workspace, r.check.path).hash] }
    catch { return [r.check.path, null] }
  }))
  const issues = gateIssues(state.task.requirements, state.ledger, state.goalRevision, state.task.conditions ?? [], artifacts)
  if (state.ledger.some(row => row.origin !== 'executor')) issues.push('untrusted-observation')
  const domainGate = projection(state, state.ledger)
  if (!domainGate.passed) issues.push('domain-gate')
  return { mode: 'T3', enforcement: 'bounded-files-only', run_id: state.runId, observation_kind: state.observationKind,
    status: state.status, accepted: state.status === 'accepted' && !issues.length,
    issues: [...new Set(issues)], counters: state.counters, goal_revision: state.goalRevision,
    ledger: state.ledger, last_result: state.lastResult, next_action: state.pending ? 'reconcile-pending-action' : 'request-next-action',
    remaining_tokens: Math.max(0, state.limits.maxTokens - state.counters.tokens),
    domain_gate: domainGate, quality_effectiveness: 'unmeasured' }
}

export function createRun({ task, workspace, directory, backend, limits }) {
  task = validateTask(task); backend = validateBackend(backend); limits = limitsOf(limits)
  const { root, stateDir } = assertSeparation(resolve(workspace), resolve(directory))
  const release = acquire(stateDir)
  try {
    const journal = new Journal(stateDir)
    requireValue(!journal.state, 'run already exists; use resume')
    const state = { schemaVersion: 3, runId: randomUUID(), task, backend, limits, workspace: root,
      goalRevision: 1, status: 'running', observationKind: backend.type === 'fixture' ? 'fixture' : 'real-run',
      createdAt: new Date().toISOString(), deadlineAt: Date.now() + limits.maxMs,
      counters: { modelCalls: 0, toolCalls: 0, tokens: 0, estimatedTokens: false, repairs: 0, noProgress: 0 },
      ledger: [], lastResult: null, pending: null }
    journal.append('run.created', state)
    return inspectState(state)
  } finally { release() }
}

function packetFor(state) {
  const packet = { goal: state.task.objective, goal_revision: state.goalRevision,
    constraints: state.task.constraints ?? [], acceptance: state.task.requirements.map(r => ({ id: r.id, description: r.description, check: r.check })),
    writable_paths: state.task.writablePaths, readable_paths: readable(state),
    valid_evidence: state.ledger.map(r => ({ id: r.requirement_id, status: r.status, artifact_hash: r.artifact_revision })),
    last_result: state.lastResult, allowed_action_fields: actionFields,
    write_rule: 'expected_hash must equal the hash from read; use null only for a new file. Finish triggers fresh verification. Unknown keys are rejected.' }
  let serialized = JSON.stringify(packet)
  if (Buffer.byteLength(serialized) > state.limits.maxContextBytes) {
    packet.last_result = { summary: 'Previous result omitted from context; read the relevant artifact again. Original retained in journal.' }
    serialized = JSON.stringify(packet)
  }
  if (Buffer.byteLength(serialized) > state.limits.maxContextBytes) fail('CONTEXT_LIMIT', 'goal and acceptance exceed context budget; split the task')
  return serialized
}

function readable(state) {
  return [...new Set([...state.task.writablePaths, ...(state.task.readablePaths ?? []), ...state.task.requirements.map(r => r.check.path)])]
}

function recordFailure(state, journal, code) {
  state.counters.repairs++
  state.counters.noProgress++
  state.lastResult = { error: code, instruction: 'Correct only the invalid action; do not change acceptance or permissions.' }
  if (state.counters.repairs >= state.limits.maxRepairs || state.counters.noProgress >= state.limits.maxNoProgress) state.status = 'blocked'
  journal.append('action.rejected', state, { code })
}

function recoverPending(state, journal) {
  if (!state.pending) return
  const pending = state.pending
  if (pending.action?.action === 'write') {
    let current
    try { current = readArtifact(state.workspace, pending.action.path) } catch { current = undefined }
    if (current && current.hash === pending.afterHash) {
      state.lastResult = { recovered: true, path: pending.action.path, hash: current.hash }
      state.pending = null
      journal.append('tool.reconciled', state, { operationId: pending.operationId, outcome: 'already-applied' })
    } else if (current && current.hash === pending.action.expected_hash) {
      // Idempotent file replacement is safe to repeat with the recorded precondition.
      const result = writeArtifact(state.workspace, pending.action.path, pending.action.content, pending.action.expected_hash)
      state.pending = null; state.lastResult = { ...result, recovered: true }
      journal.append('tool.reconciled', state, { operationId: pending.operationId, outcome: 'applied-after-check' })
    } else {
      state.status = 'indeterminate'; state.lastResult = { error: 'PENDING_WRITE_CONFLICT', path: pending.action.path }
      journal.append('run.indeterminate', state)
    }
  } else {
    // A lost model response may still have been billed. Keep the reserved budget.
    state.pending = null; state.counters.estimatedTokens = true
    state.lastResult = { recovered: true, detail: 'Unfinished model/read step discarded; reserved budget retained.' }
    journal.append('step.reconciled', state)
  }
}

export async function run(directory, { stopAfter = Infinity, signal, afterPrepared, input } = {}) {
  requireValue(stopAfter === Infinity || (Number.isSafeInteger(stopAfter) && stopAfter > 0), 'stopAfter must be a positive integer')
  requireValue(input === undefined || (typeof input === 'string' && input.trim() && Buffer.byteLength(input) <= 4000), 'input must be nonempty text up to 4000 bytes')
  directory = realpathSync(resolve(directory))
  const release = acquire(directory)
  try {
    const journal = new Journal(directory)
    const state = journal.state
    if (!state) fail('NOT_FOUND', 'run does not exist')
    validateTask(state.task); limitsOf(state.limits); validateBackend(state.backend)
    assertSeparation(state.workspace, directory)
    if (terminal.has(state.status)) return inspectState(state)
    if (state.status === 'needs_input' && input === undefined) return inspectState(state)
    if (input !== undefined) { state.lastResult = { user_input: input }; journal.append('user.replied', state) }
    if (signal?.aborted || existsSync(join(directory, 'cancel.request'))) {
      state.status = 'cancelled'; journal.append('run.cancelled', state); return inspectState(state)
    }
    if (Date.now() >= state.deadlineAt) {
      state.status = 'budget_exhausted'; journal.append('run.budget_exhausted', state); return inspectState(state)
    }
    recoverPending(state, journal)
    if (terminal.has(state.status)) return inspectState(state)
    state.status = 'running'
    let executed = 0
    while (executed < stopAfter && !terminal.has(state.status)) {
      if (signal?.aborted || existsSync(join(directory, 'cancel.request'))) {
        state.status = 'cancelled'; journal.append('run.cancelled', state); break
      }
      if (Date.now() >= state.deadlineAt || state.counters.modelCalls >= state.limits.maxSteps || state.counters.toolCalls >= state.limits.maxToolCalls) {
        state.status = 'budget_exhausted'; journal.append('run.budget_exhausted', state); break
      }
      let packet
      try { packet = packetFor(state) } catch (error) { recordFailure(state, journal, error.code); state.status = 'blocked'; journal.append('run.blocked', state); break }
      // UTF-8 bytes conservatively reserve input token space; include fixed system overhead.
      const reservation = Buffer.byteLength(packet) + 256 + state.limits.maxOutputTokens
      if (state.counters.tokens + reservation > state.limits.maxTokens) {
        state.status = 'budget_exhausted'; journal.append('run.budget_exhausted', state); break
      }
      const tokensBefore = state.counters.tokens, index = state.counters.modelCalls
      state.counters.modelCalls++; state.counters.tokens += reservation
      state.pending = { kind: 'model', reservation }
      journal.append('model.requested', state, { context: packet, backend: { type: state.backend.type, provider: state.backend.provider, model: state.backend.model } })
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(new Error('MODEL_TIMEOUT')), Math.min(state.limits.callTimeoutMs, Math.max(1, state.deadlineAt - Date.now())))
      const cancelWatch = setInterval(() => { if (signal?.aborted || existsSync(join(directory, 'cancel.request'))) controller.abort(new Error('CANCELLED')) }, 100)
      let response, action
      try {
        response = await complete(state.backend, packet, index, { signal: controller.signal, maxTokens: state.limits.maxOutputTokens })
        state.counters.tokens = tokensBefore + (response.usage ?? reservation)
        if (response.usage === null) state.counters.estimatedTokens = true
        state.pending = null
        journal.append('model.responded', state, { response: response.text.slice(0, 40000), usage: response.usage })
        if (state.counters.tokens > state.limits.maxTokens) { state.status = 'budget_exhausted'; journal.append('run.budget_exhausted', state); break }
        requireValue(typeof response.text === 'string' && Buffer.byteLength(response.text) <= 40000, 'model response exceeds 40000 bytes')
        action = parseAction(response.text)
      } catch (error) {
        state.pending = null; state.counters.estimatedTokens = true
        if (signal?.aborted || existsSync(join(directory, 'cancel.request'))) { state.status = 'cancelled'; journal.append('run.cancelled', state); break }
        recordFailure(state, journal, error.code ?? (controller.signal.aborted ? 'MODEL_TIMEOUT' : 'INVALID_RESPONSE'))
        executed++; continue
      } finally { clearTimeout(timeout); clearInterval(cancelWatch) }
      if (signal?.aborted || existsSync(join(directory, 'cancel.request'))) { state.status = 'cancelled'; journal.append('run.cancelled', state); break }
      if (Date.now() >= state.deadlineAt) { state.status = 'budget_exhausted'; journal.append('run.budget_exhausted', state); break }
      const before = JSON.stringify(state.ledger.map(r => [r.requirement_id, r.status, r.artifact_revision]))
      try {
        state.counters.toolCalls++
        if (action.action === 'read') {
          requireValue(readable(state).includes(action.path), 'read path not allowed')
          state.lastResult = { path: action.path, ...readArtifact(state.workspace, action.path) }
        } else if (action.action === 'write') {
          requireValue(state.task.writablePaths.includes(action.path), 'write path not allowed')
          const current = readArtifact(state.workspace, action.path)
          requireValue(current.hash === action.expected_hash, 'artifact changed since read')
          state.pending = { kind: 'tool', operationId: randomUUID(), action, afterHash: hash(Buffer.from(action.content)) }
          // Invalidate before any side effect, including a crash during replacement.
          state.ledger = state.ledger.filter(row => row.artifact !== action.path)
          journal.append('tool.prepared', state)
          if (afterPrepared) await afterPrepared(structuredClone(state))
          state.lastResult = writeArtifact(state.workspace, action.path, action.content, action.expected_hash)
          state.pending = null
        } else if (action.action === 'verify' || action.action === 'finish') {
          state.ledger = verifyArtifacts(state)
          const inspection = inspectState(state)
          state.lastResult = { verification: state.ledger, issues: inspection.issues }
          if (action.action === 'finish' && !inspection.issues.length) state.status = 'accepted'
        } else {
          state.status = 'needs_input'; state.lastResult = { reason: action.reason }
        }
        const changed = before !== JSON.stringify(state.ledger.map(r => [r.requirement_id, r.status, r.artifact_revision]))
        const fingerprint = hash(JSON.stringify({ action, result: state.lastResult }))
        const repeated = (state.recentActions ?? []).includes(fingerprint)
        state.counters.noProgress = changed || (!repeated && ['read', 'write'].includes(action.action)) ? 0 : state.counters.noProgress + 1
        state.recentActions = [...(state.recentActions ?? []), fingerprint].slice(-8)
        if (state.status === 'running' && state.counters.noProgress >= state.limits.maxNoProgress) state.status = 'blocked'
        journal.append('tool.completed', state, { action: action.action })
      } catch (error) {
        if (state.pending?.kind === 'tool') {
          // Preserve uncertainty; never pretend a failed write was rolled back.
          journal.append('tool.interrupted', state, { code: error.code ?? 'WRITE_INTERRUPTED' })
          throw error
        }
        recordFailure(state, journal, error.code ?? 'TOOL_ERROR')
      }
      executed++
      if (state.status === 'needs_input') break
    }
    if (state.status === 'running' && executed >= stopAfter) { state.status = 'paused'; journal.append('run.paused', state) }
    return inspectState(state)
  } finally { release() }
}

export function inspect(directory) {
  const journal = readJournal(resolve(directory))
  if (!journal.state) fail('NOT_FOUND', 'run does not exist')
  return { ...inspectState(journal.state), truncated_tail: journal.tail }
}

export function reviseGoal(directory, task, expectedRevision) {
  directory = realpathSync(resolve(directory)); task = validateTask(task)
  const release = acquire(directory)
  try {
    const journal = new Journal(directory), state = journal.state
    requireValue(state && !state.pending && state.status !== 'running', 'pause before revising the goal')
    requireValue(state.goalRevision === expectedRevision, 'goal revision conflict')
    requireValue(JSON.stringify(task.writablePaths) === JSON.stringify(state.task.writablePaths) && JSON.stringify(task.readablePaths ?? []) === JSON.stringify(state.task.readablePaths ?? []), 'a goal revision cannot widen tool permissions; start a separately authorized run')
    requireValue(task.requirements.every(r => readable(state).includes(r.check.path)), 'new check paths cannot widen read permissions')
    state.task = task; state.goalRevision++; state.ledger = []; state.status = 'paused'; state.lastResult = { goal_changed: true }
    journal.append('goal.revised', state)
    return inspectState(state)
  } finally { release() }
}
