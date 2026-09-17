/**
 * dsh-command-queue 单元测试：用假的 ctx / commands 服务 / agent 驱动队列逻辑，
 * 不需要跑真的 DSH host。
 *
 * 运行：node --test tests/*.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply, inject, name } from '../lib/index.js'

/** 冲掉若干微任务/宏任务，让队列链推进到"已挂上等待"。 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * 构造一个最小的 host ctx 替身。
 * @param options.findNames - 命令注册表里"已注册"的命令名。
 * @returns 测试夹具。
 */
function createHarness(options = {}) {
  const findNames = options.findNames ?? ['compact', 'export', 'stop']
  const calls = []
  const logs = []
  const definitions = new Map()
  for (const entry of findNames) {
    definitions.set(entry, { name: entry, description: entry, handler: () => ({ kind: 'success' }) })
  }

  // execute 必须定义在**原型**上，与真实的 CommandRuntime 一致：
  // 这样才测得出「patch 落到实例自有属性 / 卸载时 delete 回原型方法」。
  const prototype = {
    async execute(agent, line, attachments, signal) {
      calls.push({ line, agent, attachments, signal })
      return { commandId: `c${calls.length}`, result: { kind: 'success', text: `ran ${line}` } }
    },
  }
  const commands = Object.create(prototype)
  commands.find = (_agent, commandName) => definitions.get(commandName)
  commands.register = (definition) => {
    definitions.set(definition.name, definition)
    return () => definitions.delete(definition.name)
  }

  const disposers = []
  const ctx = {
    commands,
    logger: {
      info: (message) => logs.push(message),
      warn: (message) => logs.push(`WARN ${message}`),
    },
    effect(body) {
      disposers.push(body())
      return () => {}
    },
  }

  return {
    ctx,
    commands,
    calls,
    logs,
    definitions,
    /** 逆序执行所有 effect disposer，模拟插件卸载。 */
    disposeAll() {
      for (const disposer of disposers.reverse()) {
        if (typeof disposer === 'function') disposer()
      }
    },
  }
}

/**
 * 构造一个假 agent：status 可变，`ctx.on` 提供 agent/status 事件。
 * @param id - 会话 id。
 * @param status - 初始状态。
 * @param opts.eventsBroken - 为 true 时 `ctx.on` 直接抛错（触发轮询兜底）。
 * @returns 假 agent（额外带 goIdle/goRunning 两个驱动方法）。
 */
function createAgent(id = 's1', status = 'idle', opts = {}) {
  const listeners = new Map()
  const agent = {
    status,
    session: { id },
    ctx: {
      on(event, listener) {
        if (opts.eventsBroken === true) throw new Error('events unavailable')
        if (!listeners.has(event)) listeners.set(event, new Set())
        listeners.get(event).add(listener)
        return () => listeners.get(event)?.delete(listener)
      },
    },
  }
  agent.emit = (next) => {
    agent.status = next
    for (const listener of [...(listeners.get('agent/status') ?? [])]) listener({ agent, status: next })
  }
  agent.goIdle = () => agent.emit('idle')
  agent.goRunning = () => agent.emit('running')
  return agent
}

test('导出契约：name / inject 符合 cordis 插件形态', () => {
  assert.equal(name, 'command-queue')
  assert.deepEqual(inject, ['commands'])
})

test('agent 空闲：命令立即执行，不进队列', async () => {
  const harness = createHarness()
  apply(harness.ctx, {})
  const agent = createAgent('s1', 'idle')

  const outcome = await harness.commands.execute(agent, '/compact', [], new AbortController().signal)

  assert.equal(harness.calls.length, 1)
  assert.equal(outcome.result.kind, 'success')
})

test('agent 忙碌：命令被挂起，空闲后自动执行一次', async () => {
  const harness = createHarness()
  apply(harness.ctx, {})
  const agent = createAgent('s1', 'running')

  const pending = harness.commands.execute(agent, '/compact', [], new AbortController().signal)
  await flush()

  assert.equal(harness.calls.length, 0, '忙碌时不应执行')

  agent.goIdle()
  const outcome = await pending

  assert.equal(harness.calls.length, 1, '空闲后应执行')
  assert.equal(harness.calls[0].line, '/compact')
  assert.equal(outcome.result.kind, 'success')
})

