/**
 * Pipe REPL - Interactive terminal-to-terminal communication demo
 *
 * This module wires up PipeServer / PipeClient to provide a bidirectional
 * chat + remote-command channel between two independent Claude Code terminals.
 *
 * Usage (two separate terminals):
 *
 *   Terminal A (server):
 *     import { startPipeRepl } from './pipeRepl.js'
 *     await startPipeRepl({ role: 'server', name: 'repl' })
 *
 *   Terminal B (client):
 *     import { startPipeRepl } from './pipeRepl.js'
 *     await startPipeRepl({ role: 'client', target: 'repl', name: 'client-b' })
 *
 * Messages:
 *   - Plain text  → chat message forwarded to the other side
 *   - /cmd <expr> → remote command execution request
 *   - /exit       → graceful disconnect
 *   - /list       → show all active pipes
 *   - /ping       → latency check
 */

import { createInterface } from 'readline'
import {
  createPipeServer,
  connectToPipe,
  listPipes,
  type PipeMessage,
  type PipeServer,
  type PipeClient,
} from './pipeTransport.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PipeReplOptions =
  | { role: 'server'; name: string }
  | { role: 'client'; target: string; name?: string }

// ---------------------------------------------------------------------------
// REPL
// ---------------------------------------------------------------------------

export async function startPipeRepl(options: PipeReplOptions): Promise<void> {
  let server: PipeServer | undefined
  let client: PipeClient | undefined

  // A unified send function set after connection
  let sendFn: (msg: PipeMessage) => void = () => {}

  const log = (prefix: string, text: string) => {
    process.stdout.write(`\n${prefix} ${text}\n> `)
  }

  // Handler for incoming messages (shared by server & client)
  const handleMessage = (msg: PipeMessage, reply: (m: PipeMessage) => void) => {
    switch (msg.type) {
      case 'chat':
        log(`[${msg.from}]`, msg.data ?? '')
        break

      case 'cmd':
        log(`[${msg.from}] CMD:`, msg.data ?? '')
        // Execute and reply with result
        try {
          const { execSync } = require('child_process') as typeof import('child_process')
          const output = execSync(msg.data ?? '', {
            encoding: 'utf-8',
            timeout: 10_000,
          }).trim()
          reply({ type: 'result', data: output })
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err)
          reply({ type: 'result', data: `ERROR: ${errMsg}` })
        }
        break

      case 'result':
        log('[RESULT]', msg.data ?? '(empty)')
        break

      case 'ping':
        reply({ type: 'pong', data: new Date().toISOString() })
        break

      case 'pong':
        log('[PONG]', `from ${msg.from} at ${msg.data}`)
        break

      case 'exit':
        log('[SYSTEM]', `${msg.from} disconnected.`)
        break
    }
  }

  // ---- Setup ----

  if (options.role === 'server') {
    server = await createPipeServer(options.name)

    // Auto-respond to pings (for health checks)
    server.onMessage((msg, reply) => {
      if (msg.type === 'ping') {
        reply({ type: 'pong', data: new Date().toISOString() })
      }
    })

    server.onMessage(handleMessage)
    sendFn = (msg) => server!.broadcast(msg)

    console.log(`[PIPE SERVER] Listening as "${options.name}"`)
    console.log(`[PIPE SERVER] Socket: ${server.socketPath}`)
    console.log(`[PIPE SERVER] Waiting for connections...`)

    server.on('connection', () => {
      log('[SYSTEM]', `Client connected (${server!.connectionCount} total)`)
    })
    server.on('disconnect', () => {
      log('[SYSTEM]', `Client disconnected (${server!.connectionCount} remaining)`)
    })
  } else {
    const senderName = options.name ?? `client-${process.pid}`
    client = await connectToPipe(options.target, senderName)
    client.onMessage(handleMessage)
    sendFn = (msg) => client!.send(msg)

    console.log(`[PIPE CLIENT] Connected to "${options.target}" as "${senderName}"`)
  }

  // ---- Interactive loop ----

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
  })

  rl.prompt()

  rl.on('line', async (line) => {
    const input = line.trim()
    if (!input) {
      rl.prompt()
      return
    }

    if (input === '/exit') {
      sendFn({ type: 'exit' })
      console.log('[SYSTEM] Bye!')
      if (server) await server.close()
      if (client) client.disconnect()
      rl.close()
      process.exit(0)
    }

    if (input === '/list') {
      const pipes = await listPipes()
      console.log(`[PIPES] Active: ${pipes.length > 0 ? pipes.join(', ') : '(none)'}`)
      rl.prompt()
      return
    }

    if (input === '/ping') {
      sendFn({ type: 'ping' })
      rl.prompt()
      return
    }

    if (input.startsWith('/cmd ')) {
      sendFn({ type: 'cmd', data: input.slice(5) })
      rl.prompt()
      return
    }

    // Default: chat message
    sendFn({ type: 'chat', data: input })
    rl.prompt()
  })

  rl.on('close', async () => {
    if (server) await server.close()
    if (client) client.disconnect()
  })
}
