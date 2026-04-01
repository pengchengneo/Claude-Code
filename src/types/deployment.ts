/**
 * Deployment Orchestration Types
 *
 * Defines the data structures for the 5-phase deployment workflow:
 * GATE CHECK → DISPATCH → STAGING DEPLOY → VERIFY → PRODUCTION PROMOTE
 *
 * Patterns borrowed from Claude Code:
 * - State machine transitions (from Task.ts)
 * - Coordinator mode phases (from coordinatorMode.ts)
 * - Token budget management (from withRetry.ts)
 * - Feature gates (from growthbook.ts)
 */

// ============================================================================
// Phase Status and Lifecycle
// ============================================================================

export type DeploymentPhase =
  | 'gate_check'
  | 'dispatch'
  | 'staging_deploy'
  | 'verify'
  | 'production_promote'
  | 'completed'
  | 'failed'
  | 'rolled_back'

export type DeploymentStatus =
  | 'pending'
  | 'running'
  | 'paused_for_approval'
  | 'completed'
  | 'failed'
  | 'rolled_back'
  | 'cancelled'

export type RiskLevel = 'critical' | 'high' | 'medium' | 'low'

// ============================================================================
// Phase 1: GATE CHECK (Research & Validation)
// ============================================================================

export type GateCheckWorkerResult = {
  worker_type: 'syntax_validation' | 'health_check' | 'change_impact' | 'security_compliance'
  passed: boolean
  errors: string[]
  warnings: string[]
  duration_ms: number
}

export type GateCheckOutput = {
  phase: 'gate_check'
  timestamp: string
  ready_for_dispatch: boolean
  risk_level: RiskLevel
  blockers: string[]
  worker_results: GateCheckWorkerResult[]
  change_summary: {
    files_changed: number
    lines_added: number
    lines_removed: number
  }
  estimated_duration_minutes: number
  required_approvals: string[]
}

// ============================================================================
// Phase 2: DISPATCH (Synthesis & Planning)
// ============================================================================

export type CanaryStage = {
  name: string
  percentage: number
  duration_minutes: number
  auto_rollback_threshold: {
    error_rate_percent: number
    p99_latency_ms: number
    memory_usage_percent: number
  }
}

export type RollbackTrigger = {
  condition: 'error_rate_exceeded' | 'latency_exceeded' | 'manual_request'
  threshold: number
  action: 'auto_rollback' | 'approval_required'
}

export type DeploymentSpec = {
  phase: 'dispatch'
  timestamp: string
  deployment_id: string

  // Coordinator synthesis of gate check findings
  risk_assessment: {
    overall_risk: RiskLevel
    rationale: string
    mitigation_strategy: string
  }

  // Staged rollout strategy
  staging: {
    canary_stages: CanaryStage[]
    validation_gates: string[]
  }

  production: {
    canary_stages: CanaryStage[]
    validation_gates: string[]
    rollback_triggers: RollbackTrigger[]
  }

  // Resource allocation
  verification_token_budget: number
  timeout_minutes: number

  // Approval requirements
  approval_requirements: {
    gate_check_approval_required: boolean
    production_approval_required: boolean
    stakeholders: string[]
  }

  // Timeline
  estimated_total_duration_minutes: number
  created_by_coordinator: true

  // Reasoning (for auditability)
  decision_notes: string
}

export type DispatchOutput = {
  phase: 'dispatch'
  timestamp: string
  deployment_spec: DeploymentSpec
  approval_request: {
    title: string
    reasoning: string
    changes_summary: string
    risk_assessment: string
  }
  coordinator_ready: true
}

// ============================================================================
// Phase 3: STAGING DEPLOY (Implementation with Rollback)
// ============================================================================

export type DeploymentMetrics = {
  timestamp: string
  error_rate_percent: number
  p99_latency_ms: number
  memory_usage_percent: number
  cpu_usage_percent: number
  request_count: number
  failed_requests: number
}

export type CanaryStageResult = {
  stage_name: string
  target_percentage: number
  actual_percentage: number
  deployed: boolean
  start_time: string
  end_time: string
  metrics: DeploymentMetrics[]
  rolled_back: boolean
  rollback_reason?: string
}

