import type {
  DeploymentMetrics,
  DeploymentPhase,
} from '../../src/types/deployment.ts'
import {
  MetricsCollector,
  type RegressionAnalysis,
} from '../../src/services/deployment/metricsCollector.ts'

export function createMockMetrics(
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

export class MockMetricsCollector {
  readonly persisted: Array<{
    deploymentId: string
    phase: DeploymentPhase
    metrics: DeploymentMetrics
    serviceName?: string
  }> = []

  private readonly comparator = new MetricsCollector({
    collect: async () => null,
  })

  constructor(
    private readonly collected: DeploymentMetrics = createMockMetrics(),
    private readonly baseline: DeploymentMetrics | null = createMockMetrics({
      timestamp: '2026-03-31T12:00:00.000Z',
      error_rate_percent: 0.1,
      p99_latency_ms: 200,
      request_count: 950,
      failed_requests: 1,
    }),
  ) {}

  async collect(): Promise<DeploymentMetrics> {
    return structuredClone(this.collected)
  }

  async getBaseline(): Promise<DeploymentMetrics | null> {
    return this.baseline ? structuredClone(this.baseline) : null
  }

  compareToBaseline(
    current: DeploymentMetrics,
    baseline: DeploymentMetrics,
  ): RegressionAnalysis {
    return this.comparator.compareToBaseline(current, baseline)
  }

  async persistMetrics(
    deploymentId: string,
    phase: DeploymentPhase,
    metrics: DeploymentMetrics,
    serviceName?: string,
  ): Promise<string> {
    this.persisted.push({
      deploymentId,
      phase,
      metrics: structuredClone(metrics),
      serviceName,
    })
    return `mock://metrics/${deploymentId}/${phase}.json`
  }
}
