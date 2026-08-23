import { useEffect, useMemo, useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { AuditHealthStatus, AuditPacketStatus, ControlTask, WorkflowSummary } from '../domain/types.ts'
import type { CybersynRpcResult } from '../rpc.ts'
import { layoutGraph } from './layout.ts'

export interface DashboardInjected {
  rpc: (endpoint: string, payload: unknown) => Promise<CybersynRpcResult>
  canEdit: boolean
}

type DashboardProps = ConvViewProps & InjectFace<DashboardInjected>

const palette: Record<ControlTask['status'], { fill: string; stroke: string }> = {
  proposed: { fill: '#f5f5f4', stroke: '#a8a29e' },
  ready: { fill: '#eff6ff', stroke: '#3b82f6' },
  running: { fill: '#fff7ed', stroke: '#f97316' },
  blocked: { fill: '#fef2f2', stroke: '#dc2626' },
  verified: { fill: '#ecfdf5', stroke: '#059669' },
  stale: { fill: '#faf5ff', stroke: '#9333ea' },
}

const panel: React.CSSProperties = {
  background: '#ffffff',
  border: '1px solid #e7e5e4',
  borderRadius: 14,
  padding: 16,
  boxShadow: '0 1px 2px rgb(0 0 0 / 0.04)',
}

const auditPalette: Record<AuditPacketStatus, { background: string; border: string }> = {
  planned: { background: '#f5f5f4', border: '#78716c' },
  dispatched: { background: '#eff6ff', border: '#2563eb' },
  running: { background: '#fff7ed', border: '#ea580c' },
  completed: { background: '#ecfdf5', border: '#059669' },
  failed: { background: '#fef2f2', border: '#dc2626' },
  cancelled: { background: '#fdf4ff', border: '#a21caf' },
}

const healthColor: Record<AuditHealthStatus, string> = {
  unmeasured: '#78716c',
  healthy: '#047857',
  degraded: '#b91c1c',
}

function isSummary(value: unknown): value is WorkflowSummary {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string' && Array.isArray(record.tasks) && typeof record.revision === 'number'
}

function errorText(result: CybersynRpcResult): string {
  return result.ok ? '' : result.error.message
}

export function WorkflowGraph({ summary, selectedId, onSelect }: {
  summary: WorkflowSummary
  selectedId: string
  onSelect: (id: string) => void
}) {
  const graph = useMemo(() => layoutGraph(summary.tasks), [summary.tasks])
  const taskById = useMemo(() => new Map(summary.tasks.map(task => [task.id, task])), [summary.tasks])
  return (
    <div style={{ overflowX: 'auto', border: '1px solid #e7e5e4', borderRadius: 12, background: '#fafaf9' }}>
      <svg width={graph.width} height={graph.height} role="img" aria-label="Cybersyn task dependency graph">
        <defs>
          <marker id="cybersyn-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M0,0 L8,4 L0,8 z" fill="#78716c" />
          </marker>
        </defs>
        {graph.edges.map(edge => (
          <path
            key={`${edge.from}-${edge.to}`}
            d={`M ${edge.x1} ${edge.y1} C ${edge.x1 + 28} ${edge.y1}, ${edge.x2 - 28} ${edge.y2}, ${edge.x2} ${edge.y2}`}
            fill="none"
            stroke="#a8a29e"
            strokeWidth="2"
            markerEnd="url(#cybersyn-arrow)"
          />
        ))}
        {graph.nodes.map(node => {
          const task = taskById.get(node.id)!
          const colors = palette[task.status]
          return (
            <g key={node.id} onClick={() => onSelect(node.id)} style={{ cursor: 'pointer' }} role="button" tabIndex={0}>
              <rect
                x={node.x}
                y={node.y}
                width={node.width}
                height={node.height}
                rx="10"
                fill={colors.fill}
                stroke={selectedId === node.id ? '#111827' : colors.stroke}
                strokeWidth={selectedId === node.id ? 3 : 2}
              />
              <text x={node.x + 12} y={node.y + 24} fontSize="12" fill="#57534e">D{task.depth} · {task.status}</text>
              <text x={node.x + 12} y={node.y + 48} fontSize="14" fontWeight="600" fill="#1c1917">
                {task.title.length > 25 ? `${task.title.slice(0, 24)}…` : task.title}
              </text>
              <text x={node.x + 12} y={node.y + 66} fontSize="11" fill="#78716c">prompt r{task.promptRevision}</text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

export function AuditPipelines({ summary }: { summary: WorkflowSummary }) {
  if (summary.auditPipelines.length === 0) {
    return <p style={{ marginBottom: 0, color: '#78716c' }}>No subagent audit is planned. Absence of an audit is not presented as a passing audit.</p>
  }
  return <div style={{ display: 'grid', gap: 14 }}>
    {summary.auditPipelines.map(pipeline => <article key={pipeline.id} style={{ border: '1px solid #d6d3d1', borderRadius: 12, padding: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <strong>{pipeline.id}</strong> · {pipeline.executionMode}
          <div style={{ color: '#78716c', fontSize: 12 }}>{pipeline.trigger}</div>
        </div>
        <div style={{ textAlign: 'right', fontSize: 12 }}>
          <strong style={{ color: healthColor[pipeline.health.operationalStatus] }}>operational: {pipeline.health.operationalStatus}</strong>
          <div>effectiveness: {pipeline.health.effectivenessStatus}</div>
        </div>
      </div>

      <div aria-label="Subagent assembly lifecycle" style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', margin: '12px 0', fontSize: 12 }}>
        <span>① PromptPacket assembled</span><span>→</span><span>② Harness dispatch</span><span>→</span><span>③ child running</span><span>→</span><span>④ result + degradation checks</span>
      </div>
      <p style={{ margin: '0 0 12px', fontSize: 12, color: pipeline.contextIndependent ? '#57534e' : '#b91c1c' }}>
        Plugin dispatch count: 0. Execution belongs to DeepSeek Harness. Context independence: {pipeline.contextIndependent ? 'declared' : 'not available (fallback limitation)'}.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 10 }}>
        {pipeline.packets.map(packet => {
          const colors = auditPalette[packet.status]
          return <div key={packet.id} style={{ background: colors.background, border: `1px solid ${colors.border}`, borderRadius: 10, padding: 10 }}>
            <strong>{packet.role}</strong> · {packet.status}
            <div style={{ fontSize: 12, marginTop: 4 }}>{packet.id}</div>
            <div style={{ fontSize: 11, color: '#78716c' }}>task {packet.taskId} prompt r{packet.taskPromptRevision} · attempt {packet.attempt}/2</div>
            <div style={{ fontSize: 11, color: '#78716c' }}>Harness run: {packet.harnessRunId || 'not dispatched'}</div>
            <div style={{ fontSize: 11, marginTop: 5 }}>{packet.findings.length} evidence-backed finding(s)</div>
            {packet.error && <div style={{ color: '#b91c1c', fontSize: 11 }}>{packet.error}</div>}
          </div>
        })}
      </div>

      <details style={{ marginTop: 12 }}>
        <summary>Degradation detector ({pipeline.health.checks.filter(item => item.status === 'fail').length} failed checks)</summary>
        <div style={{ marginTop: 8 }}>
          {pipeline.health.checks.map(item => <div key={item.id} style={{ padding: '5px 0', borderTop: '1px solid #e7e5e4', fontSize: 12 }}>
            <strong style={{ color: item.status === 'fail' ? '#b91c1c' : item.status === 'pass' ? '#047857' : '#78716c' }}>{item.status} · {item.id}</strong>
            <div style={{ color: '#57534e' }}>{item.detail}</div>
          </div>)}
        </div>
      </details>
    </article>)}
  </div>
}

export function Dashboard({ sessionId, rpc, canEdit }: DashboardProps) {
  const [summary, setSummary] = useState<WorkflowSummary | null>(null)
  const [selectedId, setSelectedId] = useState('')
  const [draft, setDraft] = useState('')
  const [reason, setReason] = useState('Human supervisory correction')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const selected = summary?.tasks.find(task => task.id === selectedId) ?? summary?.tasks[0]

  const accept = (result: CybersynRpcResult): void => {
    if (!result.ok) {
      setError(errorText(result))
      return
    }
    if (result.value === null) {
      setSummary(null)
      setError('No Cybersyn workflow is active in this task.')
      return
    }
    if (!isSummary(result.value)) {
      setError('Host returned an invalid Cybersyn snapshot.')
      return
    }
    const nextSummary = result.value
    setSummary(nextSummary)
    setSelectedId(current => current || nextSummary.tasks[0]?.id || '')
    setError('')
  }

  const refresh = async (): Promise<void> => {
    setBusy(true)
    try {
      accept(await rpc('workflow.active', { sessionId }))
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => { void refresh() }, [sessionId])
  useEffect(() => { if (selected !== undefined) setDraft(selected.effectivePrompt) }, [selected?.id, selected?.promptRevision])

  const revise = async (): Promise<void> => {
    if (summary === null || selected === undefined) return
    setBusy(true)
    try {
      accept(await rpc('prompt.revise', {
        sessionId,
        workflowId: summary.id,
        taskId: selected.id,
        replacement: draft,
        actor: 'local-human',
        reason,
        expectedRevision: summary.revision,
      }))
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const rollback = async (targetPromptRevision: number): Promise<void> => {
    if (summary === null || selected === undefined) return
    setBusy(true)
    try {
      accept(await rpc('prompt.rollback', {
        sessionId,
        workflowId: summary.id,
        taskId: selected.id,
        targetPromptRevision,
        actor: 'local-human',
        reason: `Rollback to prompt revision ${targetPromptRevision}`,
        expectedRevision: summary.revision,
      }))
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  if (summary === null) {
    return (
      <main style={{ padding: 24, fontFamily: 'Inter, ui-sans-serif, system-ui', color: '#292524' }}>
        <div style={panel}>
          <h2 style={{ marginTop: 0 }}>Project Cybersyn</h2>
          <p>{error || 'Loading the session control workspace…'}</p>
          <button type="button" onClick={() => void refresh()} disabled={busy}>Refresh</button>
        </div>
      </main>
    )
  }

  return (
    <main style={{ padding: 20, fontFamily: 'Inter, ui-sans-serif, system-ui', color: '#292524', background: '#f5f5f4', minHeight: '100%' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 12, color: '#78716c', letterSpacing: '.08em' }}>{summary.level} · {summary.domain} · revision {summary.revision}</div>
          <h2 style={{ margin: '4px 0' }}>{summary.title}</h2>
          <div style={{ color: '#57534e' }}>{summary.objective}</div>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={busy}>Refresh</button>
      </header>

      {error && <div role="alert" style={{ ...panel, borderColor: '#ef4444', color: '#991b1b', marginBottom: 16 }}>{error}</div>}

      <section style={{ ...panel, marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>运行图</h3>
          <span style={{ color: summary.gate.passed ? '#047857' : '#b45309', fontWeight: 700 }}>
            Assurance gate: {summary.gate.passed ? 'PASS' : 'HOLD'}
          </span>
        </div>
        <WorkflowGraph summary={summary} selectedId={selected?.id ?? ''} onSelect={setSelectedId} />
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 10, fontSize: 12 }}>
          {Object.entries(palette).map(([status, color]) => <span key={status}><i style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 9, background: color.stroke, marginRight: 5 }} />{status}</span>)}
        </div>
      </section>

      <section style={{ ...panel, marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>Subagent assembly & degradation</h3>
        <AuditPipelines summary={summary} />
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(280px, 1fr)', gap: 16 }}>
        <section style={panel}>
          <h3 style={{ marginTop: 0 }}>子任务控制面</h3>
          {selected === undefined ? <p>No task selected.</p> : <>
            <div style={{ fontWeight: 700 }}>{selected.id} — {selected.title}</div>
            <div style={{ color: '#78716c', margin: '4px 0 14px' }}>D{selected.depth} · {selected.status} · prompt r{selected.promptRevision}</div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 700, marginBottom: 5 }}>Generated baseline</label>
            <pre style={{ whiteSpace: 'pre-wrap', background: '#f5f5f4', padding: 10, borderRadius: 8 }}>{selected.generatedPrompt}</pre>
            <label htmlFor="cybersyn-prompt" style={{ display: 'block', fontSize: 12, fontWeight: 700, margin: '12px 0 5px' }}>Effective prompt (human editable)</label>
            <textarea id="cybersyn-prompt" value={draft} onChange={event => setDraft(event.target.value)} rows={9} disabled={!canEdit || busy} style={{ width: '100%', boxSizing: 'border-box', font: 'inherit', padding: 10 }} />
            <label htmlFor="cybersyn-reason" style={{ display: 'block', fontSize: 12, fontWeight: 700, margin: '10px 0 5px' }}>Change reason</label>
            <input id="cybersyn-reason" value={reason} onChange={event => setReason(event.target.value)} disabled={!canEdit || busy} style={{ width: '100%', boxSizing: 'border-box', padding: 8 }} />
            <p style={{ fontSize: 12, color: '#78716c' }}>Saving creates a new revision and invalidates this task’s and all descendants’ evidence. Running affected tasks must be stopped first.</p>
            <button type="button" onClick={() => void revise()} disabled={!canEdit || busy || draft.trim().length === 0}>Save new revision</button>
            {!canEdit && <span style={{ marginLeft: 10, color: '#b45309' }}>Editing is restricted to the loopback UI.</span>}

            <h4>Revision history</h4>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {selected.promptHistory.map(entry => (
                <button key={entry.revision} type="button" disabled={!canEdit || busy || entry.revision === selected.promptRevision} onClick={() => void rollback(entry.revision)} title={entry.reason}>
                  r{entry.revision} · {entry.source}
                </button>
              ))}
            </div>

            <h4>Evidence</h4>
            {selected.evidence.length === 0 ? <p>None recorded.</p> : <ul>{selected.evidence.map(item => <li key={item.id}>{item.status}{item.stale ? ' · stale' : ''} — {item.claim} ({item.artifact})</li>)}</ul>}
            <h4>Deviations</h4>
            {selected.deviations.length === 0 ? <p>None recorded.</p> : <ul>{selected.deviations.map(item => <li key={item.id}>{item.labels.join('/')} · {item.severity} · {item.resolved ? 'resolved' : 'open'} — {item.description}</li>)}</ul>}
          </>}
        </section>

        <aside style={{ display: 'grid', gap: 16, alignContent: 'start' }}>
          <section style={panel}>
            <h3 style={{ marginTop: 0 }}>Gate checks</h3>
            {summary.gate.checks.map(check => <div key={check.id} style={{ marginBottom: 9 }}><strong style={{ color: check.passed ? '#047857' : '#b91c1c' }}>{check.passed ? '✓' : '×'} {check.id}</strong><div style={{ fontSize: 12, color: '#78716c' }}>{check.detail}</div></div>)}
          </section>
          <section style={panel}>
            <h3 style={{ marginTop: 0 }}>J-workspace <small>({summary.workspace.length})</small></h3>
            <p style={{ fontSize: 12, color: '#78716c' }}>Selective external broadcast only; hidden reasoning is never requested or displayed.</p>
            {summary.workspace.map(item => <div key={item.id} style={{ padding: '8px 0', borderTop: '1px solid #e7e5e4' }}><strong>P{item.priority} · {item.kind}</strong><div>{item.content}</div><small>{item.sourceTaskId} · {item.scope}</small><div style={{ fontSize: 11, color: '#78716c' }}>Remove when: {item.removalCondition}</div></div>)}
          </section>
          {summary.level === 'L4' && <section style={panel}>
            <h3 style={{ marginTop: 0 }}>Competing structural models</h3>
            {summary.models.map(model => <div key={model.id} style={{ padding: '8px 0', borderTop: '1px solid #e7e5e4' }}><strong>{model.name}</strong> · {model.status}<div style={{ fontSize: 12 }}>Prediction: {model.prediction}</div><div style={{ fontSize: 12 }}>Falsifier: {model.falsifier}</div></div>)}
          </section>}
        </aside>
      </div>
    </main>
  )
}
