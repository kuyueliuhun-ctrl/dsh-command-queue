/**
 * dsh-command-queue 浏览器半边（lib/client.js）的冒烟测试。
 *
 * 这道测试很关键：DSH 的 boot 审计**没有 per-plugin 隔离** —— 客户端 bundle
 * 抛错会让整个 Web 应用无法 mount。所以这里用一个最小 React 运行时 +
 * 假 `window.__ModuleLoader__` 把 bundle 真正加载起来并渲染，验证：
 *   1. bundle 形态正确（`load({id, factory})`，id = 包名）；
 *   2. factory 导出 `name` / `inject` / `apply`，且**没有 default**；
 *   3. `apply` 会在 `conversation.input.dock` 上注册自己的条目（id/order 正确）；
 *   4. `apply` 在槽位服务抛错时**自吞异常**（不让 boot 失败）；
 *   5. 组件真的能渲染：空队列返回 null，有队列时渲染出命令行，并可经 drop 路由移除；
 *   6. host 路由不可用时静默降级。
 *
 * 运行：node --test tests/*.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

//#region 最小 React 运行时 + 挂载器

/** 当前正在渲染的组件实例（供 hook 读取）。 */
let currentInstance = null

const React = {
  Fragment: Symbol('Fragment'),
  createElement(type, props, ...children) {
    return {
      type,
      props: props ?? {},
      children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
    }
  },
  useId() {
    return 'dshcq-test-id'
  },
  useState(initial) {
    const instance = currentInstance
    const index = instance.cursor++
    if (instance.hooks.length <= index) {
      instance.hooks[index] = { kind: 'state', value: typeof initial === 'function' ? initial() : initial }
    }
    const slot = instance.hooks[index]
    const setState = (next) => {
      const value = typeof next === 'function' ? next(slot.value) : next
      if (value !== slot.value) {
        slot.value = value
        instance.dirty = true
      }
    }
    return [slot.value, setState]
  },
  useEffect(effect, deps) {
    const instance = currentInstance
    const index = instance.cursor++
    const previous = instance.hooks[index]
    const changed =
      previous === undefined ||
      previous.kind !== 'effect' ||
      deps === undefined ||
      deps.length !== previous.deps.length ||
      deps.some((value, i) => value !== previous.deps[i])
    if (changed) {
      instance.pendingEffects.push({ index, effect, deps })
      instance.hooks[index] = { kind: 'effect', deps, cleanup: previous?.cleanup }
    }
  },
}

/**
 * 挂载一个函数组件。
 * @param Component - 函数组件。
 * @param props - 组件 props。
 * @returns 挂载句柄：`renderOnce()` 重新渲染、`unmount()` 跑全部 effect cleanup。
 */
function mount(Component, props) {
  const instance = { Component, props, hooks: [], pendingEffects: [], cursor: 0, dirty: false }
  const renderOnce = () => {
    currentInstance = instance
    instance.cursor = 0
    instance.pendingEffects = []
    let tree
    try {
      tree = instance.Component(instance.props)
    } finally {
      currentInstance = null
    }
    const effects = instance.pendingEffects
    instance.pendingEffects = []
    for (const entry of effects) {
      const cleanup = entry.effect()
      const slot = instance.hooks[entry.index]
      if (slot !== undefined && typeof cleanup === 'function') slot.cleanup = cleanup
    }
    return tree
  }
  const unmount = () => {
    for (const hook of instance.hooks) {
      if (hook !== undefined && hook.kind === 'effect' && typeof hook.cleanup === 'function') hook.cleanup()
    }
    instance.hooks = []
  }
  return { instance, renderOnce, unmount, tree: renderOnce() }
}

/** 收集元素树里的全部文本。 */
function collectText(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out)
    return out
  }
  if (typeof node === 'object' && Array.isArray(node.children)) {
    for (const child of node.children) collectText(child, out)
  }
  return out
}

/** 按谓词收集元素节点。 */
function collectNodes(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) collectNodes(child, predicate, out)
    return out
  }
  if (predicate(node)) out.push(node)
  if (Array.isArray(node.children)) for (const child of node.children) collectNodes(child, predicate, out)
  return out
}

/** 冲掉微任务。 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

//#endregion

//#region 环境桩：window / document / fetch

/** 最近一次 `load()` 的入参。 */
let loaded = null

/** 假 fetch 的应答表：url 前缀 → { status, body }。 */
const responses = []
const fetchCalls = []

globalThis.window = {
  __ModuleLoader__: {
    load(registration) {
      loaded = registration
    },
  },
}
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '' }),
  head: { appendChild: () => {} },
}
globalThis.fetch = async (url, init) => {
  const href = String(url)
  fetchCalls.push({ url: href, init })
  for (const entry of responses) {
    if (href.startsWith(entry.match)) {
      return { ok: entry.status === 200, status: entry.status, json: async () => entry.body }
    }
  }
  return { ok: false, status: 404, json: async () => ({}) }
}

//#endregion

await import('../lib/client.js')

/** 取 bundle exports。 */
function loadExports() {
  assert.ok(loaded !== null, 'bundle 必须调用 window.__ModuleLoader__.load()')
  return loaded.factory((id) => {
    if (id === 'react') return React
    throw new Error(`unexpected require(${JSON.stringify(id)})`)
  })
}

/** 造一个假客户端 ctx，记录 slot 注册。 */
function createClientContext(options = {}) {
  const registrations = []
  const injected = []
  return {
    registrations,
    injected,
    ctx: {
      slots: {
        inject(slotName, callback) {
          injected.push(slotName)
          if (options.injectThrows === true) throw new Error('slots unavailable')
          return callback()
        },
        register(contribution, component) {
          registrations.push({ contribution, component })
          return () => {}
        },
      },
    },
  }
}

