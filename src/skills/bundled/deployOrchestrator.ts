/**
 * Deploy Orchestrator Skill
 *
 * 5-phase deployment workflow with structured approvals and intelligent rollback.
 * Translates Claude Code's coordinator patterns to production deployments.
 *
 * Phases:
 * 1. GATE CHECK - Pre-deployment validation (parallel workers)
 * 2. DISPATCH - Coordinator synthesizes a deployment spec
 * 3. STAGING DEPLOY - Staged rollout with metrics-driven auto-rollback
 * 4. VERIFY - Independent verification with skeptical testing
 * 5. PRODUCTION PROMOTE - Final production rollout with approval
 *
 * Features:
 * - Checkpoint/resume capability after each phase
 * - Token budget allocation for verification
 * - Feature gates for canary control
 * - Structured approval requests
 * - Comprehensive audit trail
 */

import { registerBundledSkill } from '../bundledSkills.js'

const USAGE_MESSAGE = `Usage: /deploy-orchestrator <target> [--skip-approvals] [--canary-percent N]

Orchestrate a production deployment with multi-phase safety gates.

Arguments:
  <target>              Deployment target (e.g., 'claude-code-prod', 'api-v2')
  --skip-approvals      Emergency mode: auto-approve all gates (logged)
  --canary-percent N    Override starting canary percentage (default: 2%)
  --resume-from PHASE   Resume from checkpoint (gate_check|dispatch|staging_deploy|verify)

Examples:
  /deploy-orchestrator claude-code-prod
  /deploy-orchestrator api-v2 --canary-percent 5
  /deploy-orchestrator api-v2 --resume-from staging_deploy (resume after interruption)
  /deploy-orchestrator api-v2 --skip-approvals (emergency, all auto-approved)`

