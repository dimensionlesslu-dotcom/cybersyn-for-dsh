import { describe, expect, it } from 'vitest'
import { auditHealth } from '../src/domain/audit.ts'
import { createWorkflow, gateReport, planAudit, revisePrompt, updateAuditPacket } from '../src/domain/engine.ts'
import type { AuditPlanInput } from '../src/domain/types.ts'
import { config, l3Seed } from './fixtures.ts'

function auditPlan(expectedRevision: number, overrides: Partial<AuditPlanInput> = {}): AuditPlanInput {
  return {
    pipelineId: 'audit-1',
    trigger: 'Material B/D deviation before delivery',
    taskId: 'verify',
    riskSignals: ['B', 'D'],
    goalConflict: false,
    requestedRoles: [],
    executionMode: 'harness-workflow',
    contextIndependent: true,
    requiredForGate: true,
    qualityRegressionRequired: false,
    acceptance: ['Every material claim has current evidence'],
    artifactRefs: ['artifact://release'],
    evidenceRefs: ['evidence://test-run'],
    maxFindings: 3,
    thresholds: {
      minimumCompletionRatio: 1,
      maximumFailureRatio: 0,
      maximumTotalTokens: 1_000,
      maximumDurationMs: 10_000,
      maximumQualityDrop: 0.05,
    },
    expectedRevision,
    ...overrides,
  }
}

