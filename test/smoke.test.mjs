/**
 * 冒烟测试：不依赖 DSH 运行时，只验证宿主半侧与浏览器半侧都能被正确加载。
 *
 *   node --test
 *
 * 宿主半侧要能 import，并导出 DSH 约定的 name / inject / apply；
 * 浏览器半侧的工厂函数要能注册、能被调用，并把开关挂到
 * `conversation.input.right` 插槽上。
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const load = (relative) => import(pathToFileURL(join(root, relative)).href)

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

test('package.json 符合 DSH 插件约定', () => {
  assert.equal(pkg.name, 'dsh-plan-mode')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.main, 'lib/index.js')
  assert.equal(pkg.exports['.'], './lib/index.js')
  assert.equal(pkg.exports['./client'], './lib/client.js')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.ok(pkg.dsh.client.inject.length > 0)
  assert.equal(pkg.private, undefined, '公开插件不应带 private: true')
  assert.match(pkg.version, /^\d+\.\d+\.\d+/)
})

test('宿主半侧导出 name / inject / apply', async () => {
  const host = await load('lib/index.js')
  assert.equal(host.name, 'dsh-plan-mode')
  assert.equal(typeof host.apply, 'function')
  assert.deepEqual(host.inject, ['llm', 'agents'])
})

test('浏览器半侧注册工厂，并挂到输入框右侧插槽', async () => {
  const registered = []
  const previous = globalThis.window

  globalThis.window = { __ModuleLoader__: { load: (entry) => registered.push(entry) } }
  try {
    await load('lib/client.js')
  } finally {
    globalThis.window = previous
  }

  assert.equal(registered.length, 1, '应当注册且只注册一个模块')
  const [entry] = registered
  assert.equal(entry.id, 'dsh-plan-mode')
  assert.equal(typeof entry.factory, 'function')

  // 工厂里的 require 指向宿主 shell 的共享模块表，这里给最小替身。
  const stubs = {
    react: { useReducer: (fn, init) => [init, () => {}], useEffect: () => {} },
    'react/jsx-runtime': { jsx: () => null },
  }
  const mod = entry.factory((id) => {
    if (!(id in stubs)) throw new Error(`unexpected require: ${id}`)
    return stubs[id]
  })

  assert.equal(mod.name, 'dsh-plan-mode-client')
  assert.deepEqual(mod.inject, ['slots'])
  assert.equal(typeof mod.apply, 'function')

  const injected = []
  mod.apply({
    slots: {
      inject: (slot, factory) => injected.push([slot, typeof factory]),
      register: () => 'registered',
    },
  })

  assert.deepEqual(injected, [['conversation.input.right', 'function']])
})

/**
 * 造一个最小的 DSH 上下文：`ctx.inject` 立刻回调、`effect` 立刻执行、
 * `webServer.register` 只记录路由、`ctx.on` 只记录钩子。
 * 不提供 `llm`，所以任何真去调模型的路径都会抛错——这正好能区分
 * 「提前返回」和「走到规划」。
 */
function makeContext() {
  const routes = []
  const handlers = new Map()
  const scope = {
    effect: (fn) => fn(),
    webServer: { register: (route) => (routes.push(route), () => {}) },
  }
  const ctx = {
    inject: (names, callback) => callback(scope),
    on: (event, handler) => handlers.set(event, handler),
    get: () => undefined,
    agents: { roots: () => [], list: () => [] },
  }
  return { ctx, routes, handlers }
}

/** 在临时 DSH_HOME 下加载宿主半侧，避免读到本机真实开关。 */
async function applyWithState(config, state) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-plan-mode-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    if (state !== undefined) {
      await writeFile(join(home, 'plan-mode.json'), JSON.stringify(state), 'utf8')
    }
    const host = await load('lib/index.js')
    const built = makeContext()
    host.apply(built.ctx, config)
    return built
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
}

test('apply() 注册三条诊断路由与 pre-step 钩子', async () => {
  const { routes, handlers } = await applyWithState({})

  assert.deepEqual(
    routes.map((route) => route.path).sort(),
    [
      '/plugins/dsh-plan-mode/agents',
      '/plugins/dsh-plan-mode/selftest',
      '/plugins/dsh-plan-mode/state',
    ],
  )
  assert.ok(routes.every((route) => route.kind === 'exact'))
  assert.ok(routes.every((route) => typeof route.handler === 'function'))
  assert.equal(typeof handlers.get('agent/pre-step'), 'function')
})

test('开关关闭时 pre-step 原样放行', async () => {
  const { handlers } = await applyWithState({})
  const decision = { kind: 'enter', messages: [] }
  const result = await handlers.get('agent/pre-step')(
    { step: 1, agent: { id: 'root' }, signal: undefined },
    async () => decision,
  )
  assert.equal(result, decision, '关闭时不应改动 decision')
})

test('minChars 能挡掉短输入，且不产生任何注入消息', async () => {
  const { handlers } = await applyWithState({ minChars: 100 }, { enabled: true })
  const decision = {
    kind: 'enter',
    messages: [{
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: '你好' }],
    }],
  }
  const result = await handlers.get('agent/pre-step')(
    { step: 1, agent: { id: 'root' }, signal: undefined },
    async () => decision,
  )
  assert.equal(result, decision, '短于 minChars 时应在调用模型之前返回')
})

