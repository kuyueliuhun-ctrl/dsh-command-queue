# dsh-command-queue

让 `/compact` 这类**斜杠命令**在 agent 忙碌时不再立刻报错，而是进入按 agent 串行的
命令队列，等 agent 回到 idle 后自动执行。

不改 DSH 源码，不用猴子补丁之外的任何侵入手段；插件卸载即完全还原。

---

## 1. 它解决的问题

DSH 有两条**完全不同**的输入通道：

| | 普通消息 | 斜杠命令 |
|---|---|---|
| 客户端 | `session.prompt({ mode })` | `remote.commands.execute()` |
| host 落点 | `agent.followup()` / `agent.steer()` → agent **inbox** | `ctx.commands.execute()` → 直接调 handler |
| 忙碌时 | **天然排队**（`next-turn` / `next-step`），回合结束再消费 | **立即执行**，没有任何排队语义 |

`/compact` 的 handler 调 `ctx.compaction.compactNow()` → `agent.runMaintenance()`，
而 `runMaintenance` 在 agent 非 idle 时**同步抛** `ManualCompactionError('busy')`。
于是 agent 正在跑的时候敲 `/compact`，只会立刻收到：

```
Compaction is unavailable because this process has an active compaction,
or the agent is not idle.
```

既没有排队，也没有重试。DSH 作者把「命令自己进队列」当作有意排除的方案记录在案
（Agent Note: *"Queue the command itself. Rejected."*），所以官方没有开关——
这正是本插件补上的那一段。

---

## 2. 做法

在 host 侧包装 `ctx.commands.execute()`：

```
浏览器 ──POST commands/execute──▶ typert gateway
                                     │  Reflect.get(receiver, 'execute')   ← 每次调用动态取方法
                                     ▼
                            ┌─ patched execute ─┐
                            │  合法命令？        │
                            │  注册表能解析到？  │
                            │  不在立即白名单？  │
                            │  agent 正忙？      │
                            └────────┬──────────┘
                              是 ────┴────▶ 该 agent 的 FIFO 队列
                                             │  等 agent/status → idle
                                             ▼
                                      original.execute(...)  ← 原方法：原注册表解析、原生命周期日志
```

**为什么包装实例方法有效**：typert gateway 在 `prepareInvocation()` 里
每次调用都执行 `Reflect.get(receiver, descriptor.implementation ?? descriptor.method)`；
而 `commands/execute` 的 strict descriptor 只声明 `method: 'execute'`（不含方法引用）。
所以在服务实例上给 `execute` 赋一个新函数会被后续所有请求采纳，
`agentId` 参数解析、参数校验、结果 schema 全部不变。

命令仍由**原注册表**解析（`ctx.commands.find()` / 层遮蔽规则都不动），
`command/run` + `command/done` 生命周期日志仍由 `CommandRuntime` 自己写，
只是执行时机被推迟到空闲窗口。

---

## 3. 行为契约：什么时候**不**排队

以下情况一律保持原行为（立即执行），保证零回归：

- **不是合法命令语法** —— 第 0 字节不是 `/`、名称含大写或非法字符（如 `/Compact`）、只有 `/`；
- **命令名在注册表里解析不到** —— `ctx.commands.find(agent, name)` 返回 `undefined`
  （客户端本来就会按「未命中」处理，没必要拖到空闲后）；
- **命令名在立即执行白名单里** —— 默认 `stop` / `cancel` / `abort` / `interrupt` / `halt`，
  这些控制动词排队会失去意义，甚至危险（忙碌时敲 `/stop` 本该立刻中断）；
- **agent 当前就是 idle**；
- **排队逻辑自身抛错** —— 兜底回落成原行为，绝不吞掉用户命令。

只有「合法 + 已注册 + 未豁免 + agent 正忙」才入队。

其它保证：

- **按 agent 隔离** —— 一个 agent 空闲不会放行另一个 agent 在队的命令；
- **严格 FIFO 串行** —— 同一 agent 内第 N 个命令只在第 N-1 个 settle 之后才去等空闲，
  多个 `/compact` 不会挤进同一个空闲窗口；
- **可取消** —— UI 请求的 `signal` 中止时，命令返回
  `{ kind: 'error', text: '/xxx was cancelled before it could run.' }` 且**不会执行**；
