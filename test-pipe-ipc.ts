#!/usr/bin/env bun
/**
 * 双进程 Pipe IPC 端到端测试
 *
 * 模拟两个独立 CLI 的完整通信流程：
 * 1. 进程 A（slave）：启动 PipeServer，等待 attach
 * 2. 进程 B（master）：连接到 A，发送 attach_request，发送 prompt，接收 stream/done
 *
 * 用法：
 *   bun run test-pipe-ipc.ts
 *
 * 或分别测试两个独立进程：
 *   bun run test-pipe-ipc.ts slave
 *   bun run test-pipe-ipc.ts master
 */

import {
  createPipeServer,
  connectToPipe,
  listPipes,
  isPipeAlive,
  type PipeMessage,
  type PipeServer,
  type PipeClient,
} from './src/utils/pipeTransport.js'

const SLAVE_PIPE = 'test-slave-001'
const MASTER_NAME = 'test-master-001'

// ─── Colors for output ───
const RED = '\x1b[31m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const CYAN = '\x1b[36m'
const RESET = '\x1b[0m'

function log(role: string, msg: string) {
  const color = role === 'SLAVE' ? CYAN : YELLOW
  const ts = new Date().toISOString().slice(11, 23)
  console.log(`${color}[${ts}] [${role}]${RESET} ${msg}`)
}

function pass(test: string) {
  console.log(`  ${GREEN}✓ PASS${RESET}: ${test}`)
}

function fail(test: string, reason: string) {
  console.log(`  ${RED}✗ FAIL${RESET}: ${test} — ${reason}`)
  process.exitCode = 1
}

// ═══════════════════════════════════════════════════════════════
// Slave Process: starts PipeServer, handles attach/prompt/detach
// ═══════════════════════════════════════════════════════════════
async function runSlave(): Promise<PipeServer> {
  log('SLAVE', `Starting PipeServer "${SLAVE_PIPE}"...`)
  const server = await createPipeServer(SLAVE_PIPE)
  log('SLAVE', `Server started at ${server.socketPath}`)

  let role: 'standalone' | 'slave' = 'standalone'
  let masterSocket: import('net').Socket | null = null

  // Ping handler
  server.onMessage((msg, reply) => {
    if (msg.type === 'ping') {
      reply({ type: 'pong' })
    }
  })

  // Attach handler
  server.onMessage((msg, reply) => {
    if (msg.type === 'attach_request') {
      if (role === 'slave') {
        reply({ type: 'attach_reject', data: 'Already attached' })
        log('SLAVE', `Rejected attach from ${msg.from}`)
        return
      }

      role = 'slave'
      // Get latest client socket
      const clients = Array.from((server as any).clients as Set<import('net').Socket>)
      masterSocket = clients[clients.length - 1] ?? null

      reply({ type: 'attach_accept', data: SLAVE_PIPE })
      log('SLAVE', `Accepted attach from ${msg.from}`)
    }
  })

  // Detach handler
  server.onMessage((msg, _reply) => {
    if (msg.type === 'detach') {
      role = 'standalone'
      masterSocket = null
      log('SLAVE', `Detached by ${msg.from}`)
    }
  })

  // Prompt handler — simulate AI processing
  server.onMessage((msg, _reply) => {
    if (msg.type === 'prompt') {
      if (role !== 'slave') return
      log('SLAVE', `Received prompt: "${msg.data}"`)

      // Simulate AI response: stream fragments → tool_start → tool_result → done
      if (masterSocket && !masterSocket.destroyed) {
        const send = (m: PipeMessage) => {
          m.from = m.from ?? SLAVE_PIPE
          m.ts = m.ts ?? new Date().toISOString()
          masterSocket!.write(JSON.stringify(m) + '\n')
        }

        setTimeout(() => {
          send({ type: 'stream', data: 'Processing your request' })
          log('SLAVE', 'Sent stream fragment 1')
        }, 100)

        setTimeout(() => {
          send({ type: 'stream', data: '... analyzing code...' })
          log('SLAVE', 'Sent stream fragment 2')
        }, 200)

        setTimeout(() => {
          send({ type: 'tool_start', data: 'ReadFile', meta: { toolUseId: 'tool-123' } })
          log('SLAVE', 'Sent tool_start')
        }, 300)

        setTimeout(() => {
          send({ type: 'tool_result', data: 'file contents here...', meta: { toolUseId: 'tool-123' } })
          log('SLAVE', 'Sent tool_result')
        }, 400)

        setTimeout(() => {
          send({ type: 'done' })
          log('SLAVE', 'Sent done')
        }, 500)
      }
    }
  })

  return server
}

// ═══════════════════════════════════════════════════════════════
// Master Process: connects to slave, attaches, sends prompt
// ═══════════════════════════════════════════════════════════════
async function runMaster(): Promise<PipeClient> {
  log('MASTER', `Connecting to slave "${SLAVE_PIPE}"...`)
  const client = await connectToPipe(SLAVE_PIPE, MASTER_NAME)
  log('MASTER', 'Connected!')
  return client
}

// ═══════════════════════════════════════════════════════════════
// Full integration test (both in same process for simplicity,
// but they communicate via real Unix domain sockets)
// ═══════════════════════════════════════════════════════════════
async function runFullTest() {
  console.log('\n═══════════════════════════════════════════════')
  console.log('  Pipe IPC 双进程通信端到端测试')
  console.log('═══════════════════════════════════════════════\n')

  let testsPassed = 0
  let testsFailed = 0

  // ── Test 1: Server startup ──
  let server: PipeServer
  try {
    server = await runSlave()
    pass('Slave PipeServer 启动成功')
    testsPassed++
  } catch (err) {
    fail('Slave PipeServer 启动', String(err))
    process.exit(1)
    return // unreachable
  }

  // ── Test 2: List pipes ──
  try {
    const pipes = await listPipes()
    if (pipes.includes(SLAVE_PIPE)) {
      pass(`listPipes() 发现了 "${SLAVE_PIPE}"`)
      testsPassed++
    } else {
      fail('listPipes()', `未找到 "${SLAVE_PIPE}"，只有: ${pipes.join(', ')}`)
      testsFailed++
    }
  } catch (err) {
    fail('listPipes()', String(err))
    testsFailed++
  }

  // ── Test 3: Ping/Pong (liveness check) ──
  try {
    const alive = await isPipeAlive(SLAVE_PIPE)
    if (alive) {
      pass('isPipeAlive() ping/pong 健康检查通过')
      testsPassed++
    } else {
      fail('isPipeAlive()', '返回 false')
      testsFailed++
    }
  } catch (err) {
    fail('isPipeAlive()', String(err))
    testsFailed++
  }

  // ── Test 4: Master connects ──
  let client: PipeClient
  try {
    client = await runMaster()
    pass('Master 连接到 Slave 成功')
    testsPassed++
  } catch (err) {
    fail('Master 连接', String(err))
    await server.close()
    process.exit(1)
    return
  }

  // ── Test 5: Attach request/accept ──
  try {
    const attachResult = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('attach 超时')), 3000)

      client.onMessage((msg) => {
        if (msg.type === 'attach_accept') {
          clearTimeout(timeout)
          resolve('accepted')
        } else if (msg.type === 'attach_reject') {
          clearTimeout(timeout)
          resolve(`rejected: ${msg.data}`)
        }
      })

      client.send({ type: 'attach_request' })
      log('MASTER', 'Sent attach_request')
    })

    if (attachResult === 'accepted') {
      pass('Attach 请求被接受')
      testsPassed++
    } else {
      fail('Attach 请求', attachResult)
      testsFailed++
    }
  } catch (err) {
    fail('Attach 请求', String(err))
    testsFailed++
  }

  // ── Test 6: Duplicate attach rejection ──
  try {
    const client2 = await connectToPipe(SLAVE_PIPE, 'intruder')
    const rejectResult = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('超时')), 3000)
      client2.onMessage((msg) => {
        if (msg.type === 'attach_reject') {
          clearTimeout(timeout)
          resolve('rejected')
        } else if (msg.type === 'attach_accept') {
          clearTimeout(timeout)
          resolve('accepted (wrong!)')
        }
      })
      client2.send({ type: 'attach_request' })
    })

    client2.disconnect()

    if (rejectResult === 'rejected') {
      pass('重复 attach 被正确拒绝')
      testsPassed++
    } else {
      fail('重复 attach', `期望被拒绝，但结果是: ${rejectResult}`)
      testsFailed++
    }
  } catch (err) {
    fail('重复 attach', String(err))
    testsFailed++
  }

  // ── Test 7: Send prompt and receive full session data ──
  try {
    const receivedMessages: PipeMessage[] = []

    const sessionResult = await new Promise<PipeMessage[]>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('session 数据超时')), 5000)

      client.onMessage((msg) => {
        if (['stream', 'tool_start', 'tool_result', 'done'].includes(msg.type)) {
          receivedMessages.push(msg)
          log('MASTER', `收到 ${msg.type}: ${(msg.data ?? '').slice(0, 50)}`)

          if (msg.type === 'done') {
            clearTimeout(timeout)
            resolve(receivedMessages)
          }
        }
      })

      client.send({ type: 'prompt', data: '请帮我分析代码' })
      log('MASTER', '发送 prompt: "请帮我分析代码"')
    })

    // Verify received message types
    const types = sessionResult.map((m) => m.type)
    const expectedTypes = ['stream', 'stream', 'tool_start', 'tool_result', 'done']

    if (JSON.stringify(types) === JSON.stringify(expectedTypes)) {
      pass(`收到完整 session 数据: ${types.join(' → ')}`)
      testsPassed++
    } else {
      fail('Session 数据', `期望 [${expectedTypes.join(', ')}]，实际 [${types.join(', ')}]`)
      testsFailed++
    }

    // Verify stream content
    const streamContent = sessionResult
      .filter((m) => m.type === 'stream')
      .map((m) => m.data)
      .join('')
    if (streamContent.includes('Processing') && streamContent.includes('analyzing')) {
      pass('Stream 内容完整')
      testsPassed++
    } else {
      fail('Stream 内容', `内容不完整: "${streamContent}"`)
      testsFailed++
    }

    // Verify tool events
    const toolStart = sessionResult.find((m) => m.type === 'tool_start')
    if (toolStart?.data === 'ReadFile' && toolStart?.meta?.toolUseId === 'tool-123') {
      pass('Tool 事件携带正确 metadata')
      testsPassed++
    } else {
      fail('Tool 事件', `数据不正确: ${JSON.stringify(toolStart)}`)
      testsFailed++
    }
  } catch (err) {
    fail('Session 数据传输', String(err))
    testsFailed++
  }

  // ── Test 8: Detach ──
  try {
    client.send({ type: 'detach' })
    log('MASTER', '发送 detach')
    // Give slave time to process
    await new Promise((r) => setTimeout(r, 200))
    pass('Detach 命令发送成功')
    testsPassed++
  } catch (err) {
    fail('Detach', String(err))
    testsFailed++
  }

  // ── Test 9: Re-attach after detach ──
  try {
    const reattachResult = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('re-attach 超时')), 3000)
      client.onMessage((msg) => {
        if (msg.type === 'attach_accept') {
          clearTimeout(timeout)
          resolve('accepted')
        } else if (msg.type === 'attach_reject') {
          clearTimeout(timeout)
          resolve(`rejected: ${msg.data}`)
        }
      })
      client.send({ type: 'attach_request' })
    })

    if (reattachResult === 'accepted') {
      pass('Detach 后重新 attach 成功')
      testsPassed++
    } else {
      fail('重新 attach', reattachResult)
      testsFailed++
    }
  } catch (err) {
    fail('重新 attach', String(err))
    testsFailed++
  }

  // ── Cleanup ──
  client.disconnect()
  await server.close()
  log('SLAVE', 'Server 已关闭')

  // ── Summary ──
  console.log('\n═══════════════════════════════════════════════')
  console.log(`  测试结果: ${GREEN}${testsPassed} 通过${RESET}, ${testsFailed > 0 ? RED : GREEN}${testsFailed} 失败${RESET}`)
  console.log('═══════════════════════════════════════════════\n')

  if (testsFailed > 0) {
    process.exit(1)
  }
}

