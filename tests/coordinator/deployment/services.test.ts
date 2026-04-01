import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'
import type { DeploymentContext } from '../../../src/types/deployment.ts'
import {
  defaultDeploymentFeatureGates,
  readDeploymentFeatureGates,
  resetDeploymentFeatureGateCache,
} from '../../../src/services/analytics/deployment.featureGates.ts'
import { WorkerFactory } from '../../../src/coordinator/deployment/workerFactory.ts'
import { CheckpointStorage } from '../../../src/services/deployment/checkpointStorage.ts'
import { MetricsCollector } from '../../../src/services/deployment/metricsCollector.ts'
import { createMockDeploymentWorkerInvoker } from '../../mocks/mockWorkers.ts'

test('deployment feature gates honor environment overrides', () => {
  const originalEnv = {
    USER_TYPE: process.env.USER_TYPE,
    CLAUDE_CODE_DEPLOY_ORCHESTRATOR_ENABLED:
      process.env.CLAUDE_CODE_DEPLOY_ORCHESTRATOR_ENABLED,
    CLAUDE_CODE_DEPLOY_AUTO_ROLLBACK:
      process.env.CLAUDE_CODE_DEPLOY_AUTO_ROLLBACK,
    CLAUDE_CODE_DEPLOY_CANARY_PERCENT:
      process.env.CLAUDE_CODE_DEPLOY_CANARY_PERCENT,
    CLAUDE_CODE_DEPLOY_EMERGENCY_SKIP_VERIFY:
      process.env.CLAUDE_CODE_DEPLOY_EMERGENCY_SKIP_VERIFY,
  }

  try {
    process.env.USER_TYPE = 'external'
    process.env.CLAUDE_CODE_DEPLOY_ORCHESTRATOR_ENABLED = 'true'
    process.env.CLAUDE_CODE_DEPLOY_AUTO_ROLLBACK = 'false'
    process.env.CLAUDE_CODE_DEPLOY_CANARY_PERCENT = '7'
    process.env.CLAUDE_CODE_DEPLOY_EMERGENCY_SKIP_VERIFY = 'true'

    resetDeploymentFeatureGateCache()
    const gates = readDeploymentFeatureGates({ forceRefresh: true })

    assert.deepEqual(gates, {
      enabled: true,
      auto_rollback: false,
      canary_percent_start: 7,
      emergency_skip_verify: true,
    })
    assert.equal(defaultDeploymentFeatureGates().enabled, false)
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    resetDeploymentFeatureGateCache()
  }
})

