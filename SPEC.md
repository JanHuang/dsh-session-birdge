# DSH Session Bridge 技术方案

> **实现说明（v0.1.0）**
>
> 本仓库按下面的方案实现，与原始设计稿的差异如下：
>
> - 使用纯 ESM JavaScript（`src/host/*.js`），无构建步骤、无运行时依赖；
>   持久化使用 Node 内置 `node:sqlite`（Host 运行时为 Node 24），
>   因此不需要 `better-sqlite3` 或原生编译。
> - 角色 Session 绑定以运行时 `session_bind` 为主（Session id 易变），
>   也可用 `roles.<name>.sessionId` 做配置固定；全部绑定写入 SQLite。
> - 工具集在方案基础上增加 `session_bind`（绑定本会话）和
>   `session_roles`（查看角色/权限）；`session_list` 已实现。
> - 投递幂等：`sessionController.prompt` 的 `requestId` 直接使用 `messageId`，
>   目标 Agent 对重复 prompt 去重。
> - M6 Client 消息面板已实现（v0.2）：在会话 View 行「轨迹」之后注册
>   「会话桥」标签：同一对会话的所有线程合并为一个聊天窗；左侧会话列表
>   超高时独立滚动，右侧聊天头部与底部输入栏固定，仅消息区滚动；默认显示
>   当天，滚动到顶部或点击上拉条时通过 `/api/session-bridge/history`
>   每次加载 20 条更早消息，当天为空时自动加载最新一页。
>   消息为流式卡片：接收方在左、发送方在右；Lead 请求用中性底色，Bridge
>   回复固定 #165DFF 白字；代码块深色并带复制；面板跟随宿主
>   `body[data-ds-dark-theme]` 切换浅/深色。新消息通过
>   `/api/session-bridge/events`（SSE）实时追加，不做定时轮询。
>   底部输入栏通过 `/api/session-bridge/send` 排队请求；数据路由受 Web 连接
>   owner 防火墙保护。
> - 审计表只记录路由与状态，不记录消息正文。
> - 实测发现 Host 的 Session 控制面把 `origin: subagent` 的子会话保留给
>   subagent routing（`session/agent-busy`），因此桥接只面向独立顶层会话：
>   `session_bind` 拒绝子会话，投递遇到该错误按终态失败并通知发送方，
>   不再无意义重试。
> - 在方案之外增加了用户要求的 **@ 会话直投**：`session_send` / `session_ask`
>   接受 `toSessionId`（来自 DSH 的 @ 会话引用），目标无需先绑定角色；
>   直投不经过 `canSendTo`（属于用户显式指定），可被
>   `security.allowDirectSessionTargets: false` 关闭。
> - 增加 `session_ask`：同一 tool call 内等待对方回复并返回文本（默认 90s，
>   超时回退为异步消息，不丢消息）。回复消费后标记 acked，不会重复投递。
> - 回复不再受 `canSendTo` 限制（回复已收到的消息是天然权限），
>   修复了默认角色图中非对称边导致回复被拒的死链。
>
> 原始设计内容如下。

> 用途：让不同独立 Session（实现、审核、设计、部署）异步互相投递消息。
> 建议作为新仓库 `dsh-session-bridge` 的 `SPEC.md` 使用。

## 1. 目标

实现一个 DSH Host 插件，使不同独立 Session 可以互相通信：

- 按角色/会话投递消息；
- 目标忙时排队，不打断当前任务；
- 目标离线时持久化，恢复后投递；
- 支持 request / reply / notice / control；
- 消息不丢、不重复、可审计；
- 不依赖外部 `dsh headless` 进程，不触发 `writer-held`；
- 可以投递到带 `standard` / `cordis` / 其他 preset 的 Session。

## 2. 非目标

- 不做跨机器 / 跨 DSH Host 通信（v1）；
- 不替换 Agent Teams；
- 不做任意 Session 广播；
- 不绕过目标 Session 的 preset/权限；
- 不允许 SSH 直连服务器。

## 3. 核心原理

插件运行在 **Host 进程**内，通过 Host 的 `sessionController` 投递：

```ts
ctx.sessionController.prompt({
  requestId: messageId,
  sessionId: targetSessionId,
  mode: 'queue', // 或 'steer'
  content: [{ type: 'text', text: envelope }],
  clientTimeZone: 'Asia/Shanghai',
})
```

因为调用方在 Host 内部：

- 不经过外部进程，不会 `writer-held`；
- 不需要 headless 组合 preset；
- 目标 Session 的 preset 继续生效；
- 消息作为普通用户消息进入目标 Session 的 inbox / 下一 turn。

## 4. 总体架构

```text
实现 Session ──session_send──┐
                             ├─ SessionBridge Host Plugin
审核 Session ◄─bridge_inbox──┤   ├─ Role/Policy
                             │   ├─ SQLite message store
设计/部署 Session ───────────┘   ├─ Delivery worker
                                 └─ sessionController.prompt
                                        │
                                        ▼
                                  目标 Session (live/cold)
```