// ═══════════════════════════════════════════════════════════════
// Standalone modes (for testing with truly separate processes)
// ═══════════════════════════════════════════════════════════════
const mode = process.argv[2]

if (mode === 'slave') {
  // Run as standalone slave — waits for connections
  console.log('启动 Slave 模式（按 Ctrl+C 退出）...\n')
  const server = await runSlave()
  log('SLAVE', `等待 master 连接... pipe: ${SLAVE_PIPE}`)

  process.on('SIGINT', async () => {
    log('SLAVE', '关闭中...')
    await server.close()
    process.exit(0)
  })
} else if (mode === 'master') {
  // Run as standalone master — connects to existing slave
  console.log('启动 Master 模式...\n')
  try {
    const client = await runMaster()

    // Attach
    client.onMessage((msg) => {
      log('MASTER', `收到: ${msg.type} ${msg.data ?? ''}`)
    })

    client.send({ type: 'attach_request' })
    log('MASTER', '已发送 attach_request，等待响应...')

    // Wait a bit then send prompt
    setTimeout(() => {
      client.send({ type: 'prompt', data: '请帮我分析这段代码的问题' })
      log('MASTER', '已发送 prompt')
    }, 1000)

    // Disconnect after 5s
    setTimeout(() => {
      client.send({ type: 'detach' })
      client.disconnect()
      log('MASTER', '已断开连接')
      process.exit(0)
    }, 5000)
  } catch (err) {
    console.error('Master 连接失败:', err)
    process.exit(1)
  }
} else {
  // Default: run full integrated test
  await runFullTest()
}
