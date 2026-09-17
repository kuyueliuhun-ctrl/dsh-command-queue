# Changelog

## v0.1.0 — 2026-09-18

首个版本：让 `/compact` 这类**斜杠命令**在 agent 忙碌时不再立刻报错，
而是进入按 agent 串行的命令队列，等 agent 空闲后自动执行。

### 背景

DSH 里普通消息与斜杠命令走两条完全不同的通道：

| | 普通消息 | 斜杠命令 |
|---|---|---|
| 客户端 | `session.prompt({ mode })` | `remote.commands.execute()` |
| host 落点 | `agent.followup()` / `agent.steer()` → agent **inbox** | `ctx.commands.execute()` → 直接调 handler |
| 忙碌时 | **天然排队** | **立即执行**，无排队语义 |

`/compact` 的 handler 调 `compactNow()` → `agent.runMaintenance()`，后者的同步
gate 是 `if (this.phase.kind !== 'idle') throw`，被包成
`ManualCompactionError('busy')`。所以 agent 忙碌时敲 `/compact` 只会立刻收到
"Compaction is unavailable because this process has an active compaction, or the
agent is not idle."——既没排队，也没有任何重试。

> DSH 作者把「命令自己进队列」当作有意排除的方案记录在案
> （Agent Note: *"Queue the command itself. Rejected."*），因此官方没有开关。
> 本插件在**不改 DSH 源码**的前提下补上这一段。

### 新增

- 包装 host 侧 `ctx.commands.execute()`：合法 + 已注册 + 未豁免 + agent 正忙的
  调用进入该 agent 的 FIFO 队列，等 `agent/status → idle` 后按原顺序执行。
- 命令仍由原注册表解析，`command/run` + `command/done` 生命周期日志仍由
  `CommandRuntime` 写入，只是执行时机推迟到空闲窗口。
- 新增只读命令 `/cmdqueue`，查看当前 agent 还排着哪些命令。
- 可选配置：`verbose`、`pollIntervalMs`、`immediateCommands`、
  `alwaysImmediateCommands`。

### 安全边界

- 非命令语法 / 注册表解析不到 / 控制动词（`stop`、`cancel`、`abort`、`interrupt`、
  `halt`）/ agent 已空闲 —— 一律照旧立即执行，零回归；
- 排队逻辑自身抛错时回落原行为，**绝不吞掉用户命令**；
- 按 agent 隔离，一个 agent 空闲不会放行另一个在队的命令；
- 严格 FIFO 串行，多个 `/compact` 不会挤进同一个空闲窗口；
- 可随 UI 请求的 `signal` 取消（浏览器断连是唯一实际取消源）；
- 插件卸载时唤醒所有等待者，已排队命令立刻按原顺序执行完，不留悬挂 RPC。

### 两个踩过的实现坑

1. `ctx.commands` 是 cordis 的 **traceable Proxy**，get trap 对函数值每次返回新的
   shadow method，所以 `service.execute === patched` 这种身份比较**恒为 false**
   （用它做还原守卫会导致补丁永远摘不掉）。改为经
   `Symbol.for('cordis.original')` 取 raw 实例，用
   `Object.getOwnPropertyDescriptor` 记录原状、精确 patch、精确还原。
2. `AgentLoop.kick()` 的 finally 是「`setPhase(idle)` **同步** emit
   `agent/status` → `wakeDriver()`」。任何跨 promise 边界后再调用都会撞回
   running，`compactNow` 仍是 busy。因此把「检查 `agent.status === 'idle'`」和
   「调用 `run()`」放在**同一个同步块**内，中间绝不 `await`。

### 验证

- 单元测试：`node --test tests/*.test.mjs` → **17/17 通过**
  （含 traceable Proxy 的 patch 与精确还原两个回归用例）。
- 真实端到端（插件注入运行中的 host，经 typert gateway HTTP 直连）：

  ```
  T1  line="hello"      → 200 {"ok":true}      0.002s   ✅ 通路正常、非命令不排队
  T2  line="/cmdqueue"  → 8s 无响应（curl 28）          ✅ 命令在 agent running 时被挂起排队
  ```

### 兼容性

针对运行中的 `@deepseek-ai/dsh@0.1.6-alpha.1` 实现，依据其编译产物逐行核对。
不依赖任何 DSH 内部私有结构，只用公开面：`ctx.commands.execute/find/register`、
`agent.status`、`agent.ctx.on('agent/status')`。