- **卸载不丢命令** —— 插件卸载时唤醒所有等待者，已排队的命令立刻按原顺序执行完。

---

## 4. 安装

本插件是**手写 ESM JavaScript**，没有编译步骤；`lib/index.js` 就是源码，`npm run build`
只做语法校验 + 跑测试。

仓库：<https://github.com/kuyueliuhun-ctrl/dsh-command-queue>

### 方式 A：从 GitHub 装配进 profile（推荐，重启后仍在）

```bash
cd "$DSH_HOME/profiles/<profile>"          # 例如 ~/.dsh/profiles/web
npm install github:kuyueliuhun-ctrl/dsh-command-queue
```

然后把包名加进该 profile `package.json` 的 `dsh.profile.bundles` 数组：

```json
{ "dsh": { "profile": { "bundles": ["dsh-command-queue"] } } }
```

本包自带 `cordis.patch.yml`，bundle 层会把 `command-queue` 这一行插进 loader，
无需手写 patch 条目（要配置时再按 §5 加）。

### 方式 B：本地目录装配（开发）

```bash
npm install "file:/path/to/dsh-command-queue"
```

用了 dsh-super-injector 的话：

```bash
dev_install_package { "dir": "/path/to/dsh-command-queue", "profile": "web" }
```

### 方式 C：运行时注入（免重启，临时验证）

```bash
dev_inject_plugin   { "dir": "/path/to/dsh-command-queue" }
dev_plugin_status   {}
```

### 卸载

```bash
dev_uninject_plugin { "match": "dsh-command-queue" }
# 非注入器环境：从 dsh.profile.bundles 移除该名字，再删除 node_modules 里的包
```

---

## 5. 配置

无 schema，容错读取，全部可选。写在 profile 的 `cordis.patch.yml` 里对应条目下：

```yaml
- id: command-queue
  name: 'dsh-command-queue'
  config:
    verbose: true                    # 打开排队/执行日志（默认 false）
    pollIntervalMs: 250              # 轮询兜底间隔，50–5000（默认 250）
    immediateCommands:               # 整体替换默认白名单
      - stop
      - cancel
      - abort
    alwaysImmediateCommands:         # 在（默认或自定义的）白名单上追加
      - my-control-command
```

---

## 6. `/cmdqueue`

插件注册了一个只读命令，用来查看当前 agent 还排着哪些命令：

```
/cmdqueue
→ 2 command(s) queued for this agent, waiting for it to become idle: /compact, /export
→ No queued commands for this agent.
```

（注册在 global 层，与 agent preset 里的 `/compact` 不同名，不会冲突。）

---

## 7. 测试

```bash
npm test         # node --test tests/*.test.mjs
npm run check    # node --check lib/index.js
npm run build    # 语法校验 + 跑测试
```

`tests/queue.test.mjs` 用假的 ctx / commands 服务 / agent 驱动全部队列逻辑，
覆盖：立即放行（未空闲 / 未注册 / 非命令 / 白名单）、忙碌挂起后执行、
FIFO 串行、多 agent 隔离、取消、卸载不丢命令、轮询兜底、异常回落、`/cmdqueue` 输出。

---

## 8. 你会看到什么（实测的运行时行为）

这些结论来自对运行中 `@deepseek-ai/dsh@0.1.6-alpha.1` 客户端/host 代码的逐行核对。

**提交 `/compact`（agent 正在跑）时：**

1. 命令**被挂起排队**，输入框**不会冻结**——因为 `/compact` 没有 `input` 描述符，
   客户端走 `runDetached`（fire-and-forget）路径，本来就不等 RPC 返回。
   你可以继续打字、继续排消息。
2. **这段时间没有任何「已排队」提示**。原因是 UI 的「执行中…」扫光卡片由会话事件
   `command/run` 驱动，而该事件由 `CommandRuntime.execute` 在**调用 handler 之前**
   写入——我们在它之前就挂住了，所以此刻没有任何持久卡片可渲染。
   （客户端里确实定义了脉冲指示器 `.pending` 与 `data-phase=submitting` 样式，
   但编译产物中没有任何地方引用它们，属于死 CSS，不会出现。）
