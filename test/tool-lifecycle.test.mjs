/**
 * 工具注册生命周期自测：注册的工具必须能被卸载。
 * 运行：node test/tool-lifecycle.test.mjs
 *
 * 背景：`ctx.tools.register()` 返回 disposer。此前 agentkit 把它丢掉，
 * 导致插件重载 / 配置变更后旧注册永远留在 scope 层里 ——
 * 表现为"关掉能力后工具删不掉、再开也加不回来"，只能重建会话。
 */
import assert from 'node:assert/strict'
import { createToolRegistrar } from '../tools/registry.js'

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`  ok  ${name}`)
}

/** 假 ctx：tools.register 返回可观测的 disposer，effect 记录清理函数。 */
function fakeCtx() {
  const state = { registered: [], live: new Set(), effects: [], logs: [] }
  const ctx = {
    logger: { info: (m) => state.logs.push(m), warn: (m) => state.logs.push(m) },
    tools: {
      get: () => undefined,
      register: (def) => {
        state.registered.push(def.name)
        state.live.add(def.name)
        return () => {
          state.live.delete(def.name)
          return true
        }
      }
    },
    effect: (fn, label) => {
      const cleanup = typeof fn === 'function' ? fn() : undefined
      state.effects.push({ label, cleanup })
      return () => {}
    }
  }
  return { ctx, state }
}

const tool = (name) => ({
  name,
  description: 'd',
  parameters: { type: 'object', additionalProperties: false, properties: {} },
  output: { schema: { type: 'object' }, render: () => [] },
  async execute() { return {} }
})

console.log('createToolRegistrar 生命周期')

check('创建注册器时自动登记 ctx.effect', () => {
  const { ctx, state } = fakeCtx()
  createToolRegistrar(ctx)
  assert.equal(state.effects.length, 1, '必须登记一次 effect')
  assert.equal(state.effects[0].label, 'agentkit:tools:dispose')
  assert.equal(typeof state.effects[0].cleanup, 'function', 'effect 必须返回清理函数')
})

check('注册的工具在清理后全部消失', () => {
  const { ctx, state } = fakeCtx()
  const register = createToolRegistrar(ctx)
  register(tool('read'))
  register(tool('write'))
  assert.deepEqual([...state.live], ['read', 'write'])

  const removed = state.effects[0].cleanup()
  assert.equal(removed, 2)
  assert.equal(state.live.size, 0, '清理后不应残留任何注册')
})

check('清理是幂等的（重复调用不报错、不重复计数）', () => {
  const { ctx, state } = fakeCtx()
  const register = createToolRegistrar(ctx)
  register(tool('read'))
  assert.equal(state.effects[0].cleanup(), 1)
  assert.equal(state.effects[0].cleanup(), 0)
})

check('逆序卸载（与注册顺序相反）', () => {
  const { ctx } = fakeCtx()
  const order = []
  ctx.tools.register = (def) => {
    order.push(def.name)
    return () => order.push(`-${def.name}`)
  }
  const register = createToolRegistrar(ctx)
  register(tool('a'))
  register(tool('b'))
  register(tool('c'))
  register.disposeAll()
  assert.deepEqual(order, ['a', 'b', 'c', '-c', '-b', '-a'])
})

check('单个 disposer 抛错不影响其余工具卸载', () => {
  const { ctx } = fakeCtx()
  let calls = 0
  ctx.tools.register = (def) => () => {
    calls += 1
    if (def.name === 'bad') throw new Error('boom')
  }
  const register = createToolRegistrar(ctx)
  register(tool('ok1'))
  register(tool('bad'))
  register(tool('ok2'))
  assert.doesNotThrow(() => register.disposeAll())
  assert.equal(calls, 3, '三个 disposer 都应被调用')
})

check('清理后可以重新注册同名工具（不再"能删不能加"）', () => {
  const { ctx, state } = fakeCtx()
  const register = createToolRegistrar(ctx)
  register(tool('subagent'))
  assert.ok(state.live.has('subagent'))

  register.disposeAll()
  assert.equal(state.live.has('subagent'), false)

  // 同一个 registrar 重新注册应当成功（seen 已清空，注册层未抛重名）
  register(tool('subagent'))
  assert.ok(state.live.has('subagent'), '卸载后必须能重新注册')
})

check('让出的工具（yielded）不进入卸载列表', () => {
  const { ctx, state } = fakeCtx()
  ctx.tools.register = () => {
    throw new Error('tool "x" is already registered in this scope')
  }
  const register = createToolRegistrar(ctx)
  const ret = register(tool('x'))
  assert.equal(ret, undefined, '让出时应返回 undefined')
  assert.equal(register.disposeAll(), 0, '没有成功注册就没有可卸载项')
})

check('没有 ctx.effect 时安全降级（不抛错，disposeAll 仍可用）', () => {
  const ctx = {
    logger: { info() {}, warn() {} },
    tools: { get: () => undefined, register: () => () => {} }
  }
  const register = createToolRegistrar(ctx)
  assert.equal(typeof register.disposeAll, 'function')
  assert.doesNotThrow(() => register.disposeAll())
})

console.log(`\n${passed} 项通过`)
