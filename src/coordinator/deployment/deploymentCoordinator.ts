import { randomUUID } from 'crypto'
import type {
  CanaryStage,
  DispatchOutput,
  DeploymentContext,
  DeploymentMetrics,
  DeploymentPhase,
  DeploymentSpec,
  GateCheckOutput,
  GateCheckWorkerResult,
  ProductionDeployOutput,
  RiskLevel,
  RollbackTrigger,
  StagingDeployOutput,
  VerificationReport,
} from '../../types/deployment.js'
import {
  buildApprovalRequest,
  buildCoordinatorPrompt,
} from './coordinatorPrompt.js'
import { WorkerFactory } from './workerFactory.js'
import { CheckpointStorage } from '../../services/deployment/checkpointStorage.js'
import {
  MetricsCollector,
  type RegressionAnalysis,
} from '../../services/deployment/metricsCollector.js'
import {
  readDeploymentFeatureGates,
} from '../../services/analytics/deployment.featureGates.js'
import type { DeploymentFeatureGates } from '../../types/deployment.js'
import { logEvent } from '../../services/analytics/index.js'

type DeploymentCoordinatorOptions = {
  checkpointStorage?: CheckpointStorage
  metricsCollector?: MetricsCollector
  workerFactory?: WorkerFactory
  skipApprovals?: boolean
  canaryPercentOverride?: number
  featureGates?: DeploymentFeatureGates
  deploymentId?: string
}

