# Master-Slave CLI Communication Architecture Design Document

## 1. Overview

This document describes a **master-slave architecture** for inter-CLI communication using Unix domain sockets (named pipes). The system allows independent CLI instances to form a coordination network where:

- **Master CLI**: A control center that connects to multiple slave CLIs, sends them tasks, and receives their full session data (user input + AI output + tool results) for review.
- **Slave CLI**: An autonomous worker that processes tasks independently. When attached by a master, it automatically reports all session activity back to the master.
- **Standalone CLI**: The default mode — a completely normal, independent CLI with no special behavior.

## 2. Core Principles

1. **Independence by default**: Every CLI starts as standalone. No master/slave behavior until explicitly activated via `/attach`.
2. **Master is a monitor, not a terminal proxy**: The master CLI's own conversation/commands remain fully functional. Master monitors slaves, it doesn't become them.
3. **Slave is autonomous**: Slave executes its own AI queries and tool calls. It just reports what happens to the master.
4. **Multiple slaves**: A master can attach to multiple slaves simultaneously.
5. **Bidirectional control**: Master can send prompts to slaves via `/send`, and receives session reports automatically.
6. **Clean detach**: Either side can disconnect, returning to standalone mode.

## 3. Architecture

### 3.1 Transport Layer (existing — `src/utils/pipeTransport.ts`)

- **PipeServer**: Each CLI creates a Unix domain socket server at `~/.claude/pipes/{session-id}.sock`
- **PipeClient**: Connects to a remote PipeServer for communication
- **Protocol**: NDJSON (newline-delimited JSON) over Unix domain sockets
- **Message types**: `ping/pong`, `attach_request/accept/reject`, `detach`, `prompt`, `stream`, `tool_start`, `tool_result`, `done`, `error`

### 3.2 State Model (`AppState.pipeIpc`)

```typescript
pipeIpc: {
  role: 'standalone' | 'master' | 'slave'
  serverName: string | null          // This CLI's pipe server name
  // Master-specific
  slaves: Map<string, SlaveInfo>     // Connected slaves (name → info)
  // Slave-specific
  attachedBy: string | null          // Master pipe name (when slave)
}

type SlaveInfo = {
  name: string
  connectedAt: string                // ISO timestamp
  status: 'connected' | 'busy' | 'idle'
  history: SessionEntry[]            // Full session transcript
}

type SessionEntry = {
  type: 'prompt' | 'stream' | 'tool_start' | 'tool_result' | 'done' | 'error'
  content: string
  from: string
  timestamp: string
  meta?: Record<string, unknown>
}
```

### 3.3 Hooks

#### `usePipeIpc` (every CLI)
- On mount: create PipeServer for this session
- Handle `attach_request` → accept, switch to slave role, begin auto-reporting
- Handle `prompt` → inject via `handleIncomingPrompt`
- Handle `detach` → revert to standalone
- **Auto-report**: When in slave role, relay all session events (user input, AI output, tool calls) to master via `globalThis.__pipeSendToMaster`

#### `useMasterMonitor` (master only)
- Active when `role === 'master'`
- For each connected slave PipeClient: listen for `stream`, `tool_start`, `tool_result`, `done`, `error`
- Store received messages into `slaves[name].history`
- Update slave status (`busy`/`idle`) based on `prompt`/`done` events

### 3.4 Session Relay (Slave → Master)

When a CLI is in slave role, the REPL's `onQueryEvent` handler additionally calls `globalThis.__pipeSendToMaster()` to forward:
- **AI stream fragments** → `{ type: 'stream', data: text }`
- **Tool start** → `{ type: 'tool_start', data: toolName, meta: { toolUseId } }`
- **Tool results** → `{ type: 'tool_result', data: resultText, meta: { toolUseId } }`
- **Turn complete** → `{ type: 'done' }`
- **Errors** → `{ type: 'error', data: errorMessage }`

### 3.5 Commands

| Command | Description |
|---------|-------------|
| `/pipes` | List all discoverable pipe servers with liveness status |
| `/attach <name>` | Connect to a slave CLI, begin receiving session reports |
| `/detach [name]` | Disconnect from one slave (or all if no arg) |
| `/send <name> <msg>` | Inject a prompt into a slave CLI |
| `/history <name>` | View a slave's full session transcript |
| `/status` | Overview of all connected slaves and their status |

## 4. Flow Diagrams

### 4.1 Attach Flow
```
Master CLI                          Slave CLI
    |                                   |
    |-- /attach cli-abc12345 -------->  |
    |   (PipeClient connects)           |
    |                                   |
    |-- attach_request --------------->  |
    |                                   |-- (checks role == standalone)
    |<------------- attach_accept ------|-- (sets role = slave)
    |-- (sets role = master)            |
    |-- (adds to slaves map)            |
    |                                   |
    |<============ auto-report =========|  (slave sends all session data)
```

### 4.2 Send Flow
```
Master CLI                          Slave CLI
    |                                   |
    |-- /send cli-abc12345 "task" -->   |
    |-- prompt {data: "task"} -------->  |
    |                                   |-- (handleIncomingPrompt)
    |                                   |-- (AI processes task)
    |<-------- stream {data: "..."} ----|
    |<-------- tool_start -------------|
    |<-------- tool_result ------------|
    |<-------- done -------------------|
    |-- (stores in history)             |
```

### 4.3 Detach Flow
```
Master CLI                          Slave CLI
    |                                   |
    |-- /detach cli-abc12345 -------->  |
    |-- detach ---------------------->  |
    |                                   |-- (sets role = standalone)
    |-- (removes from slaves map)       |-- (stops auto-report)
    |-- (role stays master or           |
    |    becomes standalone if          |
    |    no more slaves)                |
```

## 5. Implementation Plan

1. Update `AppState.pipeIpc` to support multi-slave master model
2. Rewrite `usePipeIpc` hook for correct slave behavior
3. Create `useMasterMonitor` hook for master-side monitoring
4. Rewrite `/attach` command for multi-slave support
5. Rewrite `/detach` command with optional target
6. Update `/pipes` command
7. Create `/send`, `/history`, `/status` commands
8. Mount hooks in REPL.tsx
9. Register all commands in commands.ts
10. Integrate session relay into REPL's `onQueryEvent`
