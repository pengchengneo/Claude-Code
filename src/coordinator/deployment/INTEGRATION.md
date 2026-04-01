# Deployment Orchestrator: Integration Guide

## Overview

The deployment orchestrator is a 5-phase system for production deployments with:
- Structured safety gates at each phase
- Independent verification
- Auto-rollback on metrics
- Checkpoint/resume capability
- Full audit trail

**Architecture Pattern**: Borrowed from Claude Code's coordinator mode
- Coordinator: Central intelligence that synthesizes results
- Workers: Independent agents for each phase
- Checkpointing: Resume from interruption
- Feature gates: Runtime control without code changes

## File Structure

### Type Definitions
- `src/types/deployment.ts` - All data structures for 5 phases + state management

### Skill Entry Point
- `src/skills/bundled/deployOrchestrator.ts` - User-facing skill (`/deploy-orchestrator`)
- `src/skills/bundled/index.ts` - Registration (already updated)

### Worker Prompts
- `src/coordinator/deployment/gateCheckWorker.prompt.ts` - Phase 1: Validation workers
- `src/coordinator/deployment/stagingDeployWorker.prompt.ts` - Phase 3: Staged rollout
- `src/coordinator/deployment/verificationWorker.prompt.ts` - Phase 4: Independent verification

## How It Works

### User Invokes Skill

```
/deploy-orchestrator claude-code-prod --canary-percent 5
```

### Skill Generates Prompt

The skill's `getPromptForCommand()` builds a prompt that:
1. Explains the 5-phase workflow
2. Parses the user input (target, flags)
3. Explains what happens at each phase
4. Instructs Claude what to do

### Phase 1: GATE CHECK (Coordinator spawns 4 workers)

Coordinator calls `Agent` tool 4 times (in parallel):
```typescript
Agent {
  description: "Gate check worker: syntax_validation"
  prompt: buildGateCheckPrompt('syntax_validation', 'claude-code-prod')
  subagent_type: 'general-purpose'
}
```

Each worker returns:
```typescript
GateCheckWorkerResult {
  worker_type: 'syntax_validation',
  passed: true,
  errors: [],
  warnings: [],
  duration_ms: 2500,
  specific_findings: { ... }
}
```

Coordinator collects all 4 results → Creates `GateCheckOutput`

### Phase 2: DISPATCH (Coordinator synthesizes spec)

Coordinator reads gate check results and:
1. Determines risk level (low/medium/high/critical)
2. Decides canary strategy (percentages, thresholds)
3. Allocates verification token budget
4. Determines approval requirements

Creates `DeploymentSpec` and shows structured approval request:
```
Title: Production Deployment Spec Ready for Review
Reasoning: Based on gate check results, risk is [LEVEL]...
Changes: [FILES CHANGED], [LINES ADDED/REMOVED]
Risk Assessment: [SPECIFIC RISKS]
Thresholds: [ERROR_RATE], [LATENCY], [MEMORY]
```

User approves or rejects. If approved, continue to Phase 3.

### Phase 3: STAGING DEPLOY (Coordinator spawns deploy worker)

Coordinator calls `Agent` tool:
```typescript
Agent {
  description: "Staging deployment: metrics-driven rollout"
  prompt: buildStagingDeployPrompt(deploymentSpec, 'claude-code-prod')
  subagent_type: 'general-purpose'
}
```

Worker:
1. Deploys to stage 1 canary percentage
2. Monitors for specified duration
3. Checks metrics against thresholds
4. Auto-rollback if gates fail
5. Increments to next stage if gates pass
6. Persists checkpoint after each stage

Returns `StagingDeployOutput` with:
- `status`: 'deployed' | 'rolled_back' | 'failed'
- `canary_results`: Array of stage results with metrics
- `checkpoint_file`: Path to recovery state
- `recovery_possible`: true/false

### Phase 4: VERIFY (Coordinator spawns independent verification worker)