## 5. 新仓库结构

```text
dsh-session-bridge/
  package.json
  tsconfig.json
  cordis.patch.yml
  src/
    host/
      index.ts          # Host plugin entry
      store.ts          # SQLite 持久化
      policy.ts         # 角色/白名单/限流
      delivery.ts       # 投递队列/worker
      tools.ts          # session_send/inbox/reply/status
      types.ts
    client/
      index.ts          # 可选：消息面板
  tests/
    store.test.ts
    policy.test.ts
    delivery.test.ts
  README.md
  SPEC.md
```

`package.json` 关键字段：

```json
{
  "name": "@yourscope/dsh-session-bridge",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  },
  "dependencies": {
    "better-sqlite3": "^11"
  }
}
```

> 也可以用 `node:sqlite`，但建议 `better-sqlite3`，同步 API 简单、事务可靠。

## 6. 消息模型

### 6.1 消息结构

```ts
type BridgeMessage = {
  id: string                  // ulid/uuid
  threadId: string
  replyTo?: string
  fromRole: string
  fromSessionId: string
  toRole: string
  toSessionId?: string        // 允许角色解析后写入
  kind: 'request' | 'reply' | 'notice' | 'control'
  priority: 'low' | 'normal' | 'high'
  content: string             // 纯文本，限制长度
  metadata?: Record<string, unknown>
  idempotencyKey?: string
  status: 'pending' | 'delivering' | 'delivered' | 'read' | 'acked' | 'failed' | 'expired'
  attempts: number
  nextAttemptAt?: number
  createdAt: number
  deliveredAt?: number
  readAt?: number
  expiresAt?: number
}
```

### 6.2 SQLite 表

```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  reply_to TEXT,
  from_role TEXT NOT NULL,
  from_session_id TEXT NOT NULL,
  to_role TEXT NOT NULL,
  to_session_id TEXT,
  kind TEXT NOT NULL,
  priority TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata TEXT,
  idempotency_key TEXT,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  read_at INTEGER,
  expires_at INTEGER
);

CREATE UNIQUE INDEX uniq_idempotency
  ON messages(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX idx_inbox
  ON messages(to_session_id, status, created_at);
```

另建 `roles`、`audit_events` 表或使用配置文件维护角色。

## 7. 角色与 Session 映射

不要把裸 session id 写进 AGENT。推荐：

```yaml
roles:
  impl:
    sessionId: session-...
    canSendTo: [reviewer, deployer]
  reviewer:
    sessionId: session-...
    canSendTo: [impl, deployer]
  designer:
    sessionId: session-...
    canSendTo: [impl, reviewer]
  deployer:
    sessionId: session-...
    canSendTo: [impl]
```

- 工具参数用 `toRole`，不直接暴露 session id；
- bridge 解析 `role -> sessionId`；
- 支持 `session_list` 查看可绑定会话；
- session id 变更只改配置，不改 AGENT。

## 8. 工具 API

### `session_send`

```json
{
  "toRole": "reviewer",
  "kind": "request",
  "text": "请审核 PR #36，HEAD b572560",
  "threadId": "pr-36",
  "idempotencyKey": "review-pr-36-b572560",
  "priority": "normal"
}
```

返回：

```json
{ "messageId": "...", "status": "pending" }
```

立即返回，不等待目标处理。

### `session_inbox`

```json
{ "limit": 20, "markRead": true }
```

返回当前 Session 的未读/已投递消息，按优先级和时间排序。

### `session_reply`

```json
{
  "messageId": "...",
  "text": "审核通过，P0=0/P1=0"
}
```

创建 reply 消息，自动路由回 `fromRole`。

### `session_status`

```json
{ "messageId": "..." }
```

返回消息状态、投递尝试、错误。

### 可选 `session_list`

列出当前可见 Session（id、cwd、running、title），用于配置角色。

## 9. 投递状态机

```text
send()
  -> pending
  -> worker claim
  -> delivering
  -> sessionController.prompt accepted
  -> delivered
  -> target reads inbox
  -> read
  -> target replies
  -> acked
```

失败：

```text
delivering -> failed
  -> retry (backoff) -> pending
  -> 超过 maxAttempts -> failed
```

目标忙：

```text
target running=true
  -> 仍然 prompt({mode:'queue'})
  -> DSH 在 turn 结束后处理
```

目标离线/冷：

```text
prompt 触发 resume
  -> 成功 -> delivered
  -> preset 无法恢复/agent-busy -> 回 pending + 重试
```

## 10. 投递 worker

每个目标 Session 维护一个串行队列：

