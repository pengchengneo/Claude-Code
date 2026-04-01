import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'
import { DeploymentCoordinator } from '../../../src/coordinator/deployment/deploymentCoordinator.ts'
import { CheckpointStorage } from '../../../src/services/deployment/checkpointStorage.ts'
import { createMockFeatureGates } from '../../mocks/mockFeatureGates.ts'
import {
  MockMetricsCollector,
  createMockMetrics,
} from '../../mocks/mockMetricsCollector.ts'
import {
  MockWorkerFactory,
  createGateCheckWorkers,
  createProductionDeployOutput,
  createStagingDeployOutput,
  createVerificationReport,
} from '../../mocks/mockWorkers.ts'

test('deployment coordinator runs the full approval-driven happy path', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'deploy-happy-path-'))

  try {
    const checkpointStorage = new CheckpointStorage(join(tempDir, 'deployments'))
    const workerFactory = new MockWorkerFactory()
    const metricsCollector = new MockMetricsCollector()
    const coordinator = new DeploymentCoordinator('api-prod', {
      checkpointStorage,
      workerFactory: workerFactory as never,
      metricsCollector: metricsCollector as never,
      featureGates: createMockFeatureGates(),
    })

    const gateCheck = await coordinator.gateCheck()
    assert.equal(gateCheck.ready_for_dispatch, true)

    const dispatch = await coordinator.dispatch()
    assert.equal(dispatch.phase, 'dispatch')
    assert.equal(coordinator.getContext().status, 'paused_for_approval')
    assert.deepEqual(coordinator.getContext().approvals_pending, [
      'dispatch_approval',
    ])

    await coordinator.grantApproval('dispatch', 'Reviewed by owner')
    await coordinator.stagingDeploy()
    await coordinator.verify()

    await assert.rejects(
      () => coordinator.productionPromote(),
      /Production approval is required before promotion\./,
    )

    assert.deepEqual(coordinator.getContext().approvals_pending, [
      'production_promote_approval',
    ])

    await coordinator.grantApproval('production_promote', 'Approved for prod')
    const production = await coordinator.productionPromote()

    assert.equal(production.fully_deployed, true)
    assert.equal(coordinator.getContext().status, 'completed')
    assert.equal(coordinator.getContext().current_phase, 'completed')
    assert.equal(workerFactory.calls.join(','), [
      'gate_check',
      'staging_deploy',
      'verification',
      'production_promote',
    ].join(','))
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('deployment coordinator blocks promotion on a no-go verification result', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'deploy-no-go-'))

  try {
    const coordinator = new DeploymentCoordinator('api-prod', {
      checkpointStorage: new CheckpointStorage(join(tempDir, 'deployments')),
      workerFactory: new MockWorkerFactory({
        verification: createVerificationReport({
          confidence_score: 42,
          go_no_go_recommendation: 'no_go',
          all_tests_passed: false,
        }),
      }) as never,
      metricsCollector: new MockMetricsCollector(
        createMockMetrics(),
        createMockMetrics({
          error_rate_percent: 0.1,
          p99_latency_ms: 180,
        }),
      ) as never,
      featureGates: createMockFeatureGates(),
      skipApprovals: true,
    })

    await coordinator.gateCheck()
    await coordinator.dispatch()
    await coordinator.stagingDeploy()
    const verification = await coordinator.verify()

    assert.equal(verification.go_no_go_recommendation, 'no_go')
    assert.equal(coordinator.promotionDecision(), false)
    assert.equal(coordinator.getContext().status, 'failed')

    await assert.rejects(
      () => coordinator.productionPromote(),
      /Verification did not approve production promotion\./,
    )
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('deployment coordinator resume continues from the latest checkpoint for a target', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'deploy-resume-'))

  try {
    const checkpointStorage = new CheckpointStorage(join(tempDir, 'deployments'))
    const workerFactory = new MockWorkerFactory()
    const metricsCollector = new MockMetricsCollector()

    const firstRun = new DeploymentCoordinator('api-prod', {
      checkpointStorage,
      workerFactory: workerFactory as never,
      metricsCollector: metricsCollector as never,
      featureGates: createMockFeatureGates(),
      skipApprovals: true,
    })

    await firstRun.gateCheck()
    await firstRun.dispatch()

    const resumed = new DeploymentCoordinator('api-prod', {
      checkpointStorage,
      workerFactory: workerFactory as never,
      metricsCollector: metricsCollector as never,
      featureGates: createMockFeatureGates(),
      skipApprovals: true,
    })

    await resumed.resume()
    assert.equal(resumed.getContext().status, 'completed')
    assert.equal(resumed.getContext().current_phase, 'completed')
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('deployment coordinator respects the auto-rollback feature gate in the rollout spec', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'deploy-gates-'))

  try {
    const coordinator = new DeploymentCoordinator('api-prod', {
      checkpointStorage: new CheckpointStorage(join(tempDir, 'deployments')),
      workerFactory: new MockWorkerFactory({
        gateCheckWorkers: createGateCheckWorkers({
          change_impact: {
            specific_findings: {
              files_changed: 3,
              lines_added: 40,
              lines_removed: 10,
            },
          },
        }),
      }) as never,
      metricsCollector: new MockMetricsCollector() as never,
      featureGates: createMockFeatureGates({
        auto_rollback: false,
      }),
      skipApprovals: true,
    })

    await coordinator.gateCheck()
    const dispatch = await coordinator.dispatch()

    assert.deepEqual(
      dispatch.deployment_spec.production.rollback_triggers.map(
        trigger => trigger.action,
      ),
      ['approval_required', 'approval_required', 'approval_required'],
    )
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})
