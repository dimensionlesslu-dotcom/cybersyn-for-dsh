#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRun, run, inspect, reviseGoal } from './runner.mjs'
import { requestCancel } from './journal.mjs'
import { selectSupport } from './contract.mjs'

const read = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
export async function main(argv = process.argv.slice(2)) {
  const command = argv.shift(), args = {}
  const allowed = { run: ['task', 'workspace', 'state', 'backend', 'limits', 'stop-after'], resume: ['state', 'stop-after', 'input'],
    inspect: ['state'], cancel: ['state'], revise: ['state', 'task', 'expected-revision'], support: ['gaps', 'available', 'required-runtime'] }
  if (!allowed[command]) throw new Error('Use run/resume/inspect/cancel/revise/support')
  while (argv.length) {
    const key = argv.shift()?.replace(/^--/, '')
    if (!allowed[command].includes(key) || !argv.length || Object.hasOwn(args, key)) throw new Error('Unknown, duplicate, or incomplete argument')
    args[key] = argv.shift()
  }
  if (args['required-runtime'] !== undefined && !['true', 'false'].includes(args['required-runtime'])) throw new Error('required-runtime must be true or false')
  if (command === 'support') return selectSupport(JSON.parse(args.gaps ?? '[]'), args['required-runtime'] === 'true', JSON.parse(args.available ?? '["T1"]'))
  if (!args.state) throw new Error('--state is required')
  const stopAfter = args['stop-after'] === undefined ? Infinity : Number(args['stop-after'])
  if (!(stopAfter === Infinity || Number.isInteger(stopAfter) && stopAfter > 0)) throw new Error('stop-after must be a positive integer')
  if (command === 'run') {
    if (!args.task || !args.workspace || !args.backend) throw new Error('run requires task, workspace, state, and backend')
    createRun({ task: read(args.task), workspace: args.workspace, directory: args.state, backend: read(args.backend), limits: args.limits ? read(args.limits) : {} })
  }
  if (command === 'inspect') return inspect(args.state)
  if (command === 'cancel') return requestCancel(resolve(args.state))
  if (command === 'revise') return reviseGoal(args.state, read(args.task), Number(args['expected-revision']))
  const controller = new AbortController()
  const cancel = () => controller.abort()
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel)
  try { return await run(args.state, { stopAfter, signal: controller.signal, input: args.input }) }
  finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await main(); process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    if (['blocked', 'indeterminate', 'budget_exhausted', 'needs_input'].includes(result.status)) process.exitCode = 1
  } catch (error) {
    process.stderr.write(JSON.stringify({ error: error.code ?? 'INVALID_INPUT', message: error.message }) + '\n'); process.exitCode = 2
  }
}