describe('subagent audit assembly and degradation detector', () => {
  it('assembles risk-selected read-only PromptPackets without starting subagents', () => {
    let workflow = createWorkflow(l3Seed(), config)
    workflow = planAudit(workflow, auditPlan(workflow.revision))
    const pipeline = workflow.auditPipelines[0]!
    expect(pipeline.expectedRoles).toEqual(['measurement'])
    expect(pipeline.packets.every(packet => packet.status === 'planned' && packet.authority === 'read-only')).toBe(true)
    expect(pipeline.packets.every(packet => packet.harnessRunId === '')).toBe(true)
    expect(pipeline.packets[0]!.excludedContext).toEqual(['expected_answer', 'primary_diagnosis', 'proposed_fix', 'peer_outputs'])
    expect(pipeline.packets[0]!.prompt).toContain('Do not mutate files')
    expect(pipeline.packets[0]!.lifecycle[0]?.detail).toContain('no subagent was started')
  })

  it('keeps an open pipeline unmeasured, then reports healthy/non-degraded from complete Harness facts', () => {
    let workflow = createWorkflow(l3Seed(), config)
    workflow = planAudit(workflow, auditPlan(workflow.revision, {
      qualityRegressionRequired: true,
      thresholds: {
        minimumCompletionRatio: 1,
        maximumFailureRatio: 0,
        maximumTotalTokens: 1_000,
        maximumDurationMs: 10_000,
        baselineQualityScore: 0.8,
        maximumQualityDrop: 0.05,
      },
    }))
    expect(auditHealth(workflow, workflow.auditPipelines[0]!).operationalStatus).toBe('unmeasured')

    for (const [index, packet] of workflow.auditPipelines[0]!.packets.entries()) {
      workflow = updateAuditPacket(workflow, {
        pipelineId: 'audit-1',
        packetId: packet.id,
        status: 'completed',
        harnessRunId: `harness-run-${index + 1}`,
        findings: [{ id: `finding-${index + 1}`, severity: 'medium', summary: 'Evidence boundary needs attention', evidenceRef: 'evidence://test-run', recommendation: 'Add a boundary assertion' }],
        totalTokens: 200,
        durationMs: 800,
        qualityScore: 0.79,
        error: '',
        detail: 'Paired Harness workflow member ended with completed outcome.',
        expectedRevision: workflow.revision,
      })
    }
    const health = auditHealth(workflow, workflow.auditPipelines[0]!)
    expect(health.operationalStatus).toBe('healthy')
    expect(health.effectivenessStatus).toBe('non-degraded')
    expect(gateReport(workflow).checks.find(item => item.id === 'audit_audit-1_effectiveness')?.passed).toBe(true)
  })

  it('makes context loss, budget excess, and baseline quality drop explicit degradations', () => {
    let fallback = createWorkflow(l3Seed('fallback'), config)
    fallback = planAudit(fallback, auditPlan(fallback.revision, {
      pipelineId: 'fallback-audit',
      requestedRoles: ['measurement'],
      executionMode: 'host-serial-fallback',
      contextIndependent: false,
    }))
    expect(auditHealth(fallback, fallback.auditPipelines[0]!).operationalStatus).toBe('degraded')
    expect(gateReport(fallback).checks.find(item => item.id === 'audit_fallback-audit_operational')?.passed).toBe(false)

    let workflow = createWorkflow(l3Seed('regression'), config)
    workflow = planAudit(workflow, auditPlan(workflow.revision, {
      pipelineId: 'regression-audit',
      requestedRoles: ['measurement'],
      qualityRegressionRequired: true,
      thresholds: {
        minimumCompletionRatio: 1,
        maximumFailureRatio: 0,
        maximumTotalTokens: 100,
        maximumDurationMs: 1_000,
        baselineQualityScore: 0.9,
        maximumQualityDrop: 0.05,
      },
    }))
    const packet = workflow.auditPipelines[0]!.packets[0]!
    workflow = updateAuditPacket(workflow, {
      pipelineId: 'regression-audit', packetId: packet.id, status: 'completed', harnessRunId: 'harness-regression',
      findings: [], totalTokens: 150, durationMs: 900, qualityScore: 0.7, error: '', detail: 'completed', expectedRevision: workflow.revision,
    })
    const health = auditHealth(workflow, workflow.auditPipelines[0]!)
    expect(health.operationalStatus).toBe('degraded')
    expect(health.effectivenessStatus).toBe('degraded')
    expect(health.checks.find(item => item.id === 'token_budget')?.status).toBe('fail')
    expect(health.checks.find(item => item.id === 'quality_regression')?.status).toBe('fail')
  })

  it('detects stale PromptPackets and caps retry at one', () => {
    let workflow = createWorkflow(l3Seed(), config)
    workflow = planAudit(workflow, auditPlan(workflow.revision, { requestedRoles: ['measurement'] }))
    const packetId = workflow.auditPipelines[0]!.packets[0]!.id
    workflow = updateAuditPacket(workflow, {
      pipelineId: 'audit-1', packetId, status: 'failed', harnessRunId: 'run-1', findings: [], error: 'provider unavailable', detail: 'Harness member failed', expectedRevision: workflow.revision,
    })
    workflow = updateAuditPacket(workflow, {
      pipelineId: 'audit-1', packetId, status: 'dispatched', harnessRunId: 'run-2', findings: [], error: '', detail: 'single retry dispatched', expectedRevision: workflow.revision,
    })
    workflow = updateAuditPacket(workflow, {
      pipelineId: 'audit-1', packetId, status: 'failed', harnessRunId: 'run-2', findings: [], error: 'second failure', detail: 'retry failed', expectedRevision: workflow.revision,
    })
    expect(() => updateAuditPacket(workflow, {
      pipelineId: 'audit-1', packetId, status: 'dispatched', harnessRunId: 'run-3', findings: [], error: '', detail: 'forbidden retry', expectedRevision: workflow.revision,
    })).toThrow(/single retry/)

    workflow = revisePrompt(workflow, {
      taskId: 'verify', replacement: 'Verify current evidence plus deployment rollback.', actor: 'human', reason: 'scope correction', expectedRevision: workflow.revision,
    })
    expect(auditHealth(workflow, workflow.auditPipelines[0]!).checks.find(item => item.id === 'prompt_freshness')?.status).toBe('fail')
  })
})