function buildDeploymentPrompt(args: string): string {
  return `# /deploy-orchestrator — Multi-phase Deployment Orchestration

You are coordinating a production deployment using Claude Code's proven 4-phase orchestration pattern.
This is NOT vibe coding. Every phase has structured inputs, outputs, and approval gates.

## Your Role

You are the **Coordinator**: You don't execute each phase directly—you orchestrate it by:
1. Understanding what each phase produces
2. Synthesizing results into structured decisions
3. Requesting approvals at critical junctures
4. Managing recovery and rollback

## The 5-Phase Deployment Cycle

### PHASE 1: GATE CHECK (Research & Validation)
**Input**: Deployment target and change summary
**Workers** (you spawn these in parallel as agents):
- Syntax validation worker: Check code compiles, no syntax errors
- Health check worker: Pre-deployment system health (test environment)
- Change impact worker: Analyze diff for blast radius risk
- Security/compliance worker: Scan for security issues, policy violations

**Output Format**: Structured GateCheckOutput with:
- ready_for_dispatch: boolean
- risk_level: 'critical' | 'high' | 'medium' | 'low'
- blockers: string[] (show-stoppers)
- worker_results: individual validation results
- estimated_duration_minutes: based on scope

**Success Criteria**:
- All workers complete
- No blockers unless explicitly overridden
- Risk level assessed

---

### PHASE 2: DISPATCH (Synthesis & Planning)
**Input**: GateCheckOutput from phase 1
**Your Role**: Coordinator synthesizes findings into deployment spec

This is where reasoning adds value. Look at gate check results and decide:
- How many canary stages? (e.g., 2% → 5% → 25% → 100%)
- What are rollback thresholds? (error_rate > X%, latency > Y ms)
- How long to monitor each stage?
- What approvals are required?

**Output Format**: Structured DispatchOutput with:
- DeploymentSpec (the "implementation spec" for the deployment)
  - Canary stages with error/latency thresholds
  - Rollback triggers and conditions
  - Verification token budget allocation
  - Decision notes explaining the strategy

**Approval Request Format**:
Show a structured message with:
- Title: "Production Deployment Spec Ready for Review"
- Reasoning: Why this rollout strategy (based on risk level)
- Changes summary: What's being deployed
- Risk assessment: What could go wrong, mitigation

**Success Criteria**:
- Spec is specific and concrete (not "roll out gradually")
- Thresholds are measurable (error_rate_percent: 2, latency_ms: 500)
- Approval request is clear and actionable

---

### PHASE 3: STAGING DEPLOY (Implementation with Rollback)
**Input**: DeploymentSpec from phase 2 + approval
**Workers**: Deploy workers execute the spec

Process:
1. Deploy to staging at 0% (new code available, no traffic)
2. Increment to 5% (monitor for metrics)
   - If error_rate > threshold OR latency > threshold: AUTO-ROLLBACK
   - Otherwise: proceed
3. Increment to 25% (monitor)
   - Same gates apply
4. Increment to 100% (full staging)

After each increment, log metrics and persist checkpoint (for resume capability).

**Output Format**: Structured StagingDeployOutput with:
- canary_results: results from each stage
- currently_deployed_percentage: where we are
- checkpoint_file: path to recovery state
- recovery_possible: can resume from here

**Success Criteria**:
- All metrics gates passed
- No auto-rollbacks triggered
- Checkpoint persisted
- Staging fully deployed and healthy

---

### PHASE 4: VERIFY (Independent Quality Gates)
**Input**: StagingDeployOutput (deployment in staging)
**Workers**: Independent verification worker (NOT the deployment worker)

This worker is skeptical. It runs:
- Smoke tests with new code ENABLED (not disabled)
- Feature tests for new functionality
- Load tests on new endpoints
- Integration tests with dependent services
- Security scanning
- Performance regression checks

Key insight: Verification is separate from implementation. This worker can't be pressured
to skip checks because they deployed the thing.

**Output Format**: Structured VerificationReport with:
- test_results: array of individual test results
- all_tests_passed: boolean
- performance_delta: regression analysis
- confidence_score: 0-100
- go_no_go_recommendation: 'go' | 'no_go' | 'conditional'
- verified_by_independent_worker: true

**Success Criteria**:
- All critical tests pass
- No regressions detected
- confidence_score >= 80
- Recommendation is 'go' or 'conditional' (not 'no_go')

---

### PHASE 5: PRODUCTION PROMOTE (Finalized Rollout)
**Input**: VerificationReport + approval
**Workers**: Production deploy workers

This is the same canary strategy as staging, but in production:
1. Deploy to 2% (monitor)
2. Auto-rollback if gates fail
3. Increment to 10%, 50%, 100%

Post-deploy health check confirms everything is working.

**Output Format**: Structured ProductionDeployOutput with:
- canary_results: production stage results
- fully_deployed: true/false
- health_check_passed: true/false
- deploy_id: unique ID for audit trail

**Success Criteria**:
- All stages passed metrics gates
- Health check successful
- No manual rollbacks required

---

## State Management & Recovery

After each phase completes, we persist:
- Full phase output (typed)
- Checkpoint file location
- Current status

If deployment is interrupted:
1. Resume loads checkpoint
2. Re-enters at last completed phase
3. Coordinator reconciles state
4. Continues from there (no re-running)

## Token Budget for Verification

The verification phase (phase 4) has a dedicated token budget from DISPATCH:
- Budget allocated: DeploymentSpec.verification_token_budget (e.g., 15,000 tokens)
- If exceeded: Truncate tests, summarize results, flag as "verification incomplete"
- Never proceed to production without completing verification

## Feature Gates (GrowthBook)

These control deployment behavior:
- tengu_deploy_orchestrator: Master enable/disable
- tengu_deploy_auto_rollback: Auto-rollback when gates fail (default: true)
- tengu_deploy_canary_percent: Starting canary % (default: 2)
- tengu_deploy_emergency_skip_verify: Allow --skip-approvals (default: false)

## Your Actual Task

Parse the user input below and execute the deployment orchestration:

\`\`\`
${args}
\`\`\`

## Parsing the Input

Extract:
1. **target**: First argument (deployment target name)
2. **--skip-approvals**: Emergency mode flag (auto-approve all gates)
3. **--canary-percent N**: Override canary starting percentage
4. **--resume-from PHASE**: Resume from checkpoint at specific phase

Validation:
- If target is empty, show USAGE_MESSAGE and stop
- If --skip-approvals used but tengu_deploy_emergency_skip_verify is false, warn user
- If --resume-from used, load checkpoint and validate it exists

## Execution

Based on resume state:
1. If no resume: Start PHASE 1 (GATE CHECK)
2. If resume-from: Load checkpoint, confirm resumable, continue from next phase

For each phase:
1. If waiting for approval: Show structured approval request
2. If not approved: Stop and ask for approval
3. If approved: Proceed to next phase
4. Log decision with timestamp

## Important Notes

- Each phase is autonomous (separate worker/agent)
- Coordinator doesn't do the work, coordinates it
- Approval requests are structured (like ExitPlanMode)
- Checkpoint persistence is non-negotiable (for resume)
- Audit trail includes every decision + reasoning
- Rollback is automatic for objective metrics, approval-required for subjective

This is production deployment orchestration, not a script. Treat it with the rigor
you'd expect from a system managing traffic to millions of users.
`
}

export function registerDeployOrchestratorSkill(): void {
  registerBundledSkill({
    name: 'deploy-orchestrator',
    description:
      'Orchestrate multi-phase production deployments with approval gates, staged rollout, and independent verification',
    whenToUse:
      'When deploying to production (or staging as rehearsal) and you want structured safety gates, auto-rollback on metrics, independent verification, and full audit trail. Use for any critical deployment that could impact users.',
    argumentHint: '<target> [--skip-approvals] [--canary-percent N] [--resume-from PHASE]',
    userInvocable: true,
    isEnabled: () => {
      // Check if tengu_deploy_orchestrator feature gate is enabled
      // For now, always enabled in internal mode
      return true
    },
    async getPromptForCommand(args) {
      const trimmed = args.trim()
      if (!trimmed) {
        return [{ type: 'text', text: USAGE_MESSAGE }]
      }
      return [{ type: 'text', text: buildDeploymentPrompt(trimmed) }]
    },
  })
}
