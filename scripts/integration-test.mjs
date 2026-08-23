import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const temp = await mkdtemp(resolve('.pack-test-'))

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

try {
  const pnpmEntry = process.env.npm_execpath
  assert(typeof pnpmEntry === 'string' && pnpmEntry.length > 0, 'pnpm did not expose npm_execpath to the integration script')
  await run(process.execPath, [pnpmEntry, 'pack', '--pack-destination', temp], { cwd: process.cwd() })
  const archive = (await readdir(temp)).find(file => file.endsWith('.tgz'))
  assert(archive !== undefined, 'pnpm pack did not create a tarball')
  await run('tar', ['-xf', resolve(temp, archive), '-C', temp])
  const packageRoot = resolve(temp, 'package')
  const required = [
    'lib/index.js',
    'lib/invariant.js',
    'lib/client.js',
    'lib/types/index.d.ts',
    'cordis.patch.yml',
    'skill/project-cybersyn/SKILL.md',
    'skill/project-cybersyn/references/runtime-protocol.md',
    'skill/project-cybersyn/references/audit-pipeline.md',
    'docs/construction.md',
    'docs/references.md',
    'reports/cross-domain-evidence.json',
    'README.md',
    'LICENSE',
    'package.json',
  ]
  for (const path of required) {
    await readFile(resolve(packageRoot, path))
  }

  const client = await readFile(resolve(packageRoot, 'lib/client.js'), 'utf8')
  assert(client.includes('window.__ModuleLoader__.load'), 'client bundle lacks the Harness module-loader wrapper')
  assert(client.includes('Cybersyn'), 'client bundle lacks the visual workspace')

  const plugin = await import(`${pathToFileURL(resolve(packageRoot, 'lib/index.js')).href}?packed=1`)
  const tools = []
  const skills = []
  const context = {
    tools: { register(tool) { tools.push(tool); return () => undefined } },
    skills: { register(skill) { skills.push(skill); return () => undefined } },
    inject() { return undefined },
  }
  await plugin.apply(context, {
    stateFile: resolve(temp, 'state/events.jsonl'),
    workspaceCapacity: 6,
    maxPromptChars: 24_000,
    l4MinimumModels: 3,
    registerBundledSkill: true,
  })
  assert(tools.length === 7, `packed plugin registered ${tools.length} tools instead of 7`)
  assert(skills.some(skill => skill.name === 'project-cybersyn'), 'packed plugin did not register its runtime Skill')

  const start = tools.find(tool => tool.name === 'cybersyn_start')
  const auditPlan = tools.find(tool => tool.name === 'cybersyn_audit_plan')
  const inspect = tools.find(tool => tool.name === 'cybersyn_inspect')
  const execution = { agent: { session: { header: { id: 'packed-session' } } } }
  const started = await start.execute({
    workflowId: 'packed-smoke',
    title: 'Packed smoke workflow',
    domain: 'packaging',
    level: 'L3',
    objective: 'Prove the installed packed host entry executes.',
    constraints: ['packed artifact only'],
    tasks: [
      { id: 'a', title: 'Acquire', depth: 1, dependsOn: [], generatedPrompt: 'Acquire packaging facts.', claims: ['facts acquired'] },
      { id: 'b', title: 'Build', depth: 2, dependsOn: ['a'], generatedPrompt: 'Build the installed projection.', claims: ['projection built'] },
      { id: 'c', title: 'Check', depth: 3, dependsOn: ['b'], generatedPrompt: 'Check the installed projection.', claims: ['projection checked'] },
    ],
  }, execution)
  assert(started.workflowId === 'packed-smoke' && started.revision === 1, 'packed start tool returned an unexpected result')
  const planned = await auditPlan.execute({
    workflowId: 'packed-smoke', pipelineId: 'packed-audit', trigger: 'packed lifecycle smoke', taskId: 'c',
    riskSignals: ['B', 'D'], goalConflict: false, requestedRoles: [], executionMode: 'harness-workflow', contextIndependent: true,
    requiredForGate: false, qualityRegressionRequired: false, acceptance: ['packed facts checked'], artifactRefs: [], evidenceRefs: [],
    maxFindings: 3, thresholds: { minimumCompletionRatio: 1, maximumFailureRatio: 0, maximumQualityDrop: 0.05 }, expectedRevision: 1,
  }, execution)
  assert(planned.revision === 2, 'packed audit plan tool did not persist PromptPackets')
  const inspected = await inspect.execute({ workflowId: 'packed-smoke' }, execution)
  assert(inspected.workflowId === 'packed-smoke' && inspected.gatePassed === false, 'packed inspect tool did not read durable state')

  process.stdout.write(JSON.stringify({
    packedArtifact: archive,
    requiredFiles: required.length,
    tools: tools.map(tool => tool.name),
    skillRegistered: true,
    startExecuted: true,
    auditPlanExecuted: true,
    inspectExecuted: true,
  }, null, 2) + '\n')
} finally {
  await rm(temp, { recursive: true, force: true })
}