type ChangeImpactWorkerResult = GateCheckWorkerResult & {
  specific_findings?: {
    files_changed?: number
    lines_added?: number
    lines_removed?: number
    blast_radius?: string
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

function minutesSince(timestamp: string): number {
  const parsed = Date.parse(timestamp)
  if (!Number.isFinite(parsed)) {
    return 0
  }
  return Math.max(0, (Date.now() - parsed) / 60_000)
}

function getRiskLevelScore(risk: RiskLevel): number {
  switch (risk) {
    case 'critical':
      return 4
    case 'high':
      return 3
    case 'medium':
      return 2
    case 'low':
      return 1
  }
}

function uniqueSortedPercentages(values: number[]): number[] {
  return [...new Set(values.map(value => Math.min(100, Math.max(1, Math.round(value)))))]
    .sort((left, right) => left - right)
}

function buildCanaryStages(
  risk: RiskLevel,
  startingPercent: number,
  environment: 'staging' | 'production',
): CanaryStage[] {
  const percentages =
    risk === 'critical'
      ? uniqueSortedPercentages([startingPercent, 2, 5, 10, 25, 50, 100])
      : risk === 'high'
        ? uniqueSortedPercentages([startingPercent, 5, 25, 50, 100])
        : risk === 'medium'
          ? uniqueSortedPercentages([startingPercent, 10, 50, 100])
          : uniqueSortedPercentages([startingPercent, 25, 100])

  return percentages.map((percentage, index) => {
    const isFinal = index === percentages.length - 1
    const baseDuration =
      environment === 'staging'
        ? isFinal
          ? 20
          : percentage <= 5
            ? 10
            : 15
        : isFinal
          ? 20
          : percentage <= 10
            ? 15
            : 20

    const riskAdjustment = getRiskLevelScore(risk) - 1
    return {
      name: `${percentage}% ${environment === 'staging' ? 'staging' : 'production'} canary`,
      percentage,
      duration_minutes: baseDuration + riskAdjustment,
      auto_rollback_threshold: {
        error_rate_percent:
          risk === 'critical'
            ? 0.5
            : risk === 'high'
              ? 1
              : risk === 'medium'
                ? 1.5
                : 2,
        p99_latency_ms:
          risk === 'critical'
            ? 350
            : risk === 'high'
              ? 400
              : risk === 'medium'
                ? 500
                : 650,
        memory_usage_percent:
          risk === 'critical'
            ? 75
            : risk === 'high'
              ? 80
              : risk === 'medium'
                ? 85
                : 90,
      },
    }
  })
}

function buildRollbackTriggers(
  spec: DeploymentSpec,
  autoRollbackEnabled: boolean,
): RollbackTrigger[] {
  const strictestProductionStage = spec.production.canary_stages[0]
  return [
    {
      condition: 'error_rate_exceeded',
      threshold:
        strictestProductionStage.auto_rollback_threshold.error_rate_percent,
      action: autoRollbackEnabled ? 'auto_rollback' : 'approval_required',
    },
    {
      condition: 'latency_exceeded',
      threshold:
        strictestProductionStage.auto_rollback_threshold.p99_latency_ms,
      action: autoRollbackEnabled ? 'auto_rollback' : 'approval_required',
    },
    {
      condition: 'manual_request',
      threshold: 0,
      action: 'approval_required',
    },
  ]
}

function determineRiskLevel(
  workerResults: GateCheckWorkerResult[],
): RiskLevel {
  const failures = workerResults.filter(result => !result.passed)
  if (failures.some(result => result.worker_type === 'security_compliance')) {
    return 'critical'
  }
  if (failures.some(result => result.worker_type === 'syntax_validation')) {
    return 'high'
  }
  if (workerResults.some(result => result.warnings.length > 0)) {
    return 'medium'
  }
  return 'low'
}

function extractBlockers(workerResults: GateCheckWorkerResult[]): string[] {
  return workerResults.flatMap(result => {
    if (result.passed) {
      return []
    }
    if (result.worker_type === 'change_impact') {
      return []
    }
    return result.errors
  })
}

function aggregateChangeSummary(
  workerResults: Array<GateCheckWorkerResult & { specific_findings?: Record<string, unknown> }>,
): GateCheckOutput['change_summary'] {
  const changeImpact = workerResults.find(
    result => result.worker_type === 'change_impact',
  ) as ChangeImpactWorkerResult | undefined

  return {
    files_changed: Number(
      changeImpact?.specific_findings?.files_changed ?? 0,
    ),
    lines_added: Number(changeImpact?.specific_findings?.lines_added ?? 0),
    lines_removed: Number(changeImpact?.specific_findings?.lines_removed ?? 0),
  }
}

function approvalKey(phase: 'dispatch' | 'production_promote'): string {
  return `${phase}_approval`
}

export class DeploymentCoordinator {
  private readonly checkpointStorage: CheckpointStorage
  private readonly metricsCollector: MetricsCollector
  private readonly workerFactory: WorkerFactory
  private readonly skipApprovals: boolean
  private readonly canaryPercentOverride?: number
  private readonly featureGates: DeploymentFeatureGates
  private context: DeploymentContext

  constructor(
    private readonly deploymentTarget: string,
    options: DeploymentCoordinatorOptions = {},
  ) {
    this.checkpointStorage =
      options.checkpointStorage ?? new CheckpointStorage()
    this.metricsCollector = options.metricsCollector ?? new MetricsCollector()
    this.workerFactory = options.workerFactory ?? new WorkerFactory()
    this.skipApprovals = Boolean(options.skipApprovals)
    this.canaryPercentOverride = options.canaryPercentOverride
    this.featureGates =
      options.featureGates ?? readDeploymentFeatureGates()
    this.context = {
      deployment_id: options.deploymentId ?? randomUUID(),
      initiated_at: nowIso(),
      current_phase: 'gate_check',
      status: 'pending',
      approvals_granted: {},
      approvals_pending: [],
      last_checkpoint: '',
      can_resume_from: 'gate_check',
      total_duration_minutes: 0,
      tokens_used_for_verification: 0,
      tokens_remaining: 0,
    }
  }

  getContext(): DeploymentContext {
    return structuredClone(this.context)
  }

  getCoordinatorPrompt(): string {
    return buildCoordinatorPrompt(this.context)
  }

  async grantApproval(
    phase: 'dispatch' | 'production_promote',
    notes?: string,
  ): Promise<void> {
    const key = approvalKey(phase)
    this.context.approvals_granted[key] = {
      timestamp: nowIso(),
      ...(notes ? { notes } : {}),
    }
    this.context.approvals_pending = this.context.approvals_pending.filter(
      item => item !== key,
    )
    if (phase === 'dispatch') {
      this.context.can_resume_from = 'staging_deploy'
    }
    if (phase === 'production_promote') {
      this.context.can_resume_from = 'production_promote'
    }
    this.context.status = 'running'
    await this.persistContext(this.context.current_phase)
  }

  async gateCheck(): Promise<GateCheckOutput> {
    this.ensureEnabled()
    this.context.status = 'running'

    const workerResults = await this.workerFactory.spawnGateCheckWorkers(
      this.deploymentTarget,
    )
    const blockers = extractBlockers(workerResults)
    const riskLevel = determineRiskLevel(workerResults)
    const readyForDispatch = blockers.length === 0

    const output: GateCheckOutput = {
      phase: 'gate_check',
      timestamp: nowIso(),
      ready_for_dispatch: readyForDispatch,
      risk_level: riskLevel,
      blockers,
      worker_results: workerResults,
      change_summary: aggregateChangeSummary(workerResults),
      estimated_duration_minutes: Math.max(
        5,
        Math.ceil(
          workerResults.reduce(
            (total, result) => total + result.duration_ms,
            0,
          ) / 60_000,
        ),
      ),
      required_approvals: readyForDispatch && !this.skipApprovals ? ['dispatch'] : [],
    }

    this.context.gate_check = output
    this.context.current_phase = 'gate_check'
    this.context.can_resume_from = readyForDispatch ? 'dispatch' : 'gate_check'
    this.context.status = readyForDispatch ? 'running' : 'failed'
    await this.persistContext('gate_check')

    return output
  }

  async dispatch(): Promise<DispatchOutput> {
    this.ensureEnabled()
    if (!this.context.gate_check) {
      throw new Error('Cannot dispatch before gate check completes.')
    }
    if (!this.context.gate_check.ready_for_dispatch) {
      throw new Error('Gate check reported blockers; dispatch is not allowed.')
    }

    const spec = this.buildDeploymentSpec(this.context.gate_check)
    const approval = buildApprovalRequest(
      'dispatch',
      {
        reasoning: spec.risk_assessment.rationale,
        risk_assessment: spec.risk_assessment.mitigation_strategy,
        change_summary: `${this.context.gate_check.change_summary.files_changed} files changed, +${this.context.gate_check.change_summary.lines_added}/-${this.context.gate_check.change_summary.lines_removed}`,
        stakeholders: spec.approval_requirements.stakeholders,
      },
      {
        next_action: 'Begin staged rollout in staging after approval.',
        strategy: spec.decision_notes,
      },
    )

    const output: DispatchOutput = {
      phase: 'dispatch',
      timestamp: nowIso(),
      deployment_spec: spec,
      approval_request: {
        title: approval.title,
        reasoning: approval.reasoning,
        changes_summary: approval.changes_summary,
        risk_assessment: approval.risk_assessment,
      },
      coordinator_ready: true,
    }

    this.context.dispatch = output
    this.context.current_phase = 'dispatch'
    this.context.tokens_remaining = spec.verification_token_budget
    if (spec.approval_requirements.gate_check_approval_required && !this.skipApprovals) {
      this.context.approvals_pending = [approvalKey('dispatch')]
      this.context.status = 'paused_for_approval'
      this.context.can_resume_from = 'dispatch'
    } else {
      this.context.approvals_pending = this.context.approvals_pending.filter(
        item => item !== approvalKey('dispatch'),
      )
      this.context.status = 'running'
      this.context.can_resume_from = 'staging_deploy'
      if (this.skipApprovals) {
        this.context.approvals_granted[approvalKey('dispatch')] = {
          timestamp: nowIso(),
          notes: 'Auto-approved by skipApprovals',
        }
      }
    }

    await this.persistContext('dispatch')
    return output
  }

  async stagingDeploy(): Promise<StagingDeployOutput> {
    this.ensureEnabled()
    const spec = this.requireDeploymentSpec()
    this.ensureApprovalSatisfied('dispatch', spec.approval_requirements.gate_check_approval_required)

    const result = await this.workerFactory.spawnStagingDeployWorker(
      this.deploymentTarget,
      spec,
    )

    this.context.staging_deploy = result
    this.context.current_phase = 'staging_deploy'
    this.context.can_resume_from =
      result.status === 'deployed' ? 'verify' : 'staging_deploy'
    this.context.status =
      result.status === 'deployed'
        ? 'running'
        : result.status === 'rolled_back'
          ? 'rolled_back'
          : 'failed'

    const latestMetrics = this.extractLatestMetrics(result)
    if (latestMetrics) {
      await this.metricsCollector.persistMetrics(
        this.context.deployment_id,
        'staging_deploy',
        latestMetrics,
        this.deploymentTarget,
      )
    }

    await this.persistContext('staging_deploy')
    return result
  }

  async verify(): Promise<VerificationReport> {
    this.ensureEnabled()
    if (!this.context.staging_deploy) {
      throw new Error('Cannot verify before staging deployment completes.')
    }
    if (this.context.staging_deploy.status !== 'deployed') {
      throw new Error('Cannot verify because staging deployment is not healthy.')
    }
    const spec = this.requireDeploymentSpec()

    const report = await this.workerFactory.spawnVerificationWorker(
      this.deploymentTarget,
      JSON.stringify(this.context.staging_deploy, null, 2),
      spec.verification_token_budget,
    )

    const baseline = await this.metricsCollector.getBaseline(this.deploymentTarget)
    const currentMetrics = this.extractVerificationMetrics(report)
    const regression =
      baseline && currentMetrics
        ? this.metricsCollector.compareToBaseline(currentMetrics, baseline)
        : null

    this.context.verify = regression
      ? {
          ...report,
          performance_delta: {
            ...report.performance_delta,
            regression_detected:
              report.performance_delta.regression_detected ||
              regression.regression_detected,
            p99_latency_delta_ms:
              regression.p99_latency_delta_ms ||
              report.performance_delta.p99_latency_delta_ms,
            error_rate_delta_percent:
              regression.error_rate_delta_percent ||
              report.performance_delta.error_rate_delta_percent,
            throughput_delta_percent:
              regression.throughput_delta_percent ||
              report.performance_delta.throughput_delta_percent,
          },
        }
      : report

    const shouldPromote = this.promotionDecision()
    this.context.current_phase = 'verify'
    this.context.tokens_used_for_verification =
      spec.verification_token_budget
    this.context.tokens_remaining = 0
    this.context.can_resume_from = shouldPromote ? 'production_promote' : 'verify'
    this.context.status = shouldPromote ? 'running' : 'failed'

    if (currentMetrics) {
      await this.metricsCollector.persistMetrics(
        this.context.deployment_id,
        'verify',
        currentMetrics,
      )
    }

    await this.persistContext('verify')
    return this.context.verify
  }

  promotionDecision(): boolean {
    const report = this.context.verify
    if (!report) {
      return false
    }

    if (report.go_no_go_recommendation === 'no_go') {
      return false
    }

    if (report.confidence_score < 60) {
      return false
    }

    return true
  }

  async productionPromote(): Promise<ProductionDeployOutput> {
    this.ensureEnabled()
    const spec = this.requireDeploymentSpec()
    if (!this.context.verify) {
      throw new Error('Cannot promote before verification completes.')
    }
    if (!this.promotionDecision()) {
      throw new Error('Verification did not approve production promotion.')
    }

    if (
      spec.approval_requirements.production_approval_required &&
      !this.skipApprovals &&
      !this.context.approvals_granted[approvalKey('production_promote')]
    ) {
      this.context.approvals_pending = [
        ...new Set([
          ...this.context.approvals_pending,
          approvalKey('production_promote'),
        ]),
      ]
      this.context.status = 'paused_for_approval'
      this.context.can_resume_from = 'verify'
      await this.persistContext('verify')
      throw new Error('Production approval is required before promotion.')
    }

    if (this.skipApprovals) {
      this.context.approvals_granted[approvalKey('production_promote')] = {
        timestamp: nowIso(),
        notes: 'Auto-approved by skipApprovals',
      }
    }

    const output = await this.workerFactory.spawnProductionDeployWorker(
      this.deploymentTarget,
      spec,
      this.context.verify,
    )

    this.context.production_promote = output
    this.context.current_phase =
      output.status === 'deployed' && output.fully_deployed
        ? 'completed'
        : output.status === 'rolled_back'
          ? 'rolled_back'
          : 'failed'
    this.context.can_resume_from =
      this.context.current_phase === 'completed'
        ? 'completed'
        : this.context.current_phase === 'rolled_back'
          ? 'rolled_back'
          : 'production_promote'
    this.context.status =
      this.context.current_phase === 'completed'
        ? 'completed'
        : this.context.current_phase === 'rolled_back'
          ? 'rolled_back'
          : 'failed'

    await this.metricsCollector.persistMetrics(
      this.context.deployment_id,
      'production_promote',
      output.health_check_metrics,
      this.deploymentTarget,
    )

    await this.persistContext('production_promote')
    return output
  }

  async resume(fromPhase?: DeploymentPhase): Promise<void> {
    const loaded =
      (await this.checkpointStorage.loadCheckpoint(this.context.deployment_id)) ??
      (await this.checkpointStorage.loadLatestCheckpointForTarget(
        this.deploymentTarget,
      ))

    if (!loaded) {
      throw new Error('No deployment checkpoint found to resume.')
    }

    if (
      fromPhase &&
      loaded.current_phase !== fromPhase &&
      loaded.can_resume_from !== fromPhase
    ) {
      throw new Error(
        `Checkpoint cannot resume from ${fromPhase}; current phase is ${loaded.current_phase} and next resumable phase is ${loaded.can_resume_from}.`,
      )
    }

    this.context = loaded

    if (this.context.status === 'paused_for_approval') {
      return
    }

    let nextPhase = this.context.can_resume_from
    while (
      nextPhase !== 'completed' &&
      nextPhase !== 'failed' &&
      nextPhase !== 'rolled_back'
    ) {
      if (nextPhase === 'dispatch' && !this.context.dispatch) {
        await this.dispatch()
      } else if (nextPhase === 'staging_deploy' && !this.context.staging_deploy) {
        await this.stagingDeploy()
      } else if (nextPhase === 'verify' && !this.context.verify) {
        await this.verify()
      } else if (
        nextPhase === 'production_promote' &&
        !this.context.production_promote
      ) {
        await this.productionPromote()
      } else if (nextPhase === 'gate_check' && !this.context.gate_check) {
        await this.gateCheck()
      } else {
        break
      }

      if (this.context.status === 'paused_for_approval') {
        break
      }
      nextPhase = this.context.can_resume_from
    }
  }

  private ensureEnabled(): void {
    if (!this.featureGates.enabled) {
      throw new Error(
        'Deployment orchestrator is disabled by feature gate.',
      )
    }
  }

  private requireDeploymentSpec(): DeploymentSpec {
    if (!this.context.dispatch) {
      throw new Error('Dispatch phase has not completed.')
    }
    return this.context.dispatch.deployment_spec
  }

  private ensureApprovalSatisfied(
    phase: 'dispatch' | 'production_promote',
    approvalRequired: boolean,
  ): void {
    if (!approvalRequired || this.skipApprovals) {
      return
    }
    if (!this.context.approvals_granted[approvalKey(phase)]) {
      this.context.approvals_pending = [
        ...new Set([...this.context.approvals_pending, approvalKey(phase)]),
      ]
      this.context.status = 'paused_for_approval'
      throw new Error(`${phase} approval is required before continuing.`)
    }
  }

  private buildDeploymentSpec(gateCheck: GateCheckOutput): DeploymentSpec {
    const canaryPercentStart = this.canaryPercentOverride
      ? Math.min(100, Math.max(1, Math.round(this.canaryPercentOverride)))
      : this.featureGates.canary_percent_start

    const stagingStages = buildCanaryStages(
      gateCheck.risk_level,
      canaryPercentStart,
      'staging',
    )
    const productionStages = buildCanaryStages(
      gateCheck.risk_level,
      canaryPercentStart,
      'production',
    )
    const estimatedTotalDuration =
      gateCheck.estimated_duration_minutes +
      stagingStages.reduce((total, stage) => total + stage.duration_minutes, 0) +
      productionStages.reduce((total, stage) => total + stage.duration_minutes, 0) +
      30

    const decisionNotes = `Risk ${gateCheck.risk_level}. Start at ${canaryPercentStart}% and expand only after metrics remain within threshold.`
    const spec: DeploymentSpec = {
      phase: 'dispatch',
      timestamp: nowIso(),
      deployment_id: this.context.deployment_id,
      risk_assessment: {
        overall_risk: gateCheck.risk_level,
        rationale: `Gate check returned ${gateCheck.blockers.length} blockers and ${gateCheck.worker_results.reduce((total, result) => total + result.warnings.length, 0)} warnings.`,
        mitigation_strategy:
          gateCheck.risk_level === 'high' || gateCheck.risk_level === 'critical'
            ? 'Use slower canary progression with stricter auto-rollback gates and explicit production approval.'
            : 'Use standard canary progression with automatic rollback and independent verification before promotion.',
      },
      staging: {
        canary_stages: stagingStages,
        validation_gates: [
          'error_rate_percent',
          'p99_latency_ms',
          'memory_usage_percent',
        ],
      },
      production: {
        canary_stages: productionStages,
        validation_gates: [
          'error_rate_percent',
          'p99_latency_ms',
          'memory_usage_percent',
        ],
        rollback_triggers: [] as RollbackTrigger[],
      },
      verification_token_budget:
        gateCheck.risk_level === 'critical'
          ? 30_000
          : gateCheck.risk_level === 'high'
            ? 25_000
            : gateCheck.risk_level === 'medium'
              ? 20_000
              : 15_000,
      timeout_minutes:
        gateCheck.risk_level === 'critical'
          ? 180
          : gateCheck.risk_level === 'high'
            ? 150
            : 120,
      approval_requirements: {
        gate_check_approval_required: !this.skipApprovals,
        production_approval_required: !this.skipApprovals,
        stakeholders:
          gateCheck.risk_level === 'critical'
            ? ['owner', 'security', 'ops']
            : gateCheck.risk_level === 'high'
              ? ['owner', 'ops']
              : ['owner'],
      },
      estimated_total_duration_minutes: estimatedTotalDuration,
      created_by_coordinator: true,
      decision_notes: decisionNotes,
    }

    spec.production.rollback_triggers = buildRollbackTriggers(
      spec,
      this.featureGates.auto_rollback,
    )
    return spec
  }

  private extractLatestMetrics(
    output: StagingDeployOutput,
  ): StagingDeployOutput['canary_results'][number]['metrics'][number] | null {
    const stage = [...output.canary_results].reverse().find(result => result.metrics.length > 0)
    return stage ? stage.metrics[stage.metrics.length - 1] : null
  }

  private extractVerificationMetrics(
    report: VerificationReport,
  ): DeploymentMetrics | null {
    const performanceResult = report.test_results.find(
      result => result.test_category === 'performance' && result.passed,
    ) as
      | (VerificationReport['test_results'][number] & {
          metrics?: {
            latency_p99_ms?: number
            error_rate_percent?: number
            throughput_rps?: number
          }
        })
      | undefined

    if (!performanceResult?.metrics) {
      return null
    }

    return {
      timestamp: nowIso(),
      error_rate_percent: Number(
        performanceResult.metrics.error_rate_percent ?? 0,
      ),
      p99_latency_ms: Number(performanceResult.metrics.latency_p99_ms ?? 0),
      memory_usage_percent: 0,
      cpu_usage_percent: 0,
      request_count: Number(performanceResult.metrics.throughput_rps ?? 0),
      failed_requests: 0,
    }
  }

  private async persistContext(phase: DeploymentPhase): Promise<void> {
    this.context.total_duration_minutes = minutesSince(this.context.initiated_at)
    this.context.last_checkpoint = await this.checkpointStorage.saveCheckpoint(
      this.context.deployment_id,
      phase,
      this.context,
      { deploymentTarget: this.deploymentTarget },
    )

    logEvent('tengu_deploy_phase_transition', {
      phase_index:
        phase === 'gate_check'
          ? 1
          : phase === 'dispatch'
            ? 2
            : phase === 'staging_deploy'
              ? 3
              : phase === 'verify'
                ? 4
                : 5,
      pending_approvals: this.context.approvals_pending.length,
      is_terminal:
        this.context.status === 'completed' ||
        this.context.status === 'failed' ||
        this.context.status === 'rolled_back',
    })
  }
}
