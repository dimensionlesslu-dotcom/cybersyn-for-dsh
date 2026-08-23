import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  createWorkflow,
  descendants,
  gateReport,
  revisePrompt,
  updateModel,
  updateTask,
  updateWorkspace,
} from '../src/domain/engine.ts'
import type { StructuralModel, Workflow, WorkflowSeed, WorkspaceItem } from '../src/domain/types.ts'

interface Example {
  name: string
  seed: WorkflowSeed
  workspace: WorkspaceItem
  models?: StructuralModel[]
  edit: { taskId: string; replacement: string; reason: string }
}

const config = { workspaceCapacity: 6, maxPromptChars: 24_000, l4MinimumModels: 3 }

function verifyAll(workflow: Workflow, phase: string): Workflow {
  let current = workflow
  for (const taskId of current.taskOrder) {
    const task = current.tasks[taskId]!
    current = updateTask(current, {
      taskId,
      status: 'verified',
      evidence: [{
        id: `${phase}-${taskId}`,
        claim: task.claims[0] ?? `Acceptance claim for ${taskId}`,
        artifact: `evidence://${current.domain}/${phase}/${taskId}`,
        method: 'fixture-backed constructive check through the shared engine',
        status: 'passed',
      }],
      deviations: [],
      expectedRevision: current.revision,
    }, `2026-08-22T01:${String(current.revision).padStart(2, '0')}:00.000Z`)
  }
  return current
}

async function main(): Promise<void> {
  const examplesDir = resolve('examples')
  const files = (await readdir(examplesDir)).filter(file => file.endsWith('.json')).sort()
  if (files.length < 3) throw new Error('At least three cross-domain examples are required')
  const records = []
  const domains = new Set<string>()

  for (const file of files) {
    const example = JSON.parse(await readFile(resolve(examplesDir, file), 'utf8')) as Example
    domains.add(example.seed.domain)
    let workflow = createWorkflow(example.seed, config, '2026-08-22T00:00:00.000Z')
    workflow = updateWorkspace(workflow, {
      action: 'upsert',
      item: example.workspace,
      expectedRevision: workflow.revision,
    }, '2026-08-22T00:01:00.000Z')
    for (const model of example.models ?? []) {
      workflow = updateModel(workflow, {
        action: 'upsert',
        model,
        expectedRevision: workflow.revision,
      }, '2026-08-22T00:02:00.000Z')
    }

    workflow = verifyAll(workflow, 'before-edit')
    const beforeEdit = gateReport(workflow)
    if (!beforeEdit.passed) throw new Error(`${example.name}: gate did not pass before human edit`)
    const affected = descendants(workflow, example.edit.taskId)
    workflow = revisePrompt(workflow, {
      taskId: example.edit.taskId,
      replacement: example.edit.replacement,
      actor: 'domain-human',
      reason: example.edit.reason,
      expectedRevision: workflow.revision,
    }, '2026-08-22T02:00:00.000Z')
    const afterEdit = gateReport(workflow)
    const staleAffected = affected.every(taskId => workflow.tasks[taskId]!.evidence.every(item => item.stale))
    if (afterEdit.passed || !staleAffected) throw new Error(`${example.name}: prompt edit did not hold the gate and stale affected evidence`)
    workflow = verifyAll(workflow, 'after-edit')
    const afterReverification = gateReport(workflow)
    if (!afterReverification.passed) throw new Error(`${example.name}: gate did not recover after re-verification`)

    records.push({
      example: example.name,
      domain: example.seed.domain,
      level: example.seed.level,
      taskCount: example.seed.tasks.length,
      humanEditedTask: example.edit.taskId,
      invalidatedTaskIds: affected,
      beforeEditGatePassed: beforeEdit.passed,
      afterEditGatePassed: afterEdit.passed,
      staleAffectedEvidence: staleAffected,
      afterReverificationGatePassed: afterReverification.passed,
      l4ActiveModels: workflow.models.filter(model => model.status === 'active').length,
      finalRevision: workflow.revision,
    })
  }

  if (domains.size < 3) throw new Error('Examples must cover at least three distinct domains')
  const report = {
    generatedAt: new Date().toISOString(),
    claim: 'Constructive cross-domain evidence: the same domain-independent controller enforces the stated invariants in every fixture. This is not a real-world outcome study.',
    enginePolicy: config,
    domains: [...domains].sort(),
    allPassed: records.every(record => record.beforeEditGatePassed && !record.afterEditGatePassed && record.staleAffectedEvidence && record.afterReverificationGatePassed),
    records,
  }
  await mkdir(resolve('reports'), { recursive: true })
  await writeFile(resolve('reports/cross-domain-evidence.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

await main()