test('checkpoint storage saves, loads, lists, and tolerates corruption', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'deploy-checkpoints-'))

  try {
    const storage = new CheckpointStorage(tempDir)
    const context = {
      deployment_id: 'dep-1',
      initiated_at: '2026-04-01T12:00:00.000Z',
      current_phase: 'dispatch',
      status: 'paused_for_approval',
      approvals_granted: {},
      approvals_pending: ['dispatch_approval'],
      last_checkpoint: '',
      can_resume_from: 'dispatch',
      total_duration_minutes: 4,
      tokens_used_for_verification: 0,
      tokens_remaining: 15000,
    } satisfies DeploymentContext

    const checkpointPath = await storage.saveCheckpoint(
      'dep-1',
      'dispatch',
      context,
      { deploymentTarget: 'api-prod' },
    )

    assert.equal(checkpointPath, join(tempDir, 'dep-1', 'context.json'))
    assert.deepEqual(await storage.loadCheckpoint('dep-1'), context)
    assert.deepEqual(await storage.listCheckpoints(), ['dep-1'])
    assert.equal(
      (await storage.loadLatestCheckpointForTarget('api-prod'))?.deployment_id,
      'dep-1',
    )

    await writeFile(checkpointPath, '{not-valid-json', 'utf8')
    assert.equal(await storage.loadCheckpoint('dep-1'), null)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('metrics collector computes error rates, persists baselines, and detects regressions', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'deploy-metrics-'))

  try {
    const collector = new MetricsCollector(
      {
        collect: async () => ({
          timestamp: '2026-04-01T12:00:00.000Z',
          p99_latency_ms: 330,
          memory_usage_percent: 55,
          cpu_usage_percent: 31,
          request_count: 200,
          failed_requests: 4,
        }),
      },
      tempDir,
    )

    const current = await collector.collect('api-prod')
    assert.equal(current.error_rate_percent, 2)

    await collector.persistMetrics('dep-2', 'verify', current, 'api-prod')
    const baseline = await collector.getBaseline('api-prod')
    assert.deepEqual(baseline, current)

    const regression = collector.compareToBaseline(current, {
      ...current,
      p99_latency_ms: 250,
      error_rate_percent: 1.2,
      request_count: 240,
    })

    assert.equal(regression.regression_detected, true)
    assert.match(regression.reasons.join(' | '), /latency increased/)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('default metrics provider honors env-backed metric overrides', async () => {
  const previous = process.env.CLAUDE_CODE_DEPLOYMENT_METRICS_JSON

  try {
    process.env.CLAUDE_CODE_DEPLOYMENT_METRICS_JSON = JSON.stringify({
      error_rate_percent: 1.75,
      p99_latency_ms: 410,
      memory_usage_percent: 64,
      cpu_usage_percent: 39,
      request_count: 320,
      failed_requests: 6,
    })

    const collector = new MetricsCollector(undefined, join(tmpdir(), 'noop'))
    const metrics = await collector.collect('api-prod', 1000)

    assert.equal(metrics.error_rate_percent, 1.75)
    assert.equal(metrics.p99_latency_ms, 410)
    assert.equal(metrics.request_count, 320)
    assert.equal(metrics.failed_requests, 6)
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_CODE_DEPLOYMENT_METRICS_JSON
    } else {
      process.env.CLAUDE_CODE_DEPLOYMENT_METRICS_JSON = previous
    }
  }
})

test('worker factory retries malformed output and normalizes a valid response', async () => {
  let attempts = 0
  const workerFactory = new WorkerFactory(
    createMockDeploymentWorkerInvoker(invocation => {
      attempts += 1
      if (attempts === 1) {
        return 'not valid json'
      }

      assert.equal(invocation.kind, 'staging_deploy')
      return {
        phase: 'staging_deploy',
        timestamp: '2026-04-01T12:05:00.000Z',
        deployment_id: 'dep-stage',
        environment: 'staging',
        status: 'deployed',
        canary_results: [],
        currently_deployed_percentage: 100,
        deployment_artifact: {
          version: '1.2.3',
          commit_sha: 'abc123',
          deployment_time: '2026-04-01T12:05:00.000Z',
        },
        checkpoint_file: '/tmp/dep-stage.checkpoint',
        recovery_possible: true,
      }
    }),
  )

  const result = await workerFactory.spawnStagingDeployWorker(
    'api-prod',
    {
      phase: 'dispatch',
      timestamp: '2026-04-01T12:00:00.000Z',
      deployment_id: 'dep-stage',
      risk_assessment: {
        overall_risk: 'low',
        rationale: 'No blockers.',
        mitigation_strategy: 'Small canary.',
      },
      staging: {
        canary_stages: [],
        validation_gates: ['error_rate_percent'],
      },
      production: {
        canary_stages: [],
        validation_gates: ['error_rate_percent'],
        rollback_triggers: [],
      },
      verification_token_budget: 15000,
      timeout_minutes: 120,
      approval_requirements: {
        gate_check_approval_required: false,
        production_approval_required: false,
        stakeholders: ['owner'],
      },
      estimated_total_duration_minutes: 40,
      created_by_coordinator: true,
      decision_notes: 'Proceed.',
    },
  )

  assert.equal(result.status, 'deployed')
  assert.equal(attempts, 2)
})
