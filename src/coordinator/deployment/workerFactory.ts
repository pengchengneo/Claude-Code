import type {
  DeploymentSpec,
  GateCheckWorkerResult,
  ProductionDeployOutput,
  StagingDeployOutput,
  VerificationReport,
} from '../../types/deployment.js'
import { buildGateCheckPrompt } from './gateCheckWorker.prompt.js'
import { buildStagingDeployPrompt } from './stagingDeployWorker.prompt.js'
import { buildVerificationPrompt } from './verificationWorker.prompt.js'

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000
const MAX_ATTEMPTS = 3

export type DeploymentWorkerKind =
  | 'gate_check'
  | 'staging_deploy'
  | 'verification'
  | 'production_promote'

export type DeploymentWorkerInvocation = {
  kind: DeploymentWorkerKind
  prompt: string
  description: string
  timeoutMs: number
  attempt: number
}

export type DeploymentWorkerInvoker = (
  invocation: DeploymentWorkerInvocation,
) => Promise<unknown>

type GateCheckWorkerType =
  | 'syntax_validation'
  | 'health_check'
  | 'change_impact'
  | 'security_compliance'

export class UnconfiguredDeploymentWorkerInvokerError extends Error {
  constructor() {
    super(
      'Deployment worker invoker is not configured. Inject one into WorkerFactory before running deployment phases that require workers.',
    )
    this.name = 'UnconfiguredDeploymentWorkerInvokerError'
  }
}

