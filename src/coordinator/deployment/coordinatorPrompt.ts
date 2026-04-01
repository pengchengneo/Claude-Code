import type {
  CanaryStage,
  DeploymentContext,
  DeploymentMetrics,
  DeploymentPhase,
  GateCheckOutput,
  VerificationReport,
} from '../../types/deployment.js'

type ApprovalPayload = {
  title: string
  reasoning: string
  changes_summary: string
  risk_assessment: string
  message: string
}

function phaseTitle(phase: DeploymentPhase): string {
  switch (phase) {
    case 'gate_check':
      return 'Gate Check'
    case 'dispatch':
      return 'Dispatch'
    case 'staging_deploy':
      return 'Staging Deploy'
    case 'verify':
      return 'Verify'
    case 'production_promote':
      return 'Production Promote'
    case 'completed':
      return 'Completed'
    case 'failed':
      return 'Failed'
    case 'rolled_back':
      return 'Rolled Back'
  }
}

export function formatMetricsForDisplay(
  metrics: DeploymentMetrics | null | undefined,
): string {
  if (!metrics) {
    return 'No metrics captured yet.'
  }

  return [
    `Error rate: ${metrics.error_rate_percent.toFixed(2)}%`,
    `P99 latency: ${metrics.p99_latency_ms.toFixed(0)} ms`,
    `Memory: ${metrics.memory_usage_percent.toFixed(1)}%`,
    `CPU: ${metrics.cpu_usage_percent.toFixed(1)}%`,
    `Requests: ${metrics.request_count}`,
    `Failures: ${metrics.failed_requests}`,
  ].join(' | ')
}

export function formatGateCheckResults(
  gateCheck: GateCheckOutput | undefined,
): string {
  if (!gateCheck) {
    return 'Gate check has not run yet.'
  }

  const workerSummary = gateCheck.worker_results
    .map(
      result =>
        `${result.worker_type}: ${result.passed ? 'pass' : 'fail'} (${result.errors.length} errors, ${result.warnings.length} warnings)`,
    )
    .join('\n')

  const blockers =
    gateCheck.blockers.length > 0
      ? gateCheck.blockers.map(blocker => `- ${blocker}`).join('\n')
      : '- none'

  return `Risk: ${gateCheck.risk_level}
Ready: ${gateCheck.ready_for_dispatch ? 'yes' : 'no'}
Blockers:
${blockers}

Workers:
${workerSummary}`
}

export function formatVerificationResults(
  report: VerificationReport | undefined,
): string {
  if (!report) {
    return 'Verification has not run yet.'
  }

  const failures = report.test_results.filter(result => !result.passed)
  const failureSummary =
    failures.length > 0
      ? failures
          .map(
            result =>
              `- ${result.test_category}/${result.name}: ${result.error_message ?? 'failed'}`,
          )
          .join('\n')
      : '- none'

  return `Recommendation: ${report.go_no_go_recommendation}
Confidence: ${report.confidence_score}/100
All tests passed: ${report.all_tests_passed ? 'yes' : 'no'}
Regressions detected: ${report.performance_delta.regression_detected ? 'yes' : 'no'}
Failures:
${failureSummary}`
}

export function explainRollback(
  trigger: string,
  actual: number,
  threshold: number,
): string {
  return `Rollback triggered because ${trigger} reached ${actual.toFixed(2)}, exceeding the threshold of ${threshold.toFixed(2)}.`
}

function summarizeCanaryStages(stages: CanaryStage[]): string {
  return stages
    .map(
      stage =>
        `${stage.name}: ${stage.percentage}% for ${stage.duration_minutes}m (error ${stage.auto_rollback_threshold.error_rate_percent}%, p99 ${stage.auto_rollback_threshold.p99_latency_ms}ms, memory ${stage.auto_rollback_threshold.memory_usage_percent}%)`,
    )
    .join('\n')
}

export function buildApprovalRequest(
  phase: DeploymentPhase,
  findings: {
    reasoning: string
    risk_assessment: string
    change_summary: string
    stakeholders?: string[]
  },
  proposed: {
    next_action: string
    strategy?: string
  },
): ApprovalPayload {
  const title =
    phase === 'dispatch'
      ? 'Production Deployment Spec Ready for Review'
      : phase === 'production_promote'
        ? 'Production Promotion Ready for Approval'
        : `${phaseTitle(phase)} Approval Required`

  const message = [
    `Title: ${title}`,
    `Reasoning: ${findings.reasoning}`,
    `Changes: ${findings.change_summary}`,
    `Risk Assessment: ${findings.risk_assessment}`,
    `Proposed Strategy: ${proposed.strategy ?? proposed.next_action}`,
    `Stakeholders Needed: ${(findings.stakeholders ?? []).join(', ') || 'none'}`,
    `Next Action if Approved: ${proposed.next_action}`,
    'Approval: [YES/NO]',
  ].join('\n')

  return {
    title,
    reasoning: findings.reasoning,
    changes_summary: findings.change_summary,
    risk_assessment: findings.risk_assessment,
    message,
  }
}

export function buildCoordinatorPrompt(context: DeploymentContext): string {
  const sections: string[] = [
    '# Deployment Coordinator',
    '',
    `Current Phase: ${phaseTitle(context.current_phase)}`,
    `Status: ${context.status}`,
    `Deployment ID: ${context.deployment_id}`,
    `Resumable From: ${phaseTitle(context.can_resume_from)}`,
    '',
    '## Gate Check',
    formatGateCheckResults(context.gate_check),
    '',
    '## Verification',
    formatVerificationResults(context.verify),
  ]

  if (context.dispatch) {
    sections.push(
      '',
      '## Proposed Staging Strategy',
      summarizeCanaryStages(context.dispatch.deployment_spec.staging.canary_stages),
      '',
      '## Proposed Production Strategy',
      summarizeCanaryStages(
        context.dispatch.deployment_spec.production.canary_stages,
      ),
    )
  }

  if (context.approvals_pending.length > 0) {
    sections.push(
      '',
      '## Pending Approvals',
      context.approvals_pending.map(item => `- ${item}`).join('\n'),
    )
  }

  return sections.join('\n')
}
