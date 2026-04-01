/**
 * Gate Check Worker Prompt
 *
 * PHASE 1 of deployment orchestration.
 * Validates pre-deployment readiness across multiple dimensions in parallel.
 *
 * This worker is one of 4 that run in parallel:
 * - Syntax/type validation
 * - Pre-deployment health check
 * - Change impact assessment
 * - Security/compliance check
 *
 * Each validates independently and produces a structured result.
 */

export function buildGateCheckPrompt(workerType: string, deploymentTarget: string): string {
  const basePrompt = `# Gate Check Worker: ${workerType.toUpperCase()}

You are one of 4 parallel validation workers for deployment orchestration.
Your job: Validate a specific aspect of deployment readiness.

## Context

Deployment Target: ${deploymentTarget}
Your Role: ${workerType}

## Instructions Based on Your Role

${getWorkerInstructions(workerType)}

## Output Format (REQUIRED)

Return a JSON object (no markdown, just raw JSON):

\`\`\`json
{
  "worker_type": "${workerType}",
  "passed": boolean,
  "errors": ["error message 1", "error message 2"],
  "warnings": ["warning 1"],
  "duration_ms": number,
  "specific_findings": {
    // Worker-specific details (see below)
  }
}
\`\`\`

Each worker type includes specific findings below.

---

## Worker: syntax_validation

**Purpose**: Verify code compiles, no syntax errors, types check out.

**Process**:
1. Run syntax check on deployment code (e.g., \`tsc --noEmit\` for TypeScript)
2. Run linter if configured
3. Report any type errors
4. Check for deprecated API usage
5. Verify no obvious logical errors in critical paths

**Success Criteria**:
- Zero syntax errors
- Zero linting errors (or all suppressible)
- Zero type errors
- No deprecated APIs in critical paths

**Failures Are Blockers**: If syntax validation fails, the deployment CANNOT proceed.

**Output**: Add to specific_findings:
\`\`\`json
{
  "specific_findings": {
    "syntax_errors_count": number,
    "type_errors_count": number,
    "linting_errors_count": number,
    "deprecated_apis": ["api1", "api2"],
    "checked_critical_paths": ["path1", "path2"],
    "duration_ms": number
  }
}
\`\`\`

---

## Worker: health_check

**Purpose**: Verify pre-deployment system health (staging environment, test infrastructure).

**Process**:
1. Check test environment connectivity
2. Run smoke tests in staging
3. Check database connectivity
4. Verify dependent services are healthy
5. Check resource availability (disk, memory, connections)
6. Verify deployment credentials/permissions

**Success Criteria**:
- All smoke tests pass
- All dependencies healthy
- Sufficient resources available
- Deployment permissions verified

**Failures Are Blockers**: If health checks fail, deployment cannot proceed.

**Output**: Add to specific_findings:
\`\`\`json
{
  "specific_findings": {
    "smoke_tests_passed": boolean,
    "dependencies_healthy": ["service1", "service2"],
    "dependencies_unhealthy": ["service3"],
    "resource_availability": {
      "disk_gb_available": number,
      "memory_gb_available": number,
      "available_connections": number
    },
    "permissions_verified": boolean,
    "test_environment_healthy": boolean,
    "duration_ms": number
  }
}
\`\`\`

---

## Worker: change_impact

**Purpose**: Assess risk of deployment based on what's changing.

**Process**:
1. Analyze git diff vs. main branch
2. Count lines added/removed/modified
3. Identify files being changed
4. Determine blast radius (what could break)
5. Check for breaking API changes
6. Assess data migration impact
7. Evaluate backward compatibility

**Success Criteria**:
- Blast radius is understood
- No unexpected breaking changes
- Data migration strategy documented (if needed)
- Backward compatibility maintained (if applicable)

**Failures Are Warnings (not blockers)**: Can proceed with approval.

**Output**: Add to specific_findings:
\`\`\`json
{
  "specific_findings": {
    "files_changed": number,
    "lines_added": number,
    "lines_removed": number,
    "modified_files": ["file1", "file2"],
    "blast_radius": "low|medium|high",
    "breaking_changes": ["change1"],
    "has_data_migration": boolean,
    "backward_compatible": boolean,
    "risky_areas": ["area1", "area2"],
    "estimated_rollback_difficulty": "easy|medium|hard",
    "duration_ms": number
  }
}
\`\`\`

---

## Worker: security_compliance

**Purpose**: Scan for security issues and policy violations.

**Process**:
1. Run security scanner (e.g., SAST tool)
2. Check for secrets/credentials in code
3. Verify authentication changes
4. Assess authorization changes
5. Check compliance policy adherence
6. Review data handling changes
7. Verify audit logging
8. Check for known vulnerabilities in dependencies

**Success Criteria**:
- No critical/high severity vulnerabilities
- No exposed secrets
- Authentication/authorization changes reviewed
- Compliance requirements met

**Failures May Block or Warn**: Critical issues block, high issues warn.

**Output**: Add to specific_findings:
\`\`\`json
{
  "specific_findings": {
    "vulnerabilities": [
      {
        "severity": "critical|high|medium|low",
        "description": "description",
        "remediation": "how to fix"
      }
    ],
    "exposed_secrets": ["secret_type_1"],
    "authentication_changes": ["change1"],
    "authorization_changes": ["change1"],
    "compliance_violations": ["violation1"],
    "dependency_vulnerabilities": number,
    "has_audit_logging": boolean,
    "duration_ms": number
  }
}
\`\`\`

---

## Important Notes

- This is NOT a simulation or proof-of-concept. Run actual checks.
- If a check cannot be run (missing tools, permissions), report that as a failure.
- Duration in milliseconds (not a guess—measure actual execution time if possible).
- Errors and warnings are strings that will be shown to humans making approval decisions.
- Be specific in findings: not "failed" but "linter reported 5 errors in src/main.ts".

This worker's output feeds into the Coordinator's DISPATCH phase decision.
Quality and specificity of this output directly impacts deployment safety.
`

  return basePrompt
}

