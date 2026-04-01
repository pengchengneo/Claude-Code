import { createRequire } from 'module'
import type { DeploymentFeatureGates } from '../../types/deployment.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

const CACHE_TTL_MS = 60_000
const DEFAULT_CANARY_PERCENT = 2
const require = createRequire(import.meta.url)

type CachedDeploymentFeatureGates = {
  expiresAt: number
  value: DeploymentFeatureGates
}

let cachedDeploymentFeatureGates: CachedDeploymentFeatureGates | null = null

export function defaultDeploymentFeatureGates(): DeploymentFeatureGates {
  return {
    enabled: process.env.USER_TYPE === 'ant',
    auto_rollback: true,
    canary_percent_start: DEFAULT_CANARY_PERCENT,
    emergency_skip_verify: false,
  }
}

function readGrowthBookFeatureValue<T>(feature: string, fallback: T): T {
  try {
    const { getFeatureValue_CACHED_MAY_BE_STALE } = require('./growthbook.js') as
      typeof import('./growthbook.js')
    return getFeatureValue_CACHED_MAY_BE_STALE(feature, fallback) as T
  } catch {
    return fallback
  }
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_CANARY_PERCENT
  }
  return Math.min(100, Math.max(1, Math.round(value)))
}

function readBooleanEnvOverride(name: string): boolean | undefined {
  const raw = process.env[name]
  if (raw === undefined) {
    return undefined
  }
  return isEnvTruthy(raw)
}

function readNumberEnvOverride(name: string): number | undefined {
  const raw = process.env[name]
  if (raw === undefined) {
    return undefined
  }
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : undefined
}

function applyEnvOverrides(
  gates: DeploymentFeatureGates,
): DeploymentFeatureGates {
  const enabled =
    readBooleanEnvOverride('CLAUDE_CODE_DEPLOY_ORCHESTRATOR_ENABLED') ??
    gates.enabled
  const autoRollback =
    readBooleanEnvOverride('CLAUDE_CODE_DEPLOY_AUTO_ROLLBACK') ??
    gates.auto_rollback
  const emergencySkipVerify =
    readBooleanEnvOverride('CLAUDE_CODE_DEPLOY_EMERGENCY_SKIP_VERIFY') ??
    gates.emergency_skip_verify
  const canaryPercentStart = clampPercent(
    readNumberEnvOverride('CLAUDE_CODE_DEPLOY_CANARY_PERCENT') ??
      gates.canary_percent_start,
  )

  return {
    enabled,
    auto_rollback: autoRollback,
    canary_percent_start: canaryPercentStart,
    emergency_skip_verify: emergencySkipVerify,
  }
}

function readGrowthBookDeploymentFeatureGates(): DeploymentFeatureGates {
  const defaults = defaultDeploymentFeatureGates()

  const gates: DeploymentFeatureGates = {
    enabled: readGrowthBookFeatureValue(
      'tengu_deploy_orchestrator',
      defaults.enabled,
    ),
    auto_rollback: readGrowthBookFeatureValue(
      'tengu_deploy_auto_rollback',
      defaults.auto_rollback,
    ),
    canary_percent_start: clampPercent(
      readGrowthBookFeatureValue(
        'tengu_deploy_canary_percent',
        defaults.canary_percent_start,
      ),
    ),
    emergency_skip_verify: readGrowthBookFeatureValue(
      'tengu_deploy_emergency_skip_verify',
      defaults.emergency_skip_verify,
    ),
  }

  return applyEnvOverrides(gates)
}

export function readDeploymentFeatureGates(
  options?: { forceRefresh?: boolean },
): DeploymentFeatureGates {
  if (
    !options?.forceRefresh &&
    cachedDeploymentFeatureGates &&
    cachedDeploymentFeatureGates.expiresAt > Date.now()
  ) {
    return cachedDeploymentFeatureGates.value
  }

  const value = readGrowthBookDeploymentFeatureGates()
  cachedDeploymentFeatureGates = {
    value,
    expiresAt: Date.now() + CACHE_TTL_MS,
  }
  return value
}

export function resetDeploymentFeatureGateCache(): void {
  cachedDeploymentFeatureGates = null
}
