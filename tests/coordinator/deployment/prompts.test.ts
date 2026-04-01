import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildApprovalRequest,
  buildCoordinatorPrompt,
  explainRollback,
  formatMetricsForDisplay,
} from '../../../src/coordinator/deployment/coordinatorPrompt.ts'

test('buildApprovalRequest returns phase-specific approval copy', () => {
  const approval = buildApprovalRequest(
    'dispatch',
    {
      reasoning: 'Low-risk dependency bump.',
      risk_assessment: 'Rollback can happen within 2 minutes.',
      change_summary: '3 files changed, +24/-8',
      stakeholders: ['owner', 'ops'],
    },
    {
      next_action: 'Start staging rollout.',
      strategy: '2% -> 25% -> 100%',
    },
  )

  assert.equal(approval.title, 'Production Deployment Spec Ready for Review')
  assert.match(approval.message, /Stakeholders Needed: owner, ops/)
  assert.match(approval.message, /Approval: \[YES\/NO\]/)
})

test('buildCoordinatorPrompt includes status, approvals, and phase summaries', () => {
  const prompt = buildCoordinatorPrompt({
    deployment_id: 'dep-123',
    initiated_at: '2026-04-01T12:00:00.000Z',
    current_phase: 'dispatch',
    status: 'paused_for_approval',
    approvals_granted: {},
    approvals_pending: ['dispatch_approval'],
    last_checkpoint: '/tmp/dep-123/context.json',
    can_resume_from: 'dispatch',
    total_duration_minutes: 12,
    tokens_used_for_verification: 0,
    tokens_remaining: 20000,
    gate_check: {
      phase: 'gate_check',
      timestamp: '2026-04-01T12:01:00.000Z',
      ready_for_dispatch: true,
      risk_level: 'medium',
      blockers: [],
      worker_results: [
        {
          worker_type: 'syntax_validation',
          passed: true,
          errors: [],
          warnings: [],
          duration_ms: 500,
        },
      ],
      change_summary: {
        files_changed: 4,
        lines_added: 80,
        lines_removed: 18,
      },
      estimated_duration_minutes: 9,
      required_approvals: ['dispatch'],
    },
  })

  assert.match(prompt, /Current Phase: Dispatch/)
  assert.match(prompt, /Status: paused_for_approval/)
  assert.match(prompt, /Pending Approvals/)
  assert.match(prompt, /dispatch_approval/)
})

test('formatters render metrics and rollback explanations cleanly', () => {
  const metricsSummary = formatMetricsForDisplay({
    timestamp: '2026-04-01T12:00:00.000Z',
    error_rate_percent: 0.35,
    p99_latency_ms: 245,
    memory_usage_percent: 61.2,
    cpu_usage_percent: 32.8,
    request_count: 420,
    failed_requests: 2,
  })

  assert.match(metricsSummary, /Error rate: 0\.35%/)
  assert.match(metricsSummary, /P99 latency: 245 ms/)
  assert.match(
    explainRollback('error_rate_percent', 3.2, 2),
    /Rollback triggered because error_rate_percent reached 3.20, exceeding the threshold of 2.00\./,
  )
})