function getWorkerInstructions(workerType: string): string {
  const instructions: Record<string, string> = {
    syntax_validation: `
You are performing syntax validation.

**Your specific task**:
1. Check if the deployment code compiles (no syntax errors)
2. Run type checking
3. Run linting
4. Identify deprecated API usage
5. Check critical execution paths for obvious errors

Run the actual tools:
- \`tsc --noEmit\` (TypeScript) or equivalent for your language
- \`eslint\` / \`rubocop\` / \`golangci-lint\` etc.
- Dependency vulnerability scan
- Check for usage of removed/deprecated APIs

Report specific counts and affected files.
If you cannot run these tools, report that as an error (not just "tool not available").
    `,

    health_check: `
You are performing pre-deployment health checks.

**Your specific task**:
1. Verify connectivity to test/staging environment
2. Run smoke tests (basic happy-path tests)
3. Check dependent service health (database, cache, APIs, etc.)
4. Verify system resources available (disk, memory, connections)
5. Verify deployment credentials work
6. Confirm permissions are sufficient

For each check:
- Actually attempt the connection/test
- Measure response time
- Report the specific failure if it fails
- Note if permissions prevent checking something

Don't assume things are working. Test them.
    `,

    change_impact: `
You are assessing the impact of deployment changes.

**Your specific task**:
1. Get git diff between current code and main branch
2. Count lines changed
3. Identify all modified files
4. For each modified file, assess impact (low/medium/high)
5. Check for breaking API changes
6. Assess database schema changes
7. Check for data migration needs
8. Verify backward compatibility

From the diff, determine:
- What could break?
- How many users/services affected?
- Can this be rolled back safely?
- What's the rollback procedure?

Be specific: "3 API endpoints modified (2 breaking)" not "endpoints changed".
    `,

    security_compliance: `
You are performing security and compliance scanning.

**Your specific task**:
1. Run SAST tool (static analysis security tool) if available
2. Scan for hardcoded secrets/credentials
3. Review authentication logic changes
4. Review authorization logic changes
5. Check for compliance requirement violations
6. Review data handling changes
7. Verify audit logging is in place
8. Check dependency versions for known CVEs

Report:
- Critical/high/medium/low vulnerabilities with severity and how to fix
- Any secrets found (they must be remediated before deployment)
- Changes to auth/authz that need review
- Compliance violations
- Known vulnerabilities in dependencies

If security scanning fails or finds blockers, deployment cannot proceed without remediation.
    `,
  }

  return instructions[workerType] || ''
}
