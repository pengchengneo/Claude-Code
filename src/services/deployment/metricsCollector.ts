import { cpus, totalmem } from 'os'
import { dirname, join } from 'path'
import { mkdir, open, readFile, rename, stat, unlink } from 'fs/promises'
import type { DeploymentMetrics, DeploymentPhase } from '../../types/deployment.js'
import { logEvent } from '../analytics/index.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'

export type RegressionAnalysis = {
  regression_detected: boolean
  reasons: string[]
  p99_latency_delta_ms: number
  error_rate_delta_percent: number
  throughput_delta_percent: number
}

export type MetricsProvider = {
  collect: (
    serviceName: string,
    durationMs: number,
  ) => Promise<Partial<DeploymentMetrics> | null> | Partial<DeploymentMetrics> | null
}

const DEFAULT_METRICS_DURATION_MS = 60_000

function nowIso(): string {
  return new Date().toISOString()
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }
  return Math.min(100, Math.max(0, value))
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  await mkdir(dirname(filePath), {
    recursive: true,
    mode: 0o700,
  })

  let existingMode: number | undefined
  try {
    existingMode = (await stat(filePath)).mode
  } catch {}

  const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`
  const handle = await open(tempPath, 'w', existingMode ?? 0o600)
  try {
    await handle.writeFile(JSON.stringify(data, null, 2), { encoding: 'utf8' })
    await handle.datasync()
  } finally {
    await handle.close()
  }

  try {
    await rename(tempPath, filePath)
  } catch (error) {
    try {
      await unlink(tempPath)
    } catch {}
    throw error
  }
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-z0-9._-]+/gi, '-').toLowerCase()
}

class ProcessMetricsProvider implements MetricsProvider {
  async collect(
    _serviceName: string,
    durationMs: number,
  ): Promise<Partial<DeploymentMetrics>> {
    const envMetrics = safeParseJson(
      process.env.CLAUDE_CODE_DEPLOYMENT_METRICS_JSON,
    )
    const metricsFromEnv =
      envMetrics && typeof envMetrics === 'object'
        ? (envMetrics as Partial<DeploymentMetrics>)
        : {}

    const memoryUsage = process.memoryUsage()
    const cpuUsage = process.cpuUsage()
    const cpuCount = Math.max(cpus().length, 1)
    const cpuWindowMicros = Math.max(durationMs, 1) * 1000 * cpuCount
    const cpuPercent =
      ((cpuUsage.user + cpuUsage.system) / cpuWindowMicros) * 100

    return {
      timestamp: nowIso(),
      error_rate_percent: metricsFromEnv.error_rate_percent,
      p99_latency_ms: metricsFromEnv.p99_latency_ms,
      memory_usage_percent:
        metricsFromEnv.memory_usage_percent ??
        clampPercent((memoryUsage.rss / totalmem()) * 100),
      cpu_usage_percent:
        metricsFromEnv.cpu_usage_percent ?? clampPercent(cpuPercent),
      request_count: metricsFromEnv.request_count ?? 0,
      failed_requests: metricsFromEnv.failed_requests ?? 0,
    }
  }
}

export class MetricsCollector {
  constructor(
    private readonly provider: MetricsProvider = new ProcessMetricsProvider(),
    private readonly metricsRoot: string = join(
      getClaudeConfigHomeDir(),
      'deployments',
      'metrics',
    ),
  ) {}

  async collect(
    serviceName: string,
    durationMs: number = DEFAULT_METRICS_DURATION_MS,
  ): Promise<DeploymentMetrics> {
    const partial = (await this.provider.collect(serviceName, durationMs)) ?? {}
    const requestCount = Number(partial.request_count ?? 0)
    const failedRequests = Number(partial.failed_requests ?? 0)
    const errorRate =
      partial.error_rate_percent ??
      (requestCount > 0 ? (failedRequests / requestCount) * 100 : 0)

    const metrics: DeploymentMetrics = {
      timestamp:
        typeof partial.timestamp === 'string' ? partial.timestamp : nowIso(),
      error_rate_percent: Number(errorRate) || 0,
      p99_latency_ms: Number(partial.p99_latency_ms ?? 0),
      memory_usage_percent: clampPercent(
        Number(partial.memory_usage_percent ?? 0),
      ),
      cpu_usage_percent: clampPercent(Number(partial.cpu_usage_percent ?? 0)),
      request_count: requestCount,
      failed_requests: failedRequests,
    }

    logEvent('tengu_deploy_metrics_collected', {
      has_requests: metrics.request_count > 0,
      has_errors: metrics.failed_requests > 0,
    })

    return metrics
  }

  async getBaseline(serviceName: string): Promise<DeploymentMetrics | null> {
    const path = this.getBaselinePath(serviceName)
    try {
      const raw = await readFile(path, 'utf8')
      const parsed = safeParseJson(raw)
      if (
        parsed &&
        typeof parsed === 'object' &&
        'timestamp' in parsed &&
        'p99_latency_ms' in parsed
      ) {
        return parsed as DeploymentMetrics
      }
      return null
    } catch {
      return null
    }
  }

  compareToBaseline(
    current: DeploymentMetrics,
    baseline: DeploymentMetrics,
  ): RegressionAnalysis {
    const throughputBaseline = baseline.request_count
    const throughputCurrent = current.request_count
    const throughputDeltaPercent =
      throughputBaseline > 0
        ? ((throughputCurrent - throughputBaseline) / throughputBaseline) * 100
        : 0

    const p99LatencyDeltaMs = current.p99_latency_ms - baseline.p99_latency_ms
    const errorRateDeltaPercent =
      current.error_rate_percent - baseline.error_rate_percent

    const reasons: string[] = []
    if (
      baseline.p99_latency_ms > 0 &&
      p99LatencyDeltaMs > baseline.p99_latency_ms * 0.1
    ) {
      reasons.push('p99 latency increased by more than 10%')
    }
    if (errorRateDeltaPercent > 0.5) {
      reasons.push('error rate increased by more than 0.5%')
    }

    return {
      regression_detected: reasons.length > 0,
      reasons,
      p99_latency_delta_ms: p99LatencyDeltaMs,
      error_rate_delta_percent: errorRateDeltaPercent,
      throughput_delta_percent: throughputDeltaPercent,
    }
  }

  async persistMetrics(
    deploymentId: string,
    phase: DeploymentPhase,
    metrics: DeploymentMetrics,
    serviceName?: string,
  ): Promise<string> {
    const path = join(this.metricsRoot, deploymentId, `${phase}.json`)
    await atomicWriteJson(path, metrics)

    if (serviceName) {
      await atomicWriteJson(this.getBaselinePath(serviceName), metrics)
    }

    return path
  }

  private getBaselinePath(serviceName: string): string {
    return join(
      this.metricsRoot,
      'baselines',
      `${sanitizeName(serviceName)}.json`,
    )
  }
}