test('多个命令按 FIFO 串行，不并发抢占同一个空闲窗口', async () => {
  const harness = createHarness()
  apply(harness.ctx, {})
  const agent = createAgent('s1', 'running')

  const first = harness.commands.execute(agent, '/compact', [], new AbortController().signal)
  const second = harness.commands.execute(agent, '/export', [], new AbortController().signal)
  await flush()
  assert.equal(harness.calls.length, 0)

  agent.goIdle()
  await Promise.all([first, second])

  assert.deepEqual(
    harness.calls.map((call) => call.line),
    ['/compact', '/export'],
    '应按提交顺序执行',
  )
})

test('排队期间请求被取消：返回 error 且不执行命令', async () => {
  const harness = createHarness()
  apply(harness.ctx, {})
  const agent = createAgent('s1', 'running')
  const controller = new AbortController()

  const pending = harness.commands.execute(agent, '/compact', [], controller.signal)
  await flush()
  controller.abort()

  const outcome = await pending
  assert.equal(outcome.kind, 'error')
  assert.match(outcome.text, /cancelled/)
  assert.equal(harness.calls.length, 0)
})

test('未注册的命令名：照旧立即执行（回落原行为，不误排队）', async () => {
  const harness = createHarness()
  apply(harness.ctx, {})
  const agent = createAgent('s1', 'running')

  await harness.commands.execute(agent, '/nope', [], new AbortController().signal)

  assert.equal(harness.calls.length, 1)
})

test('非命令行：照旧立即执行', async () => {
  const harness = createHarness()
  apply(harness.ctx, {})
  const agent = createAgent('s1', 'running')
  const signal = new AbortController().signal

  await harness.commands.execute(agent, 'hello world', [], signal)
  await harness.commands.execute(agent, '/Compact', [], signal) // 大写不合命令语法
  await harness.commands.execute(agent, '/', [], signal)

  assert.equal(harness.calls.length, 3, '三条都不应被排队')
})

test('立即执行白名单：/stop 在忙碌时也不排队', async () => {
  const harness = createHarness()
  apply(harness.ctx, {})
  const agent = createAgent('s1', 'running')

  await harness.commands.execute(agent, '/stop', [], new AbortController().signal)

  assert.equal(harness.calls.length, 1)
})

test('白名单可配置：immediateCommands 整体替换 + alwaysImmediateCommands 追加', async () => {
  const harness = createHarness({ findNames: ['compact', 'export', 'stop'] })
  apply(harness.ctx, { immediateCommands: ['export'], alwaysImmediateCommands: ['stop'] })
  const agent = createAgent('s1', 'running')
  const signal = new AbortController().signal

  const exportCall = harness.commands.execute(agent, '/export', [], signal)
  await harness.commands.execute(agent, '/stop', [], signal)
  const compactCall = harness.commands.execute(agent, '/compact', [], signal)
  await flush()

  assert.equal(harness.calls.length, 2, '只应立刻执行 /export 与 /stop')
  assert.deepEqual(harness.calls.map((call) => call.line), ['/export', '/stop'])

  agent.goIdle()
  await compactCall
  assert.equal(harness.calls.length, 3)
  await exportCall
})

test('轮询兜底：agent/status 事件不可用时仍能在空闲后执行', async () => {
  const harness = createHarness()
  apply(harness.ctx, { pollIntervalMs: 50 })
  const agent = createAgent('s1', 'running', { eventsBroken: true })

  const pending = harness.commands.execute(agent, '/compact', [], new AbortController().signal)
  await flush()
  assert.equal(harness.calls.length, 0)

  agent.status = 'idle' // 不发事件，只能靠轮询发现
  const outcome = await pending

  assert.equal(harness.calls.length, 1)
  assert.equal(outcome.result.kind, 'success')
})

test('多 agent 相互隔离：一个 agent 空闲不会放行另一个的在队命令', async () => {
  const harness = createHarness()
  apply(harness.ctx, {})
  const firstAgent = createAgent('a', 'running')
  const secondAgent = createAgent('b', 'running')
  const signal = new AbortController().signal

  const firstCall = harness.commands.execute(firstAgent, '/compact', [], signal)
  const secondCall = harness.commands.execute(secondAgent, '/export', [], signal)
  await flush()

  firstAgent.goIdle()
  await firstCall
  assert.deepEqual(harness.calls.map((call) => call.line), ['/compact'])

  secondAgent.goIdle()
  await secondCall
  assert.deepEqual(harness.calls.map((call) => call.line), ['/compact', '/export'])
})

