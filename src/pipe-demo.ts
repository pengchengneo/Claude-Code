#!/usr/bin/env bun
/**
 * Pipe Demo - Quick launcher for terminal-to-terminal communication
 *
 * Usage:
 *   # Terminal A (server):
 *   bun run src/pipe-demo.ts server myroom
 *
 *   # Terminal B (client):
 *   bun run src/pipe-demo.ts client myroom
 *
 * Commands inside REPL:
 *   (text)       → send chat message
 *   /cmd <cmd>   → execute command on remote side
 *   /ping        → latency check
 *   /list        → list active pipes
 *   /exit        → disconnect
 */

import { startPipeRepl } from './utils/pipeRepl.js'

const [, , role, name] = process.argv

if (role === 'server') {
  const pipeName = name || 'default'
  await startPipeRepl({ role: 'server', name: pipeName })
} else if (role === 'client') {
  const target = name || 'default'
  await startPipeRepl({ role: 'client', target })
} else {
  console.log(`Usage:
  bun run src/pipe-demo.ts server [name]   # Start pipe server (default name: "default")
  bun run src/pipe-demo.ts client [name]   # Connect to pipe server

Example:
  Terminal A:  bun run src/pipe-demo.ts server myroom
  Terminal B:  bun run src/pipe-demo.ts client myroom

Then type messages in either terminal to chat.
  /cmd ls       Send a command to execute on remote side
  /ping         Check latency
  /list         List active pipes
  /exit         Disconnect`)
  process.exit(1)
}