function defaultInvoker(): DeploymentWorkerInvoker {
  return async () => {
    throw new UnconfiguredDeploymentWorkerInvokerError()
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function parseJsonOutput(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>
  }

  if (typeof raw === 'string') {
    const parsed = safeParseJson(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  }

  throw new Error('Worker returned invalid JSON output.')
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function normalizeGateCheckResult(
  workerType: GateCheckWorkerType,
  raw: unknown,
): GateCheckWorkerResult & { specific_findings?: Record<string, unknown> } {
  const parsed = parseJsonOutput(raw)
  if (
    parsed.worker_type !== workerType ||
    typeof parsed.passed !== 'boolean' ||
    !isStringArray(parsed.errors) ||
    !isStringArray(parsed.warnings) ||
    typeof parsed.duration_ms !== 'number'
  ) {
    throw new Error(`Gate check worker ${workerType} returned malformed output.`)
  }

  return {
    worker_type: parsed.worker_type,
    passed: parsed.passed,
    errors: parsed.errors,
    warnings: parsed.warnings,
    duration_ms: parsed.duration_ms,
    specific_findings:
      parsed.specific_findings &&
      typeof parsed.specific_findings === 'object' &&
      !Array.isArray(parsed.specific_findings)
        ? (parsed.specific_findings as Record<string, unknown>)
        : undefined,
  }
}

function isCanaryResults(value: unknown): boolean {
  return Array.isArray(value)
}

function normalizeStagingDeployOutput(raw: unknown): StagingDeployOutput {
  const parsed = parseJsonOutput(raw)
  if (
    parsed.phase !== 'staging_deploy' ||
    typeof parsed.deployment_id !== 'string' ||
    parsed.environment !== 'staging' ||
    typeof parsed.status !== 'string' ||
    !isCanaryResults(parsed.canary_results) ||
    typeof parsed.currently_deployed_percentage !== 'number' ||
    !parsed.deployment_artifact ||
    typeof parsed.checkpoint_file !== 'string' ||
    typeof parsed.recovery_possible !== 'boolean'
  ) {
    throw new Error('Staging deployment worker returned malformed output.')
  }

  return parsed as unknown as StagingDeployOutput
}

function normalizeVerificationReport(raw: unknown): VerificationReport {
  const parsed = parseJsonOutput(raw)
  if (
    parsed.phase !== 'verify' ||
    typeof parsed.deployment_id !== 'string' ||
    !Array.isArray(parsed.test_results) ||
    typeof parsed.all_tests_passed !== 'boolean' ||
    !parsed.performance_delta ||
    typeof parsed.confidence_score !== 'number' ||
    typeof parsed.go_no_go_recommendation !== 'string' ||
    parsed.verified_by_independent_worker !== true ||
    typeof parsed.verification_duration_minutes !== 'number'
  ) {
    throw new Error('Verification worker returned malformed output.')
  }

  return parsed as unknown as VerificationReport
}

function normalizeProductionDeployOutput(
  raw: unknown,
): ProductionDeployOutput {
  const parsed = parseJsonOutput(raw)
  if (
    parsed.phase !== 'production_promote' ||
    typeof parsed.deployment_id !== 'string' ||
    parsed.environment !== 'production' ||
    typeof parsed.status !== 'string' ||
    !Array.isArray(parsed.canary_results) ||
    typeof parsed.fully_deployed !== 'boolean' ||
    typeof parsed.health_check_passed !== 'boolean' ||
    !parsed.health_check_metrics ||
    typeof parsed.deploy_id !== 'string'
  ) {
    throw new Error('Production deployment worker returned malformed output.')
  }

  return parsed as unknown as ProductionDeployOutput
}

function buildProductionDeployPrompt(
  deploymentTarget: string,
  deploymentSpec: DeploymentSpec,
  verificationReport: VerificationReport,
): string {
  return `# Production Deploy Worker

Execute the approved production rollout for ${deploymentTarget}.

Deployment spec:
\`\`\`json
${JSON.stringify(deploymentSpec, null, 2)}
\`\`\`

Verification report:
\`\`\`json
${JSON.stringify(verificationReport, null, 2)}
\`\`\`

Requirements:
- Follow the production canary stages exactly as specified.
- Auto-rollback immediately if any production validation gate is exceeded.
- Record metrics for each stage.
- Run a final post-deploy health check.

Return raw JSON matching ProductionDeployOutput exactly.`
}

export class WorkerFactory {
  constructor(
    private readonly invoker: DeploymentWorkerInvoker = defaultInvoker(),
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  async spawnGateCheckWorkers(
    deploymentTarget: string,
  ): Promise<Array<GateCheckWorkerResult & { specific_findings?: Record<string, unknown> }>> {
    const workerTypes: GateCheckWorkerType[] = [
      'syntax_validation',
      'health_check',
      'change_impact',
      'security_compliance',
    ]

    return Promise.all(
      workerTypes.map(async workerType => {
        try {
          return await this.invokeWithRetry(
            {
              kind: 'gate_check',
              prompt: buildGateCheckPrompt(workerType, deploymentTarget),
              description: `Deployment gate check: ${workerType}`,
              timeoutMs: this.timeoutMs,
            },
            raw => normalizeGateCheckResult(workerType, raw),
          )
        } catch (error) {
          return {
            worker_type: workerType,
            passed: false,
            errors: [
              error instanceof Error
                ? error.message
                : 'Unknown gate check worker failure.',
            ],
            warnings: [],
            duration_ms: 0,
          }
        }
      }),
    )
  }

  async spawnStagingDeployWorker(
    deploymentTarget: string,
    spec: DeploymentSpec,
  ): Promise<StagingDeployOutput> {
    return this.invokeWithRetry(
      {
        kind: 'staging_deploy',
        prompt: buildStagingDeployPrompt(
          JSON.stringify(spec, null, 2),
          deploymentTarget,
        ),
        description: `Staging deploy for ${deploymentTarget}`,
        timeoutMs: this.timeoutMs,
      },
      normalizeStagingDeployOutput,
    )
  }

  async spawnVerificationWorker(
    deploymentTarget: string,
    stagingSummary: string,
    tokenBudget: number,
  ): Promise<VerificationReport> {
    return this.invokeWithRetry(
      {
        kind: 'verification',
        prompt: buildVerificationPrompt(
          deploymentTarget,
          stagingSummary,
          tokenBudget,
        ),
        description: `Verification for ${deploymentTarget}`,
        timeoutMs: this.timeoutMs,
      },
      normalizeVerificationReport,
    )
  }

  async spawnProductionDeployWorker(
    deploymentTarget: string,
    spec: DeploymentSpec,
    verification: VerificationReport,
  ): Promise<ProductionDeployOutput> {
    return this.invokeWithRetry(
      {
        kind: 'production_promote',
        prompt: buildProductionDeployPrompt(
          deploymentTarget,
          spec,
          verification,
        ),
        description: `Production deploy for ${deploymentTarget}`,
        timeoutMs: this.timeoutMs,
      },
      normalizeProductionDeployOutput,
    )
  }

  private async invokeWithRetry<T>(
    baseInvocation: Omit<DeploymentWorkerInvocation, 'attempt'>,
    validator: (raw: unknown) => T,
  ): Promise<T> {
    let lastError: unknown

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        const raw = await this.invoker({
          ...baseInvocation,
          attempt,
        })
        return validator(raw)
      } catch (error) {
        lastError = error
        if (attempt < MAX_ATTEMPTS) {
          await sleep(100 * 2 ** (attempt - 1))
        }
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error('Deployment worker failed after maximum retry attempts.')
  }
}
