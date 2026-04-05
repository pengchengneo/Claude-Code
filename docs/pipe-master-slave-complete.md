# Master-Slave CLI 通信系统 — 完整文档

> 版本：1.0  
> 日期：2026-04-05  
> 分支：`claude/agent-teams-communication-YT18t`

---

## 目录

1. [需求文档](#1-需求文档)
2. [设计文档](#2-设计文档)
3. [实现详情](#3-实现详情)
4. [文件清单与修改说明](#4-文件清单与修改说明)
5. [测试验证](#5-测试验证)

---

## 1. 需求文档

### 1.1 背景

Claude Code CLI 目前每个终端实例是完全独立的。用户希望在多个终端之间建立通信机制，使得一个"主 CLI"可以控制和监控多个"从 CLI"，形成类似调度中心的工作模式。

### 1.2 核心需求

| 编号 | 需求 | 优先级 |
|------|------|--------|
| R1 | 每个 CLI 默认是**完全独立**的，没有任何特殊行为 | 必须 |
| R2 | 主 CLI 通过 `/attach` 命令连接到从 CLI，成为**控制中心/监视器** | 必须 |
| R3 | 主 CLI 的自身会话/命令**保持完全正常**，不被劫持 | 必须 |
| R4 | 主 CLI 可以同时连接**多个**从 CLI | 必须 |
| R5 | 从 CLI 是**自主工作者**，独立处理 AI 查询和工具调用 | 必须 |
| R6 | 从 CLI 的命令和对话**只对自己生效** | 必须 |
| R7 | 从 CLI 被 attach 后**自动上报所有会话数据**给主 CLI | 必须 |
| R8 | 上报数据包括：用户输入 + AI 回复 + 工具调用结果 | 必须 |
| R9 | 主 CLI 可以审查从 CLI 的完整会话历史 | 必须 |
| R10 | 主 CLI 可以向从 CLI **发送任务**（注入 prompt） | 必须 |
| R11 | 断开连接后，双方都**恢复为独立模式** | 必须 |
| R12 | 必须是**真正独立的 CLI 进程**，不是模拟 | 必须 |

### 1.3 命令列表

| 命令 | 说明 | 角色 |
|------|------|------|
| `/attach <name>` | 连接到从 CLI，开始接收会话报告 | 主 |
| `/detach [name]` | 断开一个从 CLI（无参数则断开全部） | 主 |
| `/pipes` | 发现所有可用的 CLI 管道 | 任意 |
| `/send <name> <msg>` | 向从 CLI 注入一条 prompt | 主 |
| `/history <name>` | 查看从 CLI 的完整会话记录 | 主 |
| `/pipe-status` | 查看所有已连接从 CLI 的状态概览 | 任意 |

### 1.4 角色状态机

```
          /attach          被 attach
standalone ──────► master    standalone ──────► slave
    ▲                |           ▲                |
    │   /detach      │           │   detach       │
    │   (最后一个)     │           │                │
    └────────────────┘           └────────────────┘
```

- **standalone**（默认）：完全独立，无特殊行为
- **master**：已连接一个或多个 slave，接收会话数据
- **slave**：被一个 master 控制，自动上报会话数据

---

## 2. 设计文档

### 2.1 整体架构

```
┌─────────────────────┐         Unix Domain Socket          ┌─────────────────────┐
│     Master CLI      │◄══════════════════════════════════►  │      Slave CLI      │
│                     │    ~/.claude/pipes/{name}.sock       │                     │
│  ┌───────────────┐  │                                     │  ┌───────────────┐  │
│  │ useMasterMon  │  │  ◄── stream/tool/done/error ────── │  │  usePipeIpc   │  │
│  │  (接收存储)    │  │                                     │  │  (自动上报)    │  │
│  └───────────────┘  │  ── prompt ──────────────────────►  │  └───────────────┘  │
│                     │                                     │                     │
│  AppState.pipeIpc   │                                     │  AppState.pipeIpc   │
│  role: 'master'     │                                     │  role: 'slave'      │
│  slaves: { A, B }   │                                     │  attachedBy: 'M'    │
└─────────────────────┘                                     └─────────────────────┘
```

### 2.2 传输层

**协议**：NDJSON（换行分隔的 JSON），每条消息一行。

**Socket 路径**：
- Unix: `~/.claude/pipes/{name}.sock`
- Windows: `\\.\pipe\claude-code-{name}`

**消息类型**：

| 类型 | 方向 | 说明 |
|------|------|------|
| `ping` / `pong` | 双向 | 健康检查 |
| `attach_request` | M → S | 主请求附加 |
| `attach_accept` | S → M | 从接受附加 |
| `attach_reject` | S → M | 从拒绝（已被其他主控制） |
| `detach` | M → S | 主断开连接 |
| `prompt` | M → S | 主发送任务/提示 |
| `stream` | S → M | AI 输出流片段 |
| `tool_start` | S → M | 工具开始执行 |
| `tool_result` | S → M | 工具执行结果 |
| `done` | S → M | 一轮会话完成 |
| `error` | 双向 | 错误报告 |

**消息格式**：
```typescript
type PipeMessage = {
  type: PipeMessageType    // 消息类型
  data?: string            // 负载内容
  from?: string            // 发送方管道名
  ts?: string              // ISO 时间戳
  meta?: Record<string, unknown>  // 额外元数据
}
```

### 2.3 状态模型

```typescript
// 添加到 AppState
type PipeIpcState = {
  role: 'standalone' | 'master' | 'slave'
  serverName: string | null          // 本 CLI 的管道服务名
  slaves: Record<string, SlaveInfo>  // 主模式：已连接的从 CLI
  attachedBy: string | null          // 从模式：控制我的主 CLI
}

type SlaveInfo = {
  name: string
  connectedAt: string       // ISO 时间戳
  status: 'connected' | 'busy' | 'idle'
  history: SessionEntry[]   // 完整会话记录
}

type SessionEntry = {
  type: 'prompt' | 'stream' | 'tool_start' | 'tool_result' | 'done' | 'error'
  content: string
  from: string
  timestamp: string
  meta?: Record<string, unknown>
}
```

### 2.4 Attach 流程

```
Master CLI                              Slave CLI
    │                                       │
    │── /attach cli-abc12345 ────────────►  │
    │   (PipeClient.connect)                │
    │                                       │
    │── { type: "attach_request" } ──────►  │
    │                                       │── 检查 role === 'standalone'
    │◄── { type: "attach_accept" } ────────│── 设置 role = 'slave'
    │── 设置 role = 'master'                │
    │── 添加到 slaves map                    │
    │                                       │
    │◄═══════ 自动上报会话数据 ═══════════════│  (slave 发送所有 session 事件)
```

### 2.5 Send 流程

```
Master CLI                              Slave CLI
    │                                       │
    │── /send cli-abc12345 "任务" ────────►  │
    │── { type: "prompt", data: "任务" } ──►│
    │                                       │── handleIncomingPrompt()
    │                                       │── AI 处理任务
    │◄── { type: "stream", data: "..." } ──│
    │◄── { type: "tool_start", ... } ──────│
    │◄── { type: "tool_result", ... } ─────│
    │◄── { type: "done" } ─────────────────│
    │── 存入 slaves[name].history            │
```

### 2.6 Detach 流程

```
Master CLI                              Slave CLI
    │                                       │
    │── /detach cli-abc12345 ────────────►  │
    │── { type: "detach" } ──────────────►  │
    │                                       │── 设置 role = 'standalone'
    │── 从 slaves map 删除                   │── 停止自动上报
    │── (如无更多 slave → standalone)         │
```

---

## 3. 实现详情

### 3.1 传输层 — `src/utils/pipeTransport.ts`

**状态**：已有，复用。

**类与函数**：

| 组件 | 说明 |
|------|------|
| `PipeServer` | Unix socket 服务端，管理多个客户端连接。支持 `onMessage(handler)` 注册消息处理、`broadcast(msg)` 广播、`sendTo(socket, msg)` 定向发送 |
| `PipeClient` | 客户端，连接到远程 PipeServer。支持 `connect(timeout)` 自动重试（ENOENT 轮询）、`send(msg)`、`onMessage(handler)` |
| `createPipeServer(name)` | 工厂函数，创建并启动 PipeServer |
| `connectToPipe(target, sender, timeout)` | 工厂函数，创建 PipeClient 并连接 |
| `listPipes()` | 扫描 `~/.claude/pipes/` 目录，返回所有 `.sock` 文件名 |
| `isPipeAlive(name, timeout)` | 通过 ping/pong 检测管道是否存活 |

**关键实现细节**：
- 使用 Node.js `net` 模块的 `createServer` / `createConnection`
- NDJSON 协议：每条消息是一行 JSON，用 `\n` 分隔
- 缓冲区处理：`buffer += chunk; lines = buffer.split('\n'); buffer = lines.pop()`
- ENOENT 处理：连接前用 `fs.access()` 轮询等待 socket 文件存在
- 清理机制：服务关闭时自动 `unlink` socket 文件

### 3.2 Slave 侧 Hook — `src/hooks/usePipeIpc.ts`

**状态**：完全重写。

**核心逻辑**：

```
挂载时:
  1. 生成管道名: cli-{sessionId前8位}
  2. 创建 PipeServer 并监听
  3. 设置 globalThis.__pipeSendToMaster 全局函数
  4. 注册消息处理器:
     - ping → pong
     - attach_request → 检查角色 → accept/reject
     - detach → 恢复 standalone
     - prompt → handleIncomingPrompt 注入
```

**`relayToMaster(msg)` 导出函数**：
- 由 REPL.tsx 的 `onQueryEvent` 调用
- 通过 `globalThis.__pipeSendToMaster` 桥接，避免循环依赖
- 仅在 `role === 'slave'` 时生效

**Master 断线处理**：
- 监听 master socket 的 `close` 事件
- 自动恢复为 standalone

### 3.3 Master 侧 Hook — `src/hooks/useMasterMonitor.ts`

**状态**：新建。

**核心逻辑**：

```
当 role === 'master' 时:
  1. 遍历 _slaveClients Map 中所有 PipeClient
  2. 为每个 client 注册消息监听
  3. 收到 stream/tool_start/tool_result/done/error → 存入 AppState.pipeIpc.slaves[name].history
  4. 更新 slave 状态: prompt → busy, done/error → idle
  5. 监听 slave disconnect → 自动从 slaves 删除
```

**模块级 PipeClient 注册表**：

| 函数 | 说明 |
|------|------|
| `addSlaveClient(name, client)` | 注册从 CLI 连接（由 /attach 调用） |
| `removeSlaveClient(name)` | 删除从 CLI 连接（由 /detach 调用） |
| `getSlaveClient(name)` | 获取指定从 CLI 连接（由 /send 调用） |
| `getAllSlaveClients()` | 获取所有连接（由 /pipe-status 调用） |

### 3.4 命令实现

#### `/attach <name>` — `src/commands/attach/attach.ts`

```
1. 解析目标管道名
2. 检查: 是否已连接该 slave？是否处于 slave 模式？
3. connectToPipe(target, myName) 建立连接
4. 发送 attach_request，等待响应（5s 超时）
5. 收到 attach_accept:
   - addSlaveClient(name, client) 注册到 Monitor
   - 更新 AppState: role → master, 添加 slave 记录
6. 收到 attach_reject: 断开，报告原因
```

#### `/detach [name]` — `src/commands/detach/detach.ts`

```
有目标名:
  1. removeSlaveClient(name)
  2. 发送 detach 消息
  3. client.disconnect()
  4. 从 AppState.slaves 删除
  5. 如无更多 slave → role 恢复 standalone

无目标名（全部断开）:
  1. 遍历所有 slaveClients
  2. 对每个执行上述流程
  3. role → standalone
```

#### `/pipes` — `src/commands/pipes/pipes.ts`

```
1. 显示本 CLI 的管道名和角色
2. 如 master: 显示已连接 slave 列表
3. 如 slave: 显示控制方
4. listPipes() 列出所有管道文件
5. isPipeAlive() 逐个检测存活状态
6. 标记已 attach 的管道
```

#### `/send <name> <msg>` — `src/commands/send/send.ts`

```
1. 检查 role === master
2. 解析: 第一个空格前是管道名，后面是消息
3. getSlaveClient(name) 获取连接
4. client.send({ type: 'prompt', data: message })
5. 记录到 slaves[name].history (type: 'prompt')
6. 更新 slave 状态为 busy
```

#### `/history <name>` — `src/commands/history/history.ts`

```
1. 检查 role === master
2. 从 AppState.pipeIpc.slaves[name].history 读取记录
3. 支持 --last N 参数限制显示条数
4. 格式化输出: [时间] [类型] 内容
   类型标记: [PROMPT] [AI] [TOOL>] [TOOL<] [DONE] [ERROR]
```

#### `/pipe-status` — `src/commands/pipe-status/pipe-status.ts`

```
1. standalone: 提示未连接
2. slave: 显示控制方信息
3. master: 逐个显示 slave 信息
   - 名称、状态(idle/busy)、连接状态、连接时间、历史条数
```

### 3.5 REPL 集成 — `src/screens/REPL.tsx`

**修改点一：导入**（第 144-145 行）
```typescript
import { usePipeIpc, relayToMaster } from '../hooks/usePipeIpc.js';
import { useMasterMonitor } from '../hooks/useMasterMonitor.js';
```

**修改点二：Hook 挂载**（第 4114-4120 行，位于 `useMailboxBridge` 之后）
```typescript
usePipeIpc({
  enabled: true,
  isLoading,
  onSubmitMessage: handleIncomingPrompt,
});
useMasterMonitor();
```

**修改点三：`resetLoadingState` 中发送 done 信号**（第 1607 行）
```typescript
relayToMaster({ type: 'done' });
```
每轮 AI 对话结束时通知 master。

**修改点四：`onQueryEvent` 中继 AI 输出**

流式文本回调（第 2697 行）：
```typescript
relayToMaster({ type: 'stream', data: newContent });
```

消息处理回调中（第 2671-2678 行）：
```typescript
// Tool 事件
if (newMessage.type === 'progress') {
  relayToMaster({ type: 'tool_start', data: tool, meta: { toolUseId } });
  relayToMaster({ type: 'tool_result', data: result, meta: { toolUseId } });
}
// Assistant 文本消息
if (newMessage.type === 'assistant') {
  relayToMaster({ type: 'stream', data: text });
}
```

**删除点：旧的 master 输入劫持**

旧代码会在 master 模式下拦截用户输入转发给 slave，这**违反需求 R3**（主 CLI 保持完全正常）。已完全删除此逻辑。任务发送现在只通过 `/send` 命令。

### 3.6 状态定义 — `src/state/AppStateStore.ts`

**新增类型**（第 93-116 行）：
```typescript
export type SessionEntry = {
  type: 'prompt' | 'stream' | 'tool_start' | 'tool_result' | 'done' | 'error'
  content: string
  from: string
  timestamp: string
  meta?: Record<string, unknown>
}

export type SlaveInfo = {
  name: string
  connectedAt: string
  status: 'connected' | 'busy' | 'idle'
  history: SessionEntry[]
}

export type PipeIpcState = {
  role: 'standalone' | 'master' | 'slave'
  serverName: string | null
  slaves: Record<string, SlaveInfo>
  attachedBy: string | null
}
```

**AppState 新增字段**（第 481 行）：
```typescript
pipeIpc: PipeIpcState
```

**默认值**（第 598 行）：
```typescript
pipeIpc: {
  role: 'standalone',
  serverName: null,
  slaves: {},
  attachedBy: null,
}
```

### 3.7 命令注册 — `src/commands.ts`

**新增导入**（第 59-64 行）：
```typescript
import attach from './commands/attach/index.js'
import detach from './commands/detach/index.js'
import pipes from './commands/pipes/index.js'
import send from './commands/send/index.js'
import pipeHistory from './commands/history/index.js'
import pipeStatus from './commands/pipe-status/index.js'
```

**注册到 COMMANDS 数组**（第 335-340 行）：
```typescript
attach,
detach,
pipes,
send,
pipeHistory,
pipeStatus,
```

---

## 4. 文件清单与修改说明

### 4.1 新建文件

| 文件 | 说明 |
|------|------|
| `docs/pipe-master-slave-design.md` | 设计文档 |
| `src/utils/pipeTransport.ts` | 传输层：PipeServer、PipeClient、NDJSON 协议 |
| `src/hooks/usePipeIpc.ts` | Slave 侧 Hook：自动建立 PipeServer、处理 attach/detach/prompt、relay |
| `src/hooks/useMasterMonitor.ts` | Master 侧 Hook：监听 slave 会话数据、存储历史记录 |
| `src/commands/attach/index.ts` | /attach 命令注册 |
| `src/commands/attach/attach.ts` | /attach 命令实现 |
| `src/commands/detach/index.ts` | /detach 命令注册 |
| `src/commands/detach/detach.ts` | /detach 命令实现 |
| `src/commands/pipes/index.ts` | /pipes 命令注册 |
| `src/commands/pipes/pipes.ts` | /pipes 命令实现 |
| `src/commands/send/index.ts` | /send 命令注册 |
| `src/commands/send/send.ts` | /send 命令实现 |
| `src/commands/history/index.ts` | /history 命令注册 |
| `src/commands/history/history.ts` | /history 命令实现 |
| `src/commands/pipe-status/index.ts` | /pipe-status 命令注册 |
| `src/commands/pipe-status/pipe-status.ts` | /pipe-status 命令实现 |
| `test-pipe-ipc.ts` | 双进程端到端测试脚本 |

### 4.2 修改的已有文件

| 文件 | 修改内容 |
|------|----------|
| `src/state/AppStateStore.ts` | 新增 `SessionEntry`、`SlaveInfo`、`PipeIpcState` 类型；AppState 添加 `pipeIpc` 字段；`getDefaultAppState()` 添加默认值 |
| `src/commands.ts` | 导入 6 个新命令模块；注册到 `COMMANDS` 数组 |
| `src/screens/REPL.tsx` | 导入 `usePipeIpc`/`relayToMaster`/`useMasterMonitor`；挂载两个 Hook；`resetLoadingState` 中添加 done 信号；`onQueryEvent` 中添加 stream/tool/assistant 中继；**删除**旧的 master 输入劫持逻辑和旧的 `__pipeSendToMaster` 内联调用 |

### 4.3 删除的文件

| 文件 | 原因 |
|------|------|
| `src/hooks/useMasterRelay.ts` | 旧的单 slave 架构，被 `useMasterMonitor.ts` 替代 |

---

## 5. 测试验证

### 5.1 集成测试（同进程双端通信）

通过 `test-pipe-ipc.ts` 在同一进程中创建独立的 PipeServer 和 PipeClient，通过真实 Unix domain socket 通信。

**测试用例**：

| # | 测试项 | 结果 |
|---|--------|------|
| 1 | Slave PipeServer 启动成功 | ✓ PASS |
| 2 | `listPipes()` 发现管道 | ✓ PASS |
| 3 | `isPipeAlive()` ping/pong 健康检查 | ✓ PASS |
| 4 | Master 连接到 Slave | ✓ PASS |
| 5 | Attach 请求被接受 | ✓ PASS |
| 6 | 重复 attach 被正确拒绝 | ✓ PASS |
| 7 | 发送 prompt → 收到完整 session 数据 (stream×2 → tool_start → tool_result → done) | ✓ PASS |
| 8 | Stream 内容完整 | ✓ PASS |
| 9 | Tool 事件携带正确 metadata | ✓ PASS |
| 10 | Detach 命令 | ✓ PASS |
| 11 | Detach 后重新 attach 成功 | ✓ PASS |

### 5.2 双独立进程测试

启动两个真正独立的操作系统进程：

```
进程 A (Slave, PID 12572):
  bun run test-pipe-ipc.ts slave

进程 B (Master, PID 12588):
  bun run test-pipe-ipc.ts master
```

**验证结果**：

```
[SLAVE]  Server started: test-slave-001
[SLAVE]  等待 master 连接...

[MASTER] Connecting to slave "test-slave-001"...
[MASTER] Connected!
[MASTER] 已发送 attach_request
[SLAVE]  Accepted attach from test-master-001
[MASTER] 收到: attach_accept test-slave-001

[MASTER] 已发送 prompt
[SLAVE]  Received prompt: "请帮我分析这段代码的问题"
[SLAVE]  Sent stream fragment 1
[MASTER] 收到: stream Processing your request
[SLAVE]  Sent stream fragment 2
[MASTER] 收到: stream ... analyzing code...
[SLAVE]  Sent tool_start
[MASTER] 收到: tool_start ReadFile
[SLAVE]  Sent tool_result
[MASTER] 收到: tool_result file contents here...
[SLAVE]  Sent done
[MASTER] 收到: done

[SLAVE]  Detached by test-master-001
[MASTER] 已断开连接
```

**结论**：两个独立进程通过 Unix domain socket 完成了完整的 attach → prompt → session 数据回传 → detach 流程。

### 5.3 测试命令

```bash
# 集成测试（11 项全部通过）
bun run test-pipe-ipc.ts

# 双进程测试（终端 1）
bun run test-pipe-ipc.ts slave

# 双进程测试（终端 2）
bun run test-pipe-ipc.ts master
```
