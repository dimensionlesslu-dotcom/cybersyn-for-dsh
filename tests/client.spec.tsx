import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createWorkflow, planAudit, summarize } from '../src/domain/engine.ts'
import { AuditPipelines, WorkflowGraph } from '../src/client/Dashboard.tsx'
import { layoutGraph } from '../src/client/layout.ts'
import { config, l3Seed } from './fixtures.ts'

describe('runtime visualization', () => {
  it('lays out every task and dependency without inventing runtime state', () => {
    const summary = summarize(createWorkflow(l3Seed(), config))
    const graph = layoutGraph(summary.tasks)
    expect(graph.nodes).toHaveLength(3)
    expect(graph.edges.map(edge => `${edge.from}->${edge.to}`)).toEqual(['observe->model', 'model->verify'])
    expect(graph.nodes.map(node => node.x)).toEqual([...graph.nodes.map(node => node.x)].sort((a, b) => a - b))
  })

  it('renders explicit depth, status, prompt revision, and dependency edges', () => {
    const summary = summarize(createWorkflow(l3Seed(), config))
    const html = renderToStaticMarkup(<WorkflowGraph summary={summary} selectedId="observe" onSelect={() => undefined} />)
    expect(html).toContain('Cybersyn task dependency graph')
    expect(html).toContain('D1 · ready')
    expect(html).toContain('D2 · proposed')
    expect(html).toContain('prompt r1')
    expect(html).toContain('cybersyn-arrow')
  })

  it('renders the subagent assembly boundary, lifecycle, and unmeasured degradation state', () => {
    let workflow = createWorkflow(l3Seed(), config)
    workflow = planAudit(workflow, {
      pipelineId: 'visual-audit', trigger: 'visual proof', taskId: 'verify', riskSignals: ['B', 'D'], goalConflict: false, requestedRoles: [],
      executionMode: 'harness-workflow', contextIndependent: true, requiredForGate: false, qualityRegressionRequired: false,
      acceptance: ['current evidence'], artifactRefs: [], evidenceRefs: [], maxFindings: 3,
      thresholds: { minimumCompletionRatio: 1, maximumFailureRatio: 0, maximumQualityDrop: 0.05 }, expectedRevision: workflow.revision,
    })
    const html = renderToStaticMarkup(<AuditPipelines summary={summarize(workflow)} />)
    expect(html).toContain('PromptPacket assembled')
    expect(html).toContain('Harness dispatch')
    expect(html).toContain('Plugin dispatch count: 0')
    expect(html).toContain('operational: unmeasured')
    expect(html).toContain('measurement')
    expect(html).toContain('integration-regression')
  })
})
