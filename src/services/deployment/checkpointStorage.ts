import {
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
} from 'fs/promises'
import { dirname, join } from 'path'
import type { DeploymentContext, DeploymentPhase } from '../../types/deployment.js'
import { logEvent } from '../analytics/index.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'

type CheckpointMetadata = {
  deployment_id: string
  deployment_target?: string
  created_at: string
  updated_at: string
  phases_completed: DeploymentPhase[]
  current_phase: DeploymentPhase
  can_resume_from: DeploymentPhase
}

type SaveCheckpointOptions = {
  deploymentTarget?: string
}

function nowIso(): string {
  return new Date().toISOString()
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}

function phaseOutputs(context: DeploymentContext): Array<[DeploymentPhase, unknown]> {
  return [
    ['gate_check', context.gate_check],
    ['dispatch', context.dispatch],
    ['staging_deploy', context.staging_deploy],
    ['verify', context.verify],
    ['production_promote', context.production_promote],
  ]
}

function inferCompletedPhases(context: DeploymentContext): DeploymentPhase[] {
  return unique(
    phaseOutputs(context)
      .filter(([, value]) => value !== undefined)
      .map(([phase]) => phase),
  )
}

function isDeploymentContext(value: unknown): value is DeploymentContext {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'deployment_id' in value &&
      'current_phase' in value &&
      'status' in value,
  )
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

async function atomicWriteFile(
  filePath: string,
  content: string,
  mode: number = 0o600,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })

  let existingMode: number | undefined
  try {
    existingMode = (await stat(filePath)).mode
  } catch {}

  const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`
  const handle = await open(tempPath, 'w', existingMode ?? mode)
  try {
    await handle.writeFile(content, { encoding: 'utf8' })
    await handle.datasync()
  } finally {
    await handle.close()
  }

  try {
    if (existingMode !== undefined) {
      await chmod(tempPath, existingMode)
    }
    await rename(tempPath, filePath)
  } catch (error) {
    try {
      await unlink(tempPath)
    } catch {}
    throw error
  }
}

export class CheckpointStorage {
  constructor(
    private readonly rootDir: string = join(
      getClaudeConfigHomeDir(),
      'deployments',
    ),
  ) {}

  getCheckpointPath(deploymentId: string): string {
    return join(this.rootDir, deploymentId, 'context.json')
  }

  private getDeploymentDir(deploymentId: string): string {
    return join(this.rootDir, deploymentId)
  }

  private getPhaseCheckpointPath(
    deploymentId: string,
    phase: DeploymentPhase,
  ): string {
    return join(this.getDeploymentDir(deploymentId), `${phase}.checkpoint`)
  }

  private getMetadataPath(deploymentId: string): string {
    return join(this.getDeploymentDir(deploymentId), 'metadata.json')
  }

  async saveCheckpoint(
    deploymentId: string,
    phase: DeploymentPhase,
    context: DeploymentContext,
    options?: SaveCheckpointOptions,
  ): Promise<string> {
    const deploymentDir = this.getDeploymentDir(deploymentId)
    await mkdir(deploymentDir, { recursive: true, mode: 0o700 })

    const existingMetadata = await this.readMetadata(deploymentId)
    const timestamp = nowIso()
    const metadata: CheckpointMetadata = {
      deployment_id: deploymentId,
      deployment_target:
        options?.deploymentTarget ?? existingMetadata?.deployment_target,
      created_at: existingMetadata?.created_at ?? timestamp,
      updated_at: timestamp,
      phases_completed: inferCompletedPhases(context),
      current_phase: context.current_phase,
      can_resume_from: context.can_resume_from,
    }

    const contextPath = this.getCheckpointPath(deploymentId)
    const phasePath = this.getPhaseCheckpointPath(deploymentId, phase)
    const metadataPath = this.getMetadataPath(deploymentId)

    await Promise.all([
      atomicWriteFile(contextPath, stringifyJson(context)),
      atomicWriteFile(phasePath, stringifyJson(context)),
      atomicWriteFile(metadataPath, stringifyJson(metadata)),
    ])

    logEvent('tengu_deploy_checkpoint_saved', {
      phase_saved: 1,
      approvals_pending: context.approvals_pending.length,
    })

    return contextPath
  }

  async loadCheckpoint(deploymentId: string): Promise<DeploymentContext | null> {
    const path = this.getCheckpointPath(deploymentId)
    try {
      const raw = await readFile(path, 'utf8')
      const parsed = safeParseJson(raw)
      if (!isDeploymentContext(parsed)) {
        logEvent('tengu_deploy_checkpoint_corrupt', {
          corrupt: 1,
        })
        return null
      }
      return parsed
    } catch {
      return null
    }
  }

  async loadLatestCheckpointForTarget(
    deploymentTarget: string,
  ): Promise<DeploymentContext | null> {
    const ids = await this.listCheckpoints()
    let latestId: string | null = null
    let latestUpdatedAt = 0

    for (const id of ids) {
      const metadata = await this.readMetadata(id)
      if (!metadata || metadata.deployment_target !== deploymentTarget) {
        continue
      }
      const updatedAt = Date.parse(metadata.updated_at)
      if (Number.isFinite(updatedAt) && updatedAt >= latestUpdatedAt) {
        latestUpdatedAt = updatedAt
        latestId = id
      }
    }

    return latestId ? this.loadCheckpoint(latestId) : null
  }

  async listCheckpoints(): Promise<string[]> {
    try {
      const entries = await readdir(this.rootDir, { withFileTypes: true })
      return entries
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
        .sort()
    } catch {
      return []
    }
  }

  async deleteCheckpoint(deploymentId: string): Promise<void> {
    await rm(this.getDeploymentDir(deploymentId), {
      recursive: true,
      force: true,
    })
  }

  private async readMetadata(
    deploymentId: string,
  ): Promise<CheckpointMetadata | null> {
    try {
      const raw = await readFile(this.getMetadataPath(deploymentId), 'utf8')
      const parsed = safeParseJson(raw)
      if (
        parsed &&
        typeof parsed === 'object' &&
        'deployment_id' in parsed &&
        'updated_at' in parsed
      ) {
        return parsed as CheckpointMetadata
      }
      return null
    } catch {
      return null
    }
  }
}