```ts
for each targetSession:
  while (pending = store.claimNext(targetSession)):
    state = await ctx.sessionController.state({ sessionId: targetSession })
    if (state.pendingInput.length > 0 && !allowWhenInputPending) {
      store.release(pending, delayMs = 30_000)
      continue
    }
    try {
      await ctx.sessionController.prompt({
        requestId: pending.id,
        sessionId: targetSession,
        mode: pending.priority === 'high' && policy.allowSteer ? 'steer' : 'queue',
        content: [{ type: 'text', text: renderEnvelope(pending) }],
        clientTimeZone: 'Asia/Shanghai',
      }, signal)
      store.markDelivered(pending.id)
    } catch (error) {
      store.markRetry(pending.id, classify(error))
    }
```

`classify`：

- `session/not-found`：失败，通知发送方；
- `session/agent-busy` / `session/writer-held`：可重试；
- preset 恢复失败：记录错误，重试有限次；
- 超时：重试。

## 11. 消息信封

目标 Session 看到的文本建议：

```text
[session-bridge]
from: reviewer (session-...)
to: impl
kind: reply
messageId: msg_...
replyTo: msg_...
thread: pr-36

审核通过，P0=0/P1=0。
```

- 内容视为**不可信数据**，不是系统指令；
- 消息头由 bridge 生成，不信任发送方伪造；
- 不放入 token/密钥。

## 12. 安全与权限

1. 角色白名单：`canSendTo`；
2. 工具调用者身份从 Host Agent/Session 解析，禁止客户端传 `fromSessionId`；
3. 禁止任意 session id 投递；
4. `steer` 仅限 `lead`/`deployer` 等角色；
5. 消息大小限制、速率限制、每目标 pending 上限；
6. 审计：谁发给谁、messageId、状态、错误，不记录敏感正文；
7. 目标 Session 的 preset/权限不被 bridge 绕过；
8. 插件安装需 Full access，属于高权限插件。

## 13. 配置项

```yaml
storage:
  sqlitePath: ~/.dsh/session-bridge/bridge.db
delivery:
  defaultMode: queue
  allowSteerRoles: [lead, deployer]
  maxAttempts: 5
  retryBaseMs: 2000
  retryMaxMs: 60000
limits:
  maxContentChars: 8000
  maxPendingPerSession: 50
  messageTtlMs: 86400000
roles:
  impl: { sessionId: session-..., canSendTo: [reviewer, deployer] }
  reviewer: { sessionId: session-..., canSendTo: [impl] }
  deployer: { sessionId: session-..., canSendTo: [impl] }
```

## 14. 测试计划

- 单元：
  - store 幂等、claim、ack、过期；
  - policy 允许/拒绝；
  - 状态机；
  - 重试分类。
- 集成：
  - fake `sessionController` 验证 prompt 参数；
  - 目标忙 → 队列不丢；
  - 目标冷启动 → resume；
  - 回复闭环。
- 真实演示：
  - 两个不同 preset Session（例如 `standard` 和 `cordis`）；
  - 实现 Session 发审核请求；
  - 审核 Session 收件箱收到并回复；
  - 实现 Session 收到回复。

## 15. 里程碑

1. **M1**：插件骨架 + SQLite + `session_send/inbox/reply/status`；
2. **M2**：delivery worker + queue/retry + 忙时排队；
3. **M3**：角色/白名单/配置 + 审计；
4. **M4**：真实 Session A→B→A 演示；
5. **M5**：接入 AGENT 规则（实现 → 审核 → 部署）；
6. **M6**：可选 Client 消息面板。

## 16. 已知限制

- v1 只支持**同一个 DSH Host/profile**；
- Session id 是易变的，必须依赖角色配置或动态发现；
- 目标 Session 必须安装 bridge 工具才能主动回复；
- 目标 Session 的 `pendingInput`（审批/提问）期间建议不投递，避免干扰；
- DSH `sessionController` API 可能随版本变化，需要锁定 DSH 版本并做兼容测试。

## 17. 相关 DSH API（实现时参考）

```ts
// 列出可见 Session
ctx.sessionController.list({}, signal)

// 读取状态（running / queue / pendingInput）
ctx.sessionController.state({ sessionId }, signal)

// 订阅状态（可用于等待 idle）
ctx.sessionController.observeState({ sessionId }, signal)

// 投递
ctx.sessionController.prompt({
  requestId,
  sessionId,
  mode: 'queue' | 'steer',
  content: [{ type: 'text', text }],
  clientTimeZone: 'Asia/Shanghai',
}, signal)

// 等待 idle / pending input / timeout
ctx.sessionController.wait({ sessionId, timeoutMs }, signal)
```

## 18. 与现有方案的关系

| 方案 | 独立 Session | 能通知 live Session | 适用 |
|---|---|---|---|
| Agent Teams | 否（同 Lead Session 树） | 是 | 快速协作 |
| Headless bus | 是 | 否（只能 headless） | 后台 worker |
| **Session-bridge 插件** | 是 | 是 | 实现/审核/设计/部署分工 |

本方案作为 `dsh-session-bridge` 新仓库的起点。