export type StagingDeployOutput = {
  phase: 'staging_deploy'
  timestamp: string
  deployment_id: string
  environment: 'staging'
  status: 'deployed' | 'rolled_back' | 'failed'

  // Results from each canary stage
  canary_results: CanaryStageResult[]

  // Final state
  currently_deployed_percentage: number
  deployment_artifact: {
    version: string
    commit_sha: string
    deployment_time: string
  }

  // Persistence info (for resume capability)
  checkpoint_file: string
  recovery_possible: boolean
}

// ============================================================================
// Phase 4: VERIFY (Independent Quality Gates)
// ============================================================================

export type VerificationTestResult = {
  test_category: 'smoke' | 'feature' | 'load' | 'integration' | 'security' | 'performance'
  name: string
  passed: boolean
  error_message?: string
  duration_ms: number
}

export type VerificationReport = {
  phase: 'verify'
  timestamp: string
  deployment_id: string

  // Test results
  test_results: VerificationTestResult[]
  all_tests_passed: boolean

  // Performance analysis
  performance_delta: {
    p99_latency_delta_ms: number
    error_rate_delta_percent: number
    throughput_delta_percent: number
    regression_detected: boolean
  }

  // Final assessment
  confidence_score: number // 0-100
  go_no_go_recommendation: 'go' | 'no_go' | 'conditional'
  conditional_reason?: string

  // Auditable
  verified_by_independent_worker: true
  verification_duration_minutes: number
}

// ============================================================================
// Phase 5: PRODUCTION PROMOTE (Finalized Rollout)
// ============================================================================

export type ProductionDeployOutput = {
  phase: 'production_promote'
  timestamp: string
  deployment_id: string
  environment: 'production'
  status: 'deployed' | 'rolled_back' | 'failed'

  // Promotion decision (based on verify phase)
  promotion_approved: boolean
  approval_timestamp?: string
  approval_notes?: string

  // Results from each canary stage
  canary_results: CanaryStageResult[]

  // Final state
  fully_deployed: boolean
  rollout_complete_time?: string

  // Post-deploy health check
  health_check_passed: boolean
  health_check_metrics: DeploymentMetrics

  // Audit trail
  deploy_id: string
  duration_minutes: number
}

// ============================================================================
// Complete Deployment Context (Coordinator State)
// ============================================================================

export type DeploymentContext = {
  deployment_id: string
  initiated_at: string
  current_phase: DeploymentPhase
  status: DeploymentStatus

  // Phase outputs (accumulated as we progress)
  gate_check?: GateCheckOutput
  dispatch?: DispatchOutput
  staging_deploy?: StagingDeployOutput
  verify?: VerificationReport
  production_promote?: ProductionDeployOutput

  // Approval tracking
  approvals_granted: Record<string, { timestamp: string; notes?: string }>
  approvals_pending: string[]

  // Recovery state
  last_checkpoint: string
  can_resume_from: DeploymentPhase

  // Metrics
  total_duration_minutes: number
  tokens_used_for_verification: number
  tokens_remaining: number
}

// ============================================================================
// Feature Gate Configuration (for GrowthBook integration)
// ============================================================================

export type DeploymentFeatureGates = {
  enabled: boolean // tengu_deploy_orchestrator
  auto_rollback: boolean // tengu_deploy_auto_rollback
  canary_percent_start: number // tengu_deploy_canary_percent
  emergency_skip_verify: boolean // tengu_deploy_emergency_skip_verify
}

// ============================================================================
// Error and Rollback State
// ============================================================================

export type RollbackPlan = {
  deployment_id: string
  initiated_at: string
  reason: string
  from_phase: DeploymentPhase

  // What to rollback
  previous_version: string
  previous_commit: string

  // Status
  completed: boolean
  completed_at?: string

  // Health after rollback
  health_check_passed: boolean
  final_metrics: DeploymentMetrics
}

export type DeploymentError = {
  phase: DeploymentPhase
  error_code: string
  message: string
  recovery_suggested?: string
  is_recoverable: boolean
}
