import type { DeploymentFeatureGates } from '../../src/types/deployment.ts'

export function createMockFeatureGates(
  overrides: Partial<DeploymentFeatureGates> = {},
): DeploymentFeatureGates {
  return {
    enabled: true,
    auto_rollback: true,
    canary_percent_start: 2,
    emergency_skip_verify: false,
    ...overrides,
  }
}
