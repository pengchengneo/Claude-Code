/**
 * Named Pipe Transport - Unix domain socket IPC for CLI terminals
 *
 * Supports two modes:
 * 1. Standalone: Two independent terminals chat via pipes
 * 2. Master-Slave bridge: Master CLI attaches to Slave CLI, forwarding
 *    prompts and receiving streamed AI output back.
 *
 * Each CLI auto-creates a PipeServer at:
 *   ~/.claude/pipes/{session-short-id}.sock
 *
 * Protocol: newline-delimited JSON (NDJSON), one message per line.
 */

import { createServer, createConnection, type Server, type Socket } from 'net'
import { mkdir, unlink, readdir } from 'fs/promises'
import { join } from 'path'
import { EventEmitter } from 'events'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { logError } from './log.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Message types exchanged over the pipe.
 *
 * Basic:        ping, pong
 * Control:      attach_request, attach_accept, attach_reject, detach
 * Data (M→S):   prompt           — master sends user input to slave
 * Data (S→M):   stream           — slave streams AI output fragments
 *               tool_start       — slave notifies tool execution start
 *               tool_result      — slave notifies tool result
 *               done             — slave signals turn complete
 *               error            — either side reports an error
 * Legacy:       chat, cmd, result, exit  — kept for pipe-demo.ts compat
 */
export type PipeMessageType =
  // Basic
  | 'ping'
  | 'pong'
  // Control flow (master-slave bridge)
  | 'attach_request'
  | 'attach_accept'
  | 'attach_reject'
  | 'detach'
  // Data flow (master → slave)
  | 'prompt'
  // Data flow (slave → master)
  | 'stream'
  | 'tool_start'
  | 'tool_result'
  | 'done'
  | 'error'
  // Legacy (standalone chat demo)
  | 'chat'
  | 'cmd'
  | 'result'
  | 'exit'

export type PipeMessage = {
  /** Discriminator */
  type: PipeMessageType
  /** Payload (text, command output, prompt, stream fragment, etc.) */
  data?: string
  /** Sender pipe name */
  from?: string
  /** ISO timestamp */
  ts?: string
  /** Additional metadata (tool name, error details, etc.) */
  meta?: Record<string, unknown>
}

export type PipeMessageHandler = (msg: PipeMessage, reply: (msg: PipeMessage) => void) => void

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function getPipesDir(): string {
  return join(getClaudeConfigHomeDir(), 'pipes')
}