test('卸载：还原 execute，并让在队命令立刻执行完而不是丢弃', async () => {
  const harness = createHarness()
  apply(harness.ctx, {})
  const agent = createAgent('s1', 'running')

  const pending = harness.commands.execute(agent, '/compact', [], new AbortController().signal)
  await flush()
  assert.equal(harness.calls.length, 0)

  harness.disposeAll()
  const outcome = await pending

  assert.equal(harness.calls.length, 1, '卸载不应丢掉已排队的命令')
  assert.equal(outcome.result.kind, 'success')

  // 还原后：忙碌也不再排队，直接执行原方法
  await harness.commands.execute(agent, '/compact', [], new AbortController().signal)
  assert.equal(harness.calls.length, 2)
})

test('/cmdqueue 报告当前排队的命令', async () => {
  const harness = createHarness()
  apply(harness.ctx, {})
  const agent = createAgent('s1', 'running')

  const definition = harness.definitions.get('cmdqueue')
  assert.ok(definition, '/cmdqueue 应已注册')
  const invocation = { agent, rawInput: '', signal: new AbortController().signal, attachments: [] }

  assert.match(definition.handler(invocation).text, /No queued commands/)

  const pending = harness.commands.execute(agent, '/compact', [], new AbortController().signal)
  await flush()
  assert.match(definition.handler(invocation).text, /\/compact/)

  agent.goIdle()
  await pending
  assert.match(definition.handler(invocation).text, /No queued commands/)
})

test('排队逻辑自身异常时回落为立即执行（绝不吞掉命令）', async () => {
  const harness = createHarness()
  apply(harness.ctx, {})
  const agent = createAgent('s1', 'running')

  // find 抛错 → patched 内部的 try/catch 应回落成 run()
  harness.definitions.clear()
  harness.ctx.commands.find = () => {
    throw new Error('registry exploded')
  }

  await harness.commands.execute(agent, '/compact', [], new AbortController().signal)

  assert.equal(harness.calls.length, 1)
  assert.ok(harness.logs.some((line) => line.includes('WARN')))
})

test('verbose 打开时输出排队/执行日志', async () => {
  const harness = createHarness()
  apply(harness.ctx, { verbose: true })
  const agent = createAgent('s1', 'running')

  const pending = harness.commands.execute(agent, '/compact', [], new AbortController().signal)
  await flush()
  agent.goIdle()
  await pending

  assert.ok(harness.logs.some((line) => line.includes('wrapped ctx.commands.execute')))
  assert.ok(harness.logs.some((line) => line.includes('queued /compact')))
  assert.ok(harness.logs.some((line) => line.includes('running queued /compact')))
})

test('traceable Proxy：patch 落在 raw 实例上，还原用原描述符精确恢复', async () => {
  const harness = createHarness()
  const raw = harness.commands
  const original = raw.execute

  // 复刻 cordis traceable Proxy：get 对函数返回一层新包装（身份比较恒 false）
  const proxy = new Proxy(raw, {
    get(target, key, receiver) {
      if (key === Symbol.for('cordis.original')) return target
      const value = Reflect.get(target, key, receiver)
      if (typeof value !== 'function') return value
      return function shadow(...args) {
        return value.apply(target, args)
      }
    },
    set(target, key, value) {
      return Reflect.set(target, key, value)
    },
  })
  harness.ctx.commands = proxy

  apply(harness.ctx, {})
  const agent = createAgent('s1', 'running')

  // patch 必须真的落到 raw 上（patch 前 raw 没有自有 execute）
  assert.ok(Object.hasOwn(raw, 'execute'), 'raw 实例上应出现自有 execute')

  const pending = proxy.execute(agent, '/compact', [], new AbortController().signal)
  await flush()
  assert.equal(harness.calls.length, 0, '经 Proxy 调用也要被拦住')

  agent.goIdle()
  await pending
  assert.equal(harness.calls.length, 1)

  harness.disposeAll()
  assert.ok(!Object.hasOwn(raw, 'execute'), '原无自有属性 → 还原为原型方法')
  assert.equal(raw.execute, original)
})

test('traceable Proxy：已有他人 patch 时按原描述符还原，不破坏上游包装', async () => {
  const harness = createHarness()
  const raw = harness.commands

  // 模拟"上游插件已经先 patch 过一次"
  const upstream = async function upstreamExecute() {
    return { commandId: 'upstream', result: { kind: 'success', text: 'upstream' } }
  }
  Object.defineProperty(raw, 'execute', {
    value: upstream,
    writable: true,
    enumerable: false,
    configurable: true,
  })

  apply(harness.ctx, {})
  assert.notEqual(raw.execute, upstream, '我们的 patch 应生效')

  harness.disposeAll()
  assert.equal(raw.execute, upstream, '卸载后应还原成上游那层包装')
})