//#region 测试

test('bundle 形态：id 为包名、factory 导出 name/inject/apply 且无 default', () => {
  assert.equal(loaded.id, 'dsh-command-queue')
  assert.equal(typeof loaded.factory, 'function')

  const exports = loadExports()
  assert.equal(exports.name, 'command-queue-client')
  assert.deepEqual(exports.inject, ['slots'])
  assert.equal(typeof exports.apply, 'function')
  assert.equal(exports.default, undefined, 'client bundle 不能有 default（loader 的 unwrapExports 是 default-first）')
})

test('apply 在 conversation.input.dock 上注册自己的条目', () => {
  const { ctx, registrations, injected } = createClientContext()
  loadExports().apply(ctx)

  assert.deepEqual(injected, ['conversation.input.dock'])
  assert.equal(registrations.length, 1)
  const { contribution, component } = registrations[0]
  assert.equal(contribution.name, 'conversation.input.dock')
  assert.equal(contribution.id, 'command-queue')
  assert.equal(contribution.order, 30, '应排在原生队列（order 20）之后')
  assert.equal(typeof component, 'function')
  assert.deepEqual(contribution.inject('session-1'), { sessionId: 'session-1' })
})

test('apply 在槽位服务抛错时自吞异常（不让整个 boot 失败）', () => {
  const { ctx } = createClientContext({ injectThrows: true })
  assert.doesNotThrow(() => loadExports().apply(ctx))
})

test('组件：队列为空时返回 null，零视觉占用', async () => {
  responses.length = 0
  responses.push({ match: '/api/command-queue/state', status: 200, body: { ok: true, items: [] } })

  const { ctx, registrations } = createClientContext()
  loadExports().apply(ctx)
  const { component, contribution } = registrations[0]

  const handle = mount(component, contribution.inject('session-empty'))
  await flush()
  const tree = handle.renderOnce()
  handle.unmount()

  assert.equal(tree, null, '空队列必须渲染 null')
})

test('组件：有排队命令时渲染出命令行，并可经 drop 路由移除', async () => {
  responses.length = 0
  responses.push({
    match: '/api/command-queue/state',
    status: 200,
    body: { ok: true, items: [{ id: 'cq1', name: 'compact', line: '/compact', queuedAt: Date.now() }] },
  })
  responses.push({ match: '/api/command-queue/drop', status: 200, body: { ok: true, dropped: true } })
  fetchCalls.length = 0

  const { ctx, registrations } = createClientContext()
  loadExports().apply(ctx)
  const { component, contribution } = registrations[0]

  const handle = mount(component, contribution.inject('session-1'))
  await flush()
  const tree = handle.renderOnce()

  const texts = collectText(tree)
  assert.ok(
    texts.some((text) => text.includes('/compact')),
    `渲染结果应包含命令行，实际=${JSON.stringify(texts)}`,
  )
  assert.ok(
    fetchCalls.some((call) => call.url.startsWith('/api/command-queue/state')),
    '应轮询 host 快照路由',
  )

  const buttons = collectNodes(tree, (node) => node.type === 'button' && node.props?.className === 'dshcq_action')
  assert.equal(buttons.length, 1, '单条队列应有一个移除按钮')

  buttons[0].props.onClick()
  await flush()

  const dropCall = fetchCalls.find((call) => call.url.startsWith('/api/command-queue/drop'))
  assert.ok(dropCall, '点击移除应 POST drop 路由')
  assert.equal(dropCall.init.method, 'POST')
  assert.deepEqual(JSON.parse(dropCall.init.body), { sessionId: 'session-1', id: 'cq1' })

  handle.unmount()
})

test('组件：多条队列时渲染可折叠的计数头', async () => {
  responses.length = 0
  responses.push({
    match: '/api/command-queue/state',
    status: 200,
    body: {
      ok: true,
      items: [
        { id: 'cq1', name: 'compact', line: '/compact', queuedAt: Date.now() },
        { id: 'cq2', name: 'export', line: '/export', queuedAt: Date.now() },
      ],
    },
  })

  const { ctx, registrations } = createClientContext()
  loadExports().apply(ctx)
  const { component, contribution } = registrations[0]

  const handle = mount(component, contribution.inject('session-2'))
  await flush()
  const tree = handle.renderOnce()

  const headers = collectNodes(tree, (node) => node.type === 'button' && node.props?.className === 'dshcq_header')
  assert.equal(headers.length, 1, '多条时应渲染折叠头')
  assert.ok(
    collectText(tree).some((text) => text.includes('已排队命令 · 2')),
    `折叠头应显示条数，实际=${JSON.stringify(collectText(tree))}`,
  )

  // 点击展开后应能看到两条命令行
  headers[0].props.onClick()
  const expandedTree = handle.renderOnce()
  const expandedTexts = collectText(expandedTree)
  assert.ok(expandedTexts.some((text) => text.includes('/compact')))
  assert.ok(expandedTexts.some((text) => text.includes('/export')))

  handle.unmount()
})

test('组件：host 路由不可用时静默降级，不抛错', async () => {
  responses.length = 0 // 全部 404
  const { ctx, registrations } = createClientContext()
  loadExports().apply(ctx)
  const { component, contribution } = registrations[0]

  const handle = mount(component, contribution.inject('session-404'))
  await flush()
  assert.doesNotThrow(() => handle.renderOnce())
  handle.unmount()
})

//#endregion
