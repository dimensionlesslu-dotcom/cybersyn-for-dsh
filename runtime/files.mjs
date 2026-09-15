import { lstatSync, existsSync, realpathSync, readFileSync, mkdirSync, openSync, writeSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'node:fs'
import { resolve, relative, dirname, join, sep, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { portablePath, fail } from './contract.mjs'
import { hash } from './journal.mjs'

export const within = (root, target) => { const r = relative(root, target); return r === '' || (!r.startsWith('..' + sep) && r !== '..' && !isAbsolute(r)) }

export function checkedPath(root, name) {
  portablePath(name)
  const target = resolve(root, name)
  if (!within(root, target)) fail('PATH_DENIED', 'outside workspace')
  let current = root
  for (const part of name.split('/')) {
    current = join(current, part)
    if (existsSync(current)) {
      const info = lstatSync(current)
      if (info.isSymbolicLink() || !within(root, realpathSync(current))) fail('PATH_DENIED', 'links are not allowed')
    }
  }
  return target
}

export function readArtifact(root, name) {
  const path = checkedPath(root, name)
  if (!existsSync(path)) return { content: null, hash: null }
  const info = lstatSync(path)
  if (!info.isFile() || info.size > 32768) fail('FILE_LIMIT', 'only regular files up to 32 KiB are supported')
  const bytes = readFileSync(path)
  return { content: bytes.toString('utf8'), hash: hash(bytes) }
}

export function writeArtifact(root, name, content, expectedHash) {
  const before = readArtifact(root, name)
  if (before.hash !== expectedHash) fail('ARTIFACT_CONFLICT', 'file changed since read; read it again')
  const target = checkedPath(root, name)
  mkdirSync(dirname(target), { recursive: true })
  checkedPath(root, name)
  const temp = join(dirname(target), `.cybersyn-${randomUUID()}.tmp`)
  const fd = openSync(temp, 'wx')
  try {
    writeSync(fd, content, undefined, 'utf8'); fsyncSync(fd)
  } finally { closeSync(fd) }
  try { renameSync(temp, target) } finally { if (existsSync(temp)) unlinkSync(temp) }
  return { path: name, hash: hash(Buffer.from(content)), bytes: Buffer.byteLength(content) }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}

export function verifyArtifacts(state) {
  const at = new Date().toISOString()
  return state.task.requirements.map(r => {
    let artifact = { hash: null }, passed = false, detail = ''
    try {
      artifact = readArtifact(state.workspace, r.check.path)
      if (artifact.content === null) detail = 'artifact missing'
      else if (r.check.kind === 'text-equals') passed = artifact.content === r.check.expected
      else if (r.check.kind === 'sha256') passed = artifact.hash === r.check.expected
      else passed = JSON.stringify(canonical(JSON.parse(artifact.content))) === JSON.stringify(canonical(r.check.expected))
    } catch (error) { detail = error.code ?? error.name }
    return { requirement_id: r.id, status: passed ? 'passed' : 'failed', goal_revision: state.goalRevision,
      artifact: r.check.path, artifact_revision: artifact.hash, origin: 'executor',
      evidence: [{ kind: 'inspection', source: `${state.runId}/check/${r.id}`, summary: detail || `${r.check.kind}: ${passed ? 'passed' : 'failed'}`, captured_at: at }],
      deviations: passed ? [] : [{ type: 'A', severity: 'medium', description: detail || 'acceptance mismatch' }] }
  })
}
