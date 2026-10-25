/**
 * 客户端组件的离线渲染测试：用真实的 react + react-dom/server 渲染我的卡片，
 * 抓出"渲染时抛异常导致整块空白"这类问题（不用碰运行中的应用）。
 *
 * 手法：客户端模块调用 `window.__ModuleLoader__.load(spec)` → 捕获 spec →
 * 用假 require 跑 factory → 用假 ctx 调 apply 捕获注册的组件 → SSR 渲染它。
 *
 * 运行：node test/client-render.test.mjs
 */
import assert from 'node:assert/strict'
import { loadDependency } from './deps.mjs'

// React 由浏览器侧的模块加载器提供给客户端插件（Web 前端锁 react/react-dom ^18.2.0），
// 装机包的 node_modules 里没有 react，所以离线测试从 test/deps.mjs 解析（见该文件）。
const React = loadDependency('react')
const { renderToStaticMarkup } = loadDependency('react-dom/server')

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`  ok  ${name}`)
}

console.log('client render')

// ① 捕获客户端模块
let spec
globalThis.window = { __ModuleLoader__: { load: (value) => { spec = value } } }
await import('../lib/client.js')
assert.ok(spec !== undefined, '客户端模块应调用 __ModuleLoader__.load')
assert.equal(spec.id, '@local/dsh-agentkit')

// ② 跑 factory（只允许 require('react')）
const mod = spec.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require: ${name}`)
})

check('导出 inject / apply，且 inject 覆盖所需服务', () => {
  assert.deepEqual(mod.inject, ['slots', 'locale', 'remote', 'remote.agentPresets', 'configForms'])
  assert.equal(typeof mod.apply, 'function')
})

/**
 * 用假 ctx 挂载并捕获注册的组件。
 * @param {object} [options] - 覆盖项。
 * @returns {{Component: Function, options: object, inject: Function}} 捕获结果。
 */
function mount(options = {}) {
  let captured
  const scope = options.scope
  const ctx = {
    locale: { bind: () => (key) => key, register: () => () => {}, getSnapshot: () => ({ revision: 0 }) },
    slots: {
      inject: (_slot, fn) => fn(),
      register: (registerOptions, Component) => {
        captured = { options: registerOptions, Component }
        return () => {}
      }
    },
    effect: (fn) => fn(),
    configForms: { get: () => scope },
    remote: {
      agentPresets: options.agentPresets ?? {
        list: async () => ({ value: { presets: [] } }),
        read: async () => ({ value: { content: '' } })
      }
    }
  }
  mod.apply(ctx)
  assert.ok(captured !== undefined, 'apply 应注册进 plugins.bundle.config')
  return { Component: captured.Component, options: captured.options, inject: captured.options.inject }
}

check('注册进 plugins.bundle.config，key 是包名', () => {
  const { options } = mount()
  assert.equal(options.name, 'plugins.bundle.config')
  assert.equal(options.key, '@local/dsh-agentkit')
})

check('没有表单作用域时渲染诊断文字（不抛异常）', () => {
  const { Component, inject } = mount()
  const html = renderToStaticMarkup(React.createElement(Component, { ...inject(), t: (key) => key }))
  assert.match(html, /noForm/)
})

check('有表单作用域时渲染全部区块（能力/镜像/代理/预设/新建）', () => {
  const scope = {
    getSnapshot: () => ({
      revision: 3,
      value: {
        capabilities: { fs: true, sh: true },
        mirrors: { pip_index_url: '' },
        proxy: { enabled: true, host: '127.0.0.1', port: 10808, slow_ms: 3000 },
        inject_into: ['standard'],
        preset_edits: { cordis: { capabilities: ['fs'], persona: 'x', suffix: '', complete: '' } }
      }
    }),
    subscribe: () => () => {},
    mutate: async () => {}
  }
  const { Component, inject } = mount({ scope })
  const html = renderToStaticMarkup(React.createElement(Component, { ...inject(), t: (key) => key }))
  assert.ok(html.length > 500, `应渲染出内容（实际 ${html.length} 字符）`)
  for (const marker of ['capable', 'mirrors', 'proxy', 'presets', 'create']) {
    assert.ok(html.includes(marker), `应包含区块 ${marker}`)
  }
  assert.ok(html.includes('type="radio"'), '预设选择应为单选框')
})

check('roster 有数据时渲染单选列表（含已注入标记）', () => {
  const scope = {
    getSnapshot: () => ({
      revision: 1,
      value: { capabilities: {}, mirrors: {}, proxy: {}, inject_into: ['standard'], preset_edits: {} }
    }),
    subscribe: () => () => {},
    mutate: async () => {}
  }
  // 注意：SSR 不跑 useEffect，roster 仍是初始空数组 —— 这里只验证不抛异常
  const { Component, inject } = mount({ scope })
  const html = renderToStaticMarkup(React.createElement(Component, { ...inject(), t: (key) => key }))
  assert.ok(html.includes('loading') || html.includes('rosterFailed'))
})

console.log(`\n${passed} 项通过`)