Coordinator calls `Agent` tool with DIFFERENT worker:
```typescript
Agent {
  description: "Independent verification: skeptical testing"
  prompt: buildVerificationPrompt(
    'claude-code-prod',
    stagingDeploymentSummary,
    verificationTokenBudget
  )
  subagent_type: 'general-purpose'
}
```

This worker:
1. Doesn't know the deploy worker (separate prompts)
2. Runs tests with features ENABLED
3. Performs smoke, load, integration, security tests
4. Detects regressions
5. Makes go/no-go recommendation

Returns `VerificationReport` with:
- `all_tests_passed`: boolean
- `confidence_score`: 0-100
- `go_no_go_recommendation`: 'go' | 'no_go' | 'conditional'
- `test_results`: Array of individual test results

### Phase 5: PRODUCTION PROMOTE (Coordinator asks for approval)

If verification recommendation is 'go' or 'conditional':
- Show approval request with verification results
- If approved: Spawn production deploy worker
- Same process as staging (canary stages, auto-rollback)

If verification recommendation is 'no_go':
- Recommend NOT proceeding to production
- Offer to investigate further or rollback staging

## State Management (DeploymentContext)

The coordinator maintains:
```typescript
DeploymentContext {
  deployment_id: string           // Unique ID for audit trail
  current_phase: DeploymentPhase  // Which phase we're in
  status: DeploymentStatus        // Running/paused/completed/failed

  gate_check?: GateCheckOutput    // Phase 1 results
  dispatch?: DispatchOutput       // Phase 2 results
  staging_deploy?: StagingDeployOutput  // Phase 3 results
  verify?: VerificationReport     // Phase 4 results
  production_promote?: ProductionDeployOutput  // Phase 5 results

  approvals_granted: Record<...>  // Who approved what, when
  approvals_pending: string[]     // Waiting for approval on

  last_checkpoint: string         // Path to recovery point
  can_resume_from: DeploymentPhase  // How to resume
}
```

## Recovery & Resume

If deployment is interrupted (user closes, timeout, etc.):

```
/deploy-orchestrator claude-code-prod --resume-from staging_deploy
```

Coordinator:
1. Loads `DeploymentContext` from disk
2. Validates resume is possible
3. Skips already-completed phases
4. Continues from next phase
5. Preserves all prior decisions in audit trail

## Feature Gates (GrowthBook Integration)

Feature gates control deployment behavior at runtime:

| Flag | Purpose | Default |
|------|---------|---------|
| `tengu_deploy_orchestrator` | Master enable/disable | false (external), true (internal) |
| `tengu_deploy_auto_rollback` | Auto-rollback when gates fail | true |
| `tengu_deploy_canary_percent` | Starting canary % | 2 |
| `tengu_deploy_emergency_skip_verify` | Allow --skip-approvals flag | false |

The skill checks feature gates in its `isEnabled()` callback.

Workers read gates from:
```typescript
checkStatsigFeatureGate_CACHED_MAY_BE_STALE('tengu_deploy_...')
```

## Audit Trail

Every decision is logged:
- Timestamp
- Decision (approved/rejected/auto-approved/rolled_back)
- Who made it (user or autonomous)
- Reasoning (from approval request or gate threshold)
- Metrics that triggered decisions

Full transcript can be reconstructed from:
1. `DeploymentContext` (state at each phase)
2. Individual phase outputs (structured JSON)
3. Checkpoint files (recovery points)
4. Coordinator messages (reasoning)

## Integration with Claude Code

### Permission System

Workers get standard tool access from `ASYNC_AGENT_ALLOWED_TOOLS`.
Restrict as needed:
- Deploy worker: Needs bash (deployment commands)
- Verification worker: Needs bash (testing, load test commands)
- Gate check worker: Read-only (git, linting, static analysis)

### Token Budget

Deployment orchestrator respects Claude Code's token budget:
- Allocates tokens for verification in DISPATCH
- Checks remaining tokens before spawning workers
- If insufficient: Compress results, use summaries