export function getPipePath(name: string): string {
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_')
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\claude-code-${safeName}`
  }
  return join(getPipesDir(), `${safeName}.sock`)
}

async function ensurePipesDir(): Promise<void> {
  await mkdir(getPipesDir(), { recursive: true })
}

// ---------------------------------------------------------------------------
// Server (listener side)
// ---------------------------------------------------------------------------

export class PipeServer extends EventEmitter {
  private server: Server | null = null
  private clients: Set<Socket> = new Set()
  private handlers: PipeMessageHandler[] = []
  readonly name: string
  readonly socketPath: string

  constructor(name: string) {
    super()
    this.name = name
    this.socketPath = getPipePath(name)
  }

  /**
   * Start listening for incoming connections.
   */
  async start(): Promise<void> {
    await ensurePipesDir()

    // Clean up stale socket file (Unix only)
    if (process.platform !== 'win32') {
      try {
        await unlink(this.socketPath)
      } catch {
        // File doesn't exist — fine
      }
    }

    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => {
        this.clients.add(socket)
        this.emit('connection', socket)

        let buffer = ''

        socket.on('data', (chunk) => {
          buffer += chunk.toString()
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''

          for (const line of lines) {
            if (!line.trim()) continue
            try {
              const msg = JSON.parse(line) as PipeMessage
              this.emit('message', msg)
              const reply = (replyMsg: PipeMessage) => {
                replyMsg.from = replyMsg.from ?? this.name
                replyMsg.ts = replyMsg.ts ?? new Date().toISOString()
                if (!socket.destroyed) {
                  socket.write(JSON.stringify(replyMsg) + '\n')
                }
              }
              for (const handler of this.handlers) {
                handler(msg, reply)
              }
            } catch {
              // Malformed JSON — skip
            }
          }
        })

        socket.on('close', () => {
          this.clients.delete(socket)
          this.emit('disconnect', socket)
        })

        socket.on('error', (err) => {
          this.clients.delete(socket)
          logError(err)
        })
      })

      this.server.on('error', reject)

      this.server.listen(this.socketPath, () => {
        resolve()
      })
    })
  }

  /**
   * Register a handler for incoming messages.
   */
  onMessage(handler: PipeMessageHandler): void {
    this.handlers.push(handler)
  }

  /**
   * Broadcast a message to all connected clients.
   */
  broadcast(msg: PipeMessage): void {
    msg.from = msg.from ?? this.name
    msg.ts = msg.ts ?? new Date().toISOString()
    const line = JSON.stringify(msg) + '\n'
    for (const client of this.clients) {
      if (!client.destroyed) {
        client.write(line)
      }
    }
  }

  /**
   * Send to a specific socket (used for directed replies in attach flow).
   */
  sendTo(socket: Socket, msg: PipeMessage): void {
    msg.from = msg.from ?? this.name
    msg.ts = msg.ts ?? new Date().toISOString()
    if (!socket.destroyed) {
      socket.write(JSON.stringify(msg) + '\n')
    }
  }

  get connectionCount(): number {
    return this.clients.size
  }

  async close(): Promise<void> {
    for (const client of this.clients) {
      client.destroy()
    }
    this.clients.clear()

    return new Promise((resolve) => {
      if (!this.server) {
        resolve()
        return
      }
      this.server.close(() => {
        this.server = null
        if (process.platform !== 'win32') {
          void unlink(this.socketPath).catch(() => {})
        }
        resolve()
      })
    })
  }
}

// ---------------------------------------------------------------------------
// Client (connector side)
// ---------------------------------------------------------------------------

export class PipeClient extends EventEmitter {
  private socket: Socket | null = null
  private handlers: PipeMessageHandler[] = []
  readonly targetName: string
  readonly senderName: string
  readonly socketPath: string

  constructor(targetName: string, senderName?: string) {
    super()
    this.targetName = targetName
    this.senderName = senderName ?? `client-${process.pid}`
    this.socketPath = getPipePath(targetName)
  }

  /**
   * Connect to a remote pipe server.
   * Retries automatically if the socket file doesn't exist yet (ENOENT).
   */
  async connect(timeoutMs: number = 5000): Promise<void> {
    const { access } = await import('fs/promises')
    const deadline = Date.now() + timeoutMs
    const retryDelayMs = 300

    // Wait for socket file to exist (Unix only)
    if (process.platform !== 'win32') {
      while (Date.now() < deadline) {
        try {
          await access(this.socketPath)
          break
        } catch {
          if (Date.now() + retryDelayMs >= deadline) {
            throw new Error(
              `Pipe "${this.targetName}" not found at ${this.socketPath}. Is the server running?`,
            )
          }
          await new Promise((r) => setTimeout(r, retryDelayMs))
        }
      }
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Connection to pipe "${this.targetName}" timed out after ${timeoutMs}ms`))
      }, Math.max(deadline - Date.now(), 1000))

      const socket = createConnection({ path: this.socketPath }, () => {
        clearTimeout(timer)
        this.socket = socket
        this.setupSocketListeners(socket)
        this.emit('connected')
        resolve()
      })

      socket.on('error', (err) => {
        clearTimeout(timer)
        socket.destroy()
        reject(err)
      })
    })
  }

  private setupSocketListeners(socket: Socket): void {
    let buffer = ''

    socket.on('data', (chunk) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line) as PipeMessage
          this.emit('message', msg)
          const reply = (replyMsg: PipeMessage) => this.send(replyMsg)
          for (const handler of this.handlers) {
            handler(msg, reply)
          }
        } catch {
          // Malformed JSON — skip
        }
      }
    })

    socket.on('close', () => {
      this.emit('disconnect')
    })

    socket.on('error', (err) => {
      logError(err)
    })
  }

  onMessage(handler: PipeMessageHandler): void {
    this.handlers.push(handler)
  }

  send(msg: PipeMessage): void {
    if (!this.socket || this.socket.destroyed) {
      throw new Error(`Not connected to pipe "${this.targetName}"`)
    }
    msg.from = msg.from ?? this.senderName
    msg.ts = msg.ts ?? new Date().toISOString()
    this.socket.write(JSON.stringify(msg) + '\n')
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.destroy()
      this.socket = null
    }
  }

  get connected(): boolean {
    return this.socket !== null && !this.socket.destroyed
  }
}

// ---------------------------------------------------------------------------
// Convenience factory functions
// ---------------------------------------------------------------------------

export async function createPipeServer(name: string): Promise<PipeServer> {
  const server = new PipeServer(name)
  await server.start()
  return server
}

export async function connectToPipe(
  targetName: string,
  senderName?: string,
  timeoutMs?: number,
): Promise<PipeClient> {
  const client = new PipeClient(targetName, senderName)
  await client.connect(timeoutMs)
  return client
}

/**
 * List all active pipe names (by scanning the pipes directory).
 */
export async function listPipes(): Promise<string[]> {
  try {
    await ensurePipesDir()
    const files = await readdir(getPipesDir())
    return files
      .filter((f) => f.endsWith('.sock'))
      .map((f) => f.replace(/\.sock$/, ''))
  } catch {
    return []
  }
}

/**
 * Probe whether a pipe server is alive by sending a ping.
 */
export async function isPipeAlive(name: string, timeoutMs: number = 2000): Promise<boolean> {
  try {
    const client = new PipeClient(name, '_probe')
    await client.connect(timeoutMs)

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        client.disconnect()
        resolve(false)
      }, timeoutMs)

      client.onMessage((msg) => {
        if (msg.type === 'pong') {
          clearTimeout(timer)
          client.disconnect()
          resolve(true)
        }
      })

      client.send({ type: 'ping' })
    })
  } catch {
    return false
  }
}