3. **回合结束后**，命令真正执行，此时 `command/run` + `command/done` 落盘并流回
   浏览器，transcript 里出现正常的命令卡片：先「执行中…」，再「已完成」+
   真实结果文案（例如 `Compacted 12 history items (~3456 tokens).`），失败则红色「指令失败」。
4. 想随时查看队列，敲 **`/cmdqueue`**。

**取消语义（重要）**：

- **只有浏览器断开**（刷新 / 关页）会 abort 这次 RPC——服务端 `res.on('close')` → `AbortController`。
  此时插件返回 `{ kind:'error', text:'/xxx was cancelled before it could run.' }`，命令**不会执行**。
- 点「停止」按钮走的是另一条 RPC（`session/cancel` → `agent.cancel`），**不会**取消命令。
  也就是说：排队期间点停止只会中断当前回合，排队中的 `/compact` 会在回合结束后照常执行。
- 切换会话**不会**取消；结果仍会回到该会话自己的 transcript。

**其它**：

- **无 RPC 超时**：宿主 webserver / `/api` bridge / typert gateway / 浏览器 fetch 全链路
  都没有 per-request deadline（唯一的 `requestTimeout=300s` 是 Node 默认值，只作用于
  「收完请求」阶段，实测不会杀掉 pending 响应）。所以挂住几分钟是安全的。
- **无幂等键**：`commands/execute` 的参数只有 `agentId / line / submittedAttachments`，
  没有 requestId。手动重发同一行命令会真的执行两次——插件不做去重。
- **依赖 `agent.status`**（`AgentStatus = 'idle' | 'running'`）。状态不可读时按
  「忙碌」处理（宁可排队，不可抢跑）。
- **`idle` 不蕴含「能跑维护任务」**：`phase.kind === 'maintenance'` 期间 `status`
  仍是 `idle` 且不发事件，此时若有另一个 maintenance 占用 agent，`compactNow` 仍会
  报 `busy`。这种情况插件不掩盖，按原样返回该报错。
- 只对**命令**生效。普通消息的排队是 DSH 内建行为，本插件不介入。

---

## 9. 验证记录

**单元测试**：`node --test tests/*.test.mjs` → 17/17 通过（含 traceable Proxy 的
patch/还原两个回归用例）。

**真实端到端**（插件注入运行中的 host 后，经 typert gateway 用 HTTP 直连验证）：

```
# T1 非命令行：证明网关通路正常、且非命令不被排队
POST /api/commands/execute  {"agentId":"session-…","line":"hello",…}
→ 200 {"ok":true}                                        耗时 0.002s   ✅

# T2 已注册命令 + agent 正在 running：证明命令被排队挂起
POST /api/commands/execute  {"agentId":"session-…","line":"/cmdqueue",…}
→ curl exit 28（8s 无响应，被挂起排队）                               ✅
```

T1 与 T2 的对比同时证明了：补丁确实落在 gateway 的调用路径上（否则 `/cmdqueue`
会立刻返回），且排队判定确实基于 agent 忙闲。

---

## 10. 出处

实现依据（运行中的 `@deepseek-ai/dsh@0.1.6-alpha.1`，路径为
`/root/deepseek-harness-016/node_modules/@deepseek-ai/`）：

- `dsh-commands/lib/index.js:327` —— `async execute(agent, line, submittedAttachments, signal)`（原型方法，可包装）
- `dsh-commands/lib/types/index.d.ts:80-158` —— `register()` / `list()` / `find()` / `execute()` 公开契约
- `dsh-commands/lib/typert.host.js:45-48` —— strict descriptor 只声明 `method: 'execute'`
- `dsh-api-gateway/lib/index.js:747-749` —— `Reflect.get(receiver, implementation)` 每次调用动态取方法
- `dsh-api-gateway/lib/index.js:828` —— `implementation` 是方法**名**而非方法引用
- `dsh-command-compact/lib/index.js:49-73` —— `/compact` handler 与 busy 文案
- `dsh-compaction/lib/types/index.d.ts:131` —— `compactNow(agent, signal, sourceCommandId)`
- `dsh-agent/lib/types/runtime-types.d.ts:90,147,149,252` —— `AgentStatus` / `agent.status` / `agent.ctx` / `agent/status` 事件
