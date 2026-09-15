import { readFileSync, existsSync } from 'node:fs'

const policyURL = [new URL('../protocol/control-policy.json', import.meta.url), new URL('../../protocol/control-policy.json', import.meta.url)].find(existsSync)
if (!policyURL) throw new Error('Missing bundled control policy')
export const policy = JSON.parse(readFileSync(policyURL, 'utf8'))
export const fail = (code, message) => { const error = new Error(message); error.code = code; throw error }
export const requireValue = (value, message) => { if (!value) fail('INVALID_INPUT', message) }
export const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const hasEvidence = value => Array.isArray(value) && value.length > 0 && value.every(e => isObject(e) && ['source', 'summary', 'captured_at'].every(k => typeof e[k] === 'string' && e[k].trim()) && ['test', 'inspection', 'source', 'user-confirmation'].includes(e.kind) && Number.isFinite(Date.parse(e.captured_at)))

export function gateIssues(requirements, ledger, goalRevision, conditions = [], artifactRevisions = null) {
  if (!Array.isArray(requirements) || !requirements.length) return ['nonempty-acceptance']
  const ids = requirements.map(r => isObject(r) ? r.id : r)
  if (ids.some(id => typeof id !== 'string' || !id.trim()) || new Set(ids).size !== ids.length) return ['invalid-acceptance']
  if (!Array.isArray(ledger)) return ['invalid-ledger']
  const issues = [], rows = ledger.filter(isObject), rowIds = rows.map(r => r.requirement_id)
  if (rows.length !== ledger.length || rowIds.length !== ids.length || new Set(rowIds).size !== ids.length || rowIds.some(id => !ids.includes(id))) issues.push('complete-coverage')
  for (const row of rows) {
    if (row.status !== 'passed' || !hasEvidence(row.evidence)) issues.push('all-passed')
    if (row.goal_revision !== goalRevision || row.stale) issues.push('current-goal')
    if (artifactRevisions !== null && (typeof row.artifact !== 'string' || !Object.hasOwn(artifactRevisions, row.artifact) || typeof row.artifact_revision !== 'string' || row.artifact_revision !== artifactRevisions[row.artifact])) issues.push('current-artifact')
    for (const d of (row.deviations === undefined ? [] : Array.isArray(row.deviations) ? row.deviations : [null])) {
      if (!isObject(d) || !policy.deviationLabels.includes(d.type) || policy.blockingLabels.includes(d.type) || policy.blockingSeverities.includes(d.severity ?? 'medium')) issues.push('no-blocking-deviation')
    }
  }
  const conditionIds = new Set()
  if (!Array.isArray(conditions) || conditions.some(c => {
    if (!isObject(c) || typeof c.id !== 'string' || !c.id.trim() || conditionIds.has(c.id)) return true
    conditionIds.add(c.id)
    return (c.required !== undefined && typeof c.required !== 'boolean') || !policy.conditionStates.includes(c.status) || ((c.required ?? true) && (c.status !== 'confirmed' || !hasEvidence(c.evidence)))
  })) issues.push('required-conditions-confirmed')
  return [...new Set(issues)]
}

export function selectSupport(gaps = [], requiredRuntime = false, available = ['T1']) {
  requireValue(typeof requiredRuntime === 'boolean', 'requiredRuntime must be boolean')
  requireValue(Array.isArray(gaps) && gaps.every(g => [...policy.toolGaps, ...policy.harnessGaps].includes(g)), 'unknown capability gap')
  requireValue(Array.isArray(available) && available.every(m => ['T1', 'T2', 'T3'].includes(m)), 'invalid available modes')
  const recommended = requiredRuntime || gaps.some(g => policy.harnessGaps.includes(g)) ? 'T3' : gaps.length ? 'T2' : 'T1'
  return { recommended, available: available.includes(recommended), status: available.includes(recommended) ? 'ready' : 'capability-missing', gaps, automatic_start: false }
}

export function portablePath(path) {
  requireValue(typeof path === 'string' && path.length > 0 && path.length <= 240, 'invalid path')
  requireValue(!path.includes('\\') && !path.includes(':') && !path.startsWith('/') && !/[\x00-\x1f]/.test(path), 'path must be a portable relative path')
  requireValue(path.split('/').every(part => part && !['.', '..'].includes(part) && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)), 'unsafe path component')
  return path
}

export function validateTask(task) {
  requireValue(isObject(task), 'task must be an object')
  requireValue(typeof task.id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(task.id), 'invalid task id')
  requireValue(typeof task.objective === 'string' && task.objective.trim() && task.objective.length <= 4000, 'nonempty objective required, at most 4000 characters')
  requireValue(Array.isArray(task.requirements) && task.requirements.length > 0 && task.requirements.length <= 20, '1-20 requirements required')
  requireValue(Array.isArray(task.writablePaths) && task.writablePaths.length <= 30, 'writablePaths must be an explicit array')
  requireValue(task.readablePaths === undefined || Array.isArray(task.readablePaths), 'readablePaths must be an array')
  requireValue(task.constraints === undefined || (Array.isArray(task.constraints) && task.constraints.every(c => typeof c === 'string')), 'constraints must be an array of strings')
  for (const path of [...task.writablePaths, ...(task.readablePaths ?? [])]) portablePath(path)
  const ids = new Set()
  for (const r of task.requirements) {
    requireValue(isObject(r) && typeof r.id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(r.id) && !ids.has(r.id), 'invalid or duplicate requirement id')
    ids.add(r.id)
    requireValue(typeof r.description === 'string' && r.description.trim(), 'requirement description required')
    requireValue(isObject(r.check), 'each requirement needs a deterministic check')
    portablePath(r.check.path)
    requireValue(['text-equals', 'json-equals', 'sha256'].includes(r.check.kind), 'unsupported check kind; use a host with the required verifier')
    requireValue(Object.hasOwn(r.check, 'expected'), 'check expected value required')
    if (r.check.kind !== 'json-equals') requireValue(typeof r.check.expected === 'string', 'expected must be text')
    if (r.check.kind === 'sha256') requireValue(/^[a-f0-9]{64}$/.test(r.check.expected), 'expected SHA-256 must have 64 lowercase hex characters')
  }
  requireValue(task.level === undefined || Object.hasOwn(policy.defaultRounds, task.level), 'invalid complexity level')
  requireValue(task.conditions === undefined || Array.isArray(task.conditions), 'conditions must be an array')
  requireValue(Buffer.byteLength(JSON.stringify(task)) <= 24000, 'task specification too large; decompose it')
  return structuredClone(task)
}

export const actionFields = {
  read: ['action', 'path'], write: ['action', 'path', 'content', 'expected_hash'],
  verify: ['action'], finish: ['action'], need_input: ['action', 'reason'],
}
export function parseAction(value) {
  const action = typeof value === 'string' ? JSON.parse(value) : value
  requireValue(isObject(action) && Object.hasOwn(actionFields, action.action), 'unknown action')
  requireValue(Object.keys(action).every(key => actionFields[action.action].includes(key)), 'unexpected action field')
  if (['read', 'write'].includes(action.action)) portablePath(action.path)
  if (action.action === 'write') {
    requireValue(typeof action.content === 'string' && Buffer.byteLength(action.content) <= 32768, 'write content exceeds 32 KiB or is not text')
    requireValue(action.expected_hash === null || (typeof action.expected_hash === 'string' && /^[a-f0-9]{64}$/.test(action.expected_hash)), 'write requires expected_hash from read, or null for a new file')
  }
  if (action.action === 'need_input') requireValue(typeof action.reason === 'string' && action.reason.trim(), 'reason required')
  return action
}
