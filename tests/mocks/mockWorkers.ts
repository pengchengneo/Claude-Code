import type {
  DeploymentMetrics,
  GateCheckWorkerResult,
  ProductionDeployOutput,
  StagingDeployOutput,
  VerificationReport,
} from '../../src/types/deployment.ts'
import type {
  DeploymentWorkerInvocation,
  DeploymentWorkerInvoker,
} from '../../src/coordinator/deployment/workerFactory.ts'

function baseMetrics(
  overrides: Partial<DeploymentMetrics> = {},
): DeploymentMetrics {
  return {
    timestamp: '2026-04-01T12:00:00.000Z',
    error_rate_percent: 0.2,
    p99_latency_ms: 220,
    memory_usage_percent: 48,
    cpu_usage_percent: 22,
    request_count: 1000,
    failed_requests: 2,
    ...overrides,
  }
}

export function createGateCheckWorkers(
  overrides: Partial<Record<GateCheckWorkerResult['worker_type'], Partial<GateCheckWorkerResult & {
    specific_findings?: Record<string, unknown>
  }>>> = {},
): Array<GateCheckWorkerResult & { specific_findings?: Record<string, unknown> }> {
  const results: Array<GateCheckWorkerResult & { specific_findings?: Record<string, unknown> }> = [
    {
      worker_type: 'syntax_validation',
      passed: true,
      errors: [],
      warnings: [],
      duration_ms: 750,
    },
    {
      worker_type: 'health_check',
      passed: true,
      errors: [],
      warnings: [],
      duration_ms: 900,
    },
    {
      worker_type: 'change_impact',
      passed: true,
      errors: [],
      warnings: [],
      duration_ms: 650,
      specific_findings: {
        files_changed: 6,
        lines_added: 120,
        lines_removed: 34,
        blast_radius: 'medium',
      },
    },
    {
      worker_type: 'security_compliance',
      passed: true,
      errors: [],
      warnings: [],
      duration_ms: 1100,
    },
  ]

  return results.map(result => ({
    ...result,
    ...(overrides[result.worker_type] ?? {}),
  }))
}

export function createStagingDeployOutput(
  overrides: Partial<StagingDeployOutput> = {},
): StagingDeployOutput {
  return {
    phase: 'staging_deploy',
    timestamp: '2026-04-01T12:05:00.000Z',
    deployment_id: 'dep-staging',
    environment: 'staging',
    status: 'deployed',
    canary_results: [
      {
        stage_name: '2% staging canary',
        target_percentage: 2,
        actual_percentage: 2,
        deployed: true,
        start_time: '2026-04-01T12:05:00.000Z',
        end_time: '2026-04-01T12:10:00.000Z',
        metrics: [baseMetrics()],
        rolled_back: false,
      },
    ],
    currently_deployed_percentage: 100,
    deployment_artifact: {
      version: '1.2.3',
      commit_sha: 'abc123def456',
      deployment_time: '2026-04-01T12:05:00.000Z',
    },
    checkpoint_file: '/tmp/mock-staging.checkpoint',
    recovery_possible: true,
    ...overrides,
  }
}

export function createVerificationReport(
  overrides: Partial<VerificationReport> = {},
): VerificationReport {
  const report = {
    phase: 'verify',
    timestamp: '2026-04-01T12:20:00.000Z',
    deployment_id: 'dep-verify',
    test_results: [
      {
        test_category: 'smoke',
        name: 'staging smoke',
        passed: true,
        duration_ms: 600,
      },
      {
        test_category: 'performance',
        name: 'latency baseline',
        passed: true,
        duration_ms: 1400,
        metrics: {
          latency_p99_ms: 210,
          error_rate_percent: 0.2,
          throughput_rps: 980,
        },
      },
    ],
    all_tests_passed: true,
    performance_delta: {
      p99_latency_delta_ms: 10,
      error_rate_delta_percent: 0.1,
      throughput_delta_percent: 3,
      regression_detected: false,
    },
    confidence_score: 88,
    go_no_go_recommendation: 'go',
    verified_by_independent_worker: true,
    verification_duration_minutes: 14,
    ...overrides,
  }

  return report as VerificationReport
}

export function createProductionDeployOutput(
  overrides: Partial<ProductionDeployOutput> = {},
): ProductionDeployOutput {
  return {
    phase: 'production_promote',
    timestamp: '2026-04-01T12:40:00.000Z',
    deployment_id: 'dep-prod',
    environment: 'production',
    status: 'deployed',
    promotion_approved: true,
    approval_timestamp: '2026-04-01T12:35:00.000Z',
    canary_results: [
      {
        stage_name: '2% production canary',
        target_percentage: 2,
        actual_percentage: 2,
        deployed: true,
        start_time: '2026-04-01T12:35:00.000Z',
        end_time: '2026-04-01T12:40:00.000Z',
        metrics: [baseMetrics()],
        rolled_back: false,
      },
    ],
    fully_deployed: true,
    rollout_complete_time: '2026-04-01T13:10:00.000Z',
    health_check_passed: true,
    health_check_metrics: baseMetrics({
      timestamp: '2026-04-01T13:10:00.000Z',
      request_count: 1200,
    }),
    deploy_id: 'deploy-123',
    duration_minutes: 30,
    ...overrides,
  }
}

export function createMockDeploymentWorkerInvoker(
  handler: (
    invocation: DeploymentWorkerInvocation,
  ) => unknown | Promise<unknown>,
): DeploymentWorkerInvoker {
  return async invocation => {
    const result = await handler(invocation)
    return typeof result === 'object' && result !== null
      ? structuredClone(result)
      : result
  }
}

type MockWorkerFactoryOptions = {
  gateCheckWorkers?: Array<GateCheckWorkerResult & { specific_findings?: Record<string, unknown> }>
  stagingDeploy?: StagingDeployOutput
  verification?: VerificationReport
  productionDeploy?: ProductionDeployOutput
}

export class MockWorkerFactory {
  readonly calls: DeploymentWorkerInvocation['kind'][] = []

  constructor(private readonly outputs: MockWorkerFactoryOptions = {}) {}

  async spawnGateCheckWorkers(): Promise<Array<GateCheckWorkerResult & { specific_findings?: Record<string, unknown> }>> {
    this.calls.push('gate_check')
    return structuredClone(
      this.outputs.gateCheckWorkers ?? createGateCheckWorkers(),
    )
  }

  async spawnStagingDeployWorker(): Promise<StagingDeployOutput> {
    this.calls.push('staging_deploy')
    return structuredClone(
      this.outputs.stagingDeploy ?? createStagingDeployOutput(),
    )
  }

  async spawnVerificationWorker(): Promise<VerificationReport> {
    this.calls.push('verification')
    return structuredClone(
      this.outputs.verification ?? createVerificationReport(),
    )
  }

  async spawnProductionDeployWorker(): Promise<ProductionDeployOutput> {
    this.calls.push('production_promote')
    return structuredClone(
      this.outputs.productionDeploy ?? createProductionDeployOutput(),
    )
  }
}