### Session Integration

Deployment state persists across sessions:
- Checkpoint files stored in `.claude/deployments/`
- `DeploymentContext` written to disk after each phase
- On resume: Load from disk, continue from checkpoint

## Testing the System

### End-to-End Test

1. **User invokes skill**:
   ```
   /deploy-orchestrator test-service-staging
   ```

2. **GATE CHECK phase**: Review gate check output
   - Should show 4 worker results
   - All should pass (or have specific failures)

3. **DISPATCH phase**: Review deployment spec + approval
   - Should show thresholds (error_rate, latency)
   - Should show canary stages
   - Should ask for approval

4. **Approve**: Continue to STAGING DEPLOY

5. **STAGING DEPLOY phase**: Monitor rollout
   - Should show metrics collected
   - Should show canary stage progression
   - Should checkpoint after each stage

6. **VERIFY phase**: Review verification results
   - Should show test results
   - Should show confidence score
   - Should show go/no-go recommendation

7. **Production decision**: Approve or reject based on verification

### Rollback Test

1. **Modify staging deploy worker** to simulate metric gate failure
2. **Re-run staging deploy**
3. **Verify auto-rollback** is triggered
4. **Confirm** deployment status = 'rolled_back'

### Resume Test

1. **Run full workflow through STAGING DEPLOY**
2. **Interrupt** (close session)
3. **Resume with `--resume-from staging_deploy`**
4. **Verify** that STAGING DEPLOY is skipped, VERIFY proceeds

## Example: Real-World Deployment

### User Command
```
/deploy-orchestrator api-v2-prod --canary-percent 1
```

### Workflow

**PHASE 1: GATE CHECK** (10 minutes)
- Syntax validation: ✅ All pass
- Health check: ✅ Staging healthy
- Change impact: ⚠️  3 API endpoints modified (2 breaking) - MEDIUM risk
- Security: ✅ No vulnerabilities

**PHASE 2: DISPATCH** (5 minutes)
- Coordinator sees MEDIUM risk due to breaking changes
- Decides: Slow rollout (1% → 5% → 20% → 100%)
- Sets error_rate threshold: 2% (higher than usual due to breaking changes)
- Sets latency threshold: 500ms (p99)
- Allocates 20K tokens for verification
- Asks for approval (breaking changes + slow rollout justified)

**User approves** (or asks coordinator to adjust thresholds)

**PHASE 3: STAGING DEPLOY** (45 minutes)
- Stage 1 (1%): Metrics OK, proceed
- Stage 2 (5%): One error spike, but within threshold, proceed
- Stage 3 (20%): Metrics stable, proceed
- Stage 4 (100%): Fully deployed to staging

**PHASE 4: VERIFY** (30 minutes)
- Smoke tests: ✅ Service responds
- Feature tests (breaking changes): ✅ New API format works
- Load test: ✅ Latency good, no regressions
- Integration tests: ✅ Dependent services happy
- Confidence score: 92
- Recommendation: **GO to production**

**User approves production promotion**

**PHASE 5: PRODUCTION PROMOTE** (45 minutes)
- Stage 1 (1%): Metrics OK
- Stage 2 (5%): Metrics OK
- Stage 3 (20%): Metrics OK
- Stage 4 (100%): Fully deployed
- Post-deploy health check: ✅ All systems nominal

**DEPLOYMENT COMPLETE**

Total time: ~2 hours (mostly monitoring)
Confidence: High (independent verification passed)
Rollback ability: Full (can rollback to previous version anytime)

---

## Next Steps

1. **Test syntax**: Ensure TypeScript compiles without errors
2. **Integration test**: Run skill with mock workers
3. **Document feature gates**: Update GrowthBook feature definitions
4. **Add metrics collection**: Integrate with existing metrics system
5. **Implement checkpoint persistence**: File-based or database
6. **Create runbooks**: Emergency procedures, rollback guides
