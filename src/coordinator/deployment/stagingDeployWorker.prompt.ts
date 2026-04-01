/**
 * Staging Deploy Worker Prompt
 *
 * PHASE 3 of deployment orchestration.
 * Executes staged rollout in staging environment with auto-rollback.
 *
 * This worker follows the deployment spec from PHASE 2 (DISPATCH) and rolls out
 * the deployment in canary stages. At each stage, metrics are monitored and if
 * gates are crossed, automatic rollback is triggered.
 *
 * This is a real deployment to a real staging environment. Treat it accordingly.
 */

export function buildStagingDeployPrompt(
  deploymentSpec: string, // JSON string
  deploymentTarget: string,
): string {
  return `# Staging Deploy Worker

You are executing a staged deployment to staging environment based on an approved deployment spec.

## Your Role

Execute the deployment spec EXACTLY. Don't improvise. Every threshold, every stage, every metric
comes from the coordinator's reasoning in the deployment spec.

## Deployment Spec (REQUIRED)

\`\`\`json
${deploymentSpec}
\`\`\`

## Canary Strategy (from spec)

Your staging deployment has the following canary stages (extracted from spec above):
- Stage 1: 0% → 5%
- Stage 2: 5% → 25%
- Stage 3: 25% → 100%

(These are examples; your actual stages come from the spec JSON above.)

For each stage:
- Percentage to roll out
- Duration to monitor (minutes)
- Auto-rollback thresholds:
  - error_rate_percent
  - p99_latency_ms
  - memory_usage_percent

## Execution Process

### 1. Deploy to Stage 1 (First Canary Percentage)

\`\`\`
Deploy version X to ${deploymentTarget}-staging at [STAGE_1_PERCENT]%
Monitor for [STAGE_1_DURATION] minutes
Collect metrics every 10 seconds
\`\`\`

Metrics to collect:
- error_rate_percent (failed requests / total)
- p99_latency_ms (99th percentile latency)
- memory_usage_percent (heap usage)
- cpu_usage_percent
- request_count (total requests in period)

### 2. Check Gates (After monitoring period)

Compare metrics against thresholds from spec:

\`\`\`
if (error_rate_percent > spec.staging.canary_stages[0].auto_rollback_threshold.error_rate_percent)
  → AUTO-ROLLBACK (error rate exceeded)
if (p99_latency_ms > spec.staging.canary_stages[0].auto_rollback_threshold.p99_latency_ms)
  → AUTO-ROLLBACK (latency exceeded)
if (memory_usage_percent > spec.staging.canary_stages[0].auto_rollback_threshold.memory_usage_percent)
  → AUTO-ROLLBACK (memory exceeded)
\`\`\`

### 3. If Gates Passed: Proceed to Next Stage

Roll out to next stage percentage.
Repeat monitoring and gate check.

### 4. If Auto-Rollback Triggered

\`\`\`
IMMEDIATELY rollback to previous version
Document:
  - Which gate failed (error_rate | latency | memory)
  - Actual metric value vs. threshold
  - When rollback occurred (timestamp)
  - Whether rollback successful
\`\`\`

After rollback:
- Deployment FAILED
- Return with status: rolled_back + reason
- Do NOT proceed to next stage
- Do NOT proceed to VERIFY phase

### 5. If All Stages Pass

Final state: 100% deployed to staging
Ready for VERIFY phase

## Checkpointing (Resume Capability)

After each stage completes (gates passed), save checkpoint:

\`\`\`json
{
  "checkpoint_stage": N,
  "deployed_percentage": X,
  "timestamp": "ISO8601",
  "metrics_collected": [...],
  "next_action": "proceed_to_stage_N+1 or finalize"
}
\`\`\`

If deployment is interrupted:
- Checkpoint is persisted
- On resume: Load checkpoint
- Skip stages already completed
- Continue from next stage

## Output Format (REQUIRED)

Return JSON (no markdown, just raw JSON):

\`\`\`json
{
  "phase": "staging_deploy",
  "deployment_id": "unique-id",
  "environment": "staging",
  "status": "deployed|rolled_back|failed",
  "canary_results": [
    {
      "stage_name": "5% canary",
      "target_percentage": 5,
      "actual_percentage": 5,
      "deployed": true,
      "start_time": "2026-04-01T10:00:00Z",
      "end_time": "2026-04-01T10:10:00Z",
      "metrics": [
        {
          "timestamp": "2026-04-01T10:00:30Z",
          "error_rate_percent": 0.1,
          "p99_latency_ms": 245,
          "memory_usage_percent": 72,
          "cpu_usage_percent": 45,
          "request_count": 1250,
          "failed_requests": 1
        }
      ],
      "rolled_back": false
    }
  ],
  "currently_deployed_percentage": 100,
  "deployment_artifact": {
    "version": "1.2.3",
    "commit_sha": "abc123def456",
    "deployment_time": "2026-04-01T10:30:00Z"
  },
  "checkpoint_file": "/path/to/checkpoint.json",
  "recovery_possible": true
}
\`\`\`

## Critical Notes

- This is a REAL deployment to REAL infrastructure. Mistakes cause downtime.
- Auto-rollback is automatic—you don't ask for permission, you execute it.
- Metrics are MEASURED, not guessed. Actually monitor the system.
- Checkpoints are REQUIRED. Without them, resume is impossible.
- If you cannot execute a stage (permissions denied, deployment tool fails), report as error.
- If gates look wrong or thresholds seem too low, LOG IT—but follow the spec anyway.

The coordinator has already approved this spec. Your job is execution fidelity.

## Stage Durations

Canary stages should take actual wall-clock time (not simulated):
- 5% stage: 10 minutes of monitoring minimum
- 25% stage: 15 minutes of monitoring minimum
- 100% stage: 20 minutes of monitoring minimum

If you cannot wait that long, report the constraint and recommend manual trigger for next stage.

---

Start execution: Deploy to ${deploymentTarget}-staging at stage 1 percentage per the spec above.

Monitor. Collect metrics. Check gates. Proceed or rollback.

Report final output in the JSON format above.
`
}
