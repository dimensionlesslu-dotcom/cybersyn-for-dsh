import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync, closeSync, fsyncSync, writeSync, truncateSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fail } from './contract.mjs'

export const hash = value => createHash('sha256').update(value).digest('hex')
const alive = pid => { try { process.kill(pid, 0); return true } catch (e) { return e.code !== 'ESRCH' } }

export function acquire(directory) {
  mkdirSync(directory, { recursive: true })
  const path = join(directory, 'writer.lock')
  if (existsSync(path)) {
    const lock = JSON.parse(readFileSync(path, 'utf8'))
    if (!Number.isInteger(lock.pid) || alive(lock.pid)) fail('LOCKED', 'another writer may still be alive')
    unlinkSync(path)
  }
  const token = randomUUID(), fd = openSync(path, 'wx')
  writeSync(fd, JSON.stringify({ pid: process.pid, token })); fsyncSync(fd); closeSync(fd)
  return () => { if (existsSync(path) && JSON.parse(readFileSync(path, 'utf8')).token === token) unlinkSync(path) }
}

function incomplete(text) {
  const stack = []; let quoted = false, escaped = false
  if (!text.startsWith('{')) return false
  for (const c of text) {
    if (escaped) { escaped = false; continue }
    if (quoted && c === '\\') { escaped = true; continue }
    if (c === '"') { quoted = !quoted; continue }
    if (quoted) continue
    if (c === '{' || c === '[') stack.push(c)
    if (c === '}' || c === ']') if (stack.pop() !== (c === '}' ? '{' : '[')) return false
  }
  return quoted || stack.length > 0
}

export function readJournal(directory, repair = false) {
  const path = join(directory, 'events.jsonl')
  if (!existsSync(path)) return { state: null, seq: 0, digest: '', tail: false }
  const raw = readFileSync(path, 'utf8')
  if (Buffer.byteLength(raw) > 64 * 1024 * 1024) fail('LOG_TOO_LARGE', 'archive this run before continuing')
  let state = null, seq = 0, digest = '', committedBytes = 0, tail = false
  const lines = raw.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line && i === lines.length - 1) break
    let event
    try { event = JSON.parse(line) } catch {
      if (i !== lines.length - 1 || !incomplete(line)) fail('CORRUPT_LOG', 'invalid interior/complete journal record')
      tail = true; break
    }
    const { digest: actual, ...body } = event
    if (body.schemaVersion !== 3 || body.seq !== seq + 1 || body.previous !== digest || hash(JSON.stringify(body)) !== actual) fail('CORRUPT_LOG', 'journal version, sequence, or hash mismatch')
    if (!body.state || body.state.schemaVersion !== 3) fail('CORRUPT_LOG', 'invalid checkpoint')
    state = body.state; seq = body.seq; digest = actual
    committedBytes += Buffer.byteLength(line) + (i < lines.length - 1 ? 1 : 0)
  }
  if (repair && tail) truncateSync(path, committedBytes)
  if (repair && !tail && committedBytes && !raw.endsWith('\n')) {
    const fd = openSync(path, 'a'); writeSync(fd, '\n'); fsyncSync(fd); closeSync(fd)
  }
  return { state, seq, digest, tail }
}

export class Journal {
  constructor(directory) {
    this.directory = directory
    Object.assign(this, readJournal(directory, true))
  }
  append(kind, state, detail = {}) {
    const body = { schemaVersion: 3, seq: this.seq + 1, previous: this.digest, kind, at: new Date().toISOString(), detail, state }
    const digest = hash(JSON.stringify(body))
    const fd = openSync(join(this.directory, 'events.jsonl'), 'a')
    try { writeSync(fd, JSON.stringify({ ...body, digest }) + '\n'); fsyncSync(fd) } finally { closeSync(fd) }
    this.seq = body.seq; this.digest = digest; this.state = structuredClone(state)
  }
}

export function requestCancel(directory) {
  const journal = readJournal(directory)
  if (!journal.state) fail('NOT_FOUND', 'run does not exist')
  writeFileSync(join(directory, 'cancel.request'), 'cancel\n', { flag: 'w' })
  return { run_id: journal.state.runId, cancellation_requested: true }
}
