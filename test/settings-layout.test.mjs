/**
 * 设置页结构自测：高级项必须默认折叠。
 * 运行：node test/settings-layout.test.mjs
 *
 * 背景：设置页原先把镜像、代理、预设管理、新建预设全部平铺，
 * 首屏被十多个技术字段淹没；常改的其实只有能力开关与预设选择。
 * 折叠后功能一个没少，但首屏只剩常改的那两件事。
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'lib', 'client.js')

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`  ok  ${name}`)
}

const DEPS = process.env.DSH_TEST_DEPS
if (DEPS === undefined) {
  console.log('  跳过：需要 DSH_TEST_DEPS 提供 react')
  process.exit(0)
}
const requireDeps = createRequire(join(DEPS, 'react', 'package.json'))
const React = requireDeps('react')
const { renderToStaticMarkup } = requireDeps('react-dom/server')

// 模块是浏览器格式：window.__ModuleLoader__.load({ id, factory(require) })
let factory
new Function('window', readFileSync(clientPath, 'utf8'))({
  __ModuleLoader__: { load: ({ factory: f }) => { factory = f } }
})
assert.equal(typeof factory, 'function', 'client.js 应通过 __ModuleLoader__ 暴露 factory')
const mod = factory((id) => (id === 'react' ? React : requireDeps(id)))

/** 渲染设置页，返回真实 HTML。 */
function render() {
  const dict = {}
  let registered
  const ctx = {
    effect: (fn) => { fn(); return () => {} },
    locale: {
      bind: () => (key) => dict[key] ?? key,
      register: (_ns, tables) => { Object.assign(dict, tables.zh ?? {}) }
    },
    slots: {
      inject: (name, fn) => { fn(); return () => {} },
      register: (spec, component) => { registered = { spec, component } } }
    ,
    remote: {
      agentPresets: {
        list: async () => [{ id: 'generic', name: '通用环境' }],
        read: async () => ({ id: 'generic', name: '通用环境', content: 'tools: [fs]' })
      }
    },
    configForms: {
      get: () => ({
        getSnapshot: () => ({
          revision: 1,
          value: {
            capabilities: { fs: true },
            mirrors: { pipIndexUrl: '' },
            proxy: { enabled: true, host: '' },
            preset_edits: {},
            inject_into: []
          }
        }),
        subscribe: () => () => {},
        mutate: async () => {}
      })
    }
  }
  mod.apply(ctx)
  assert.ok(registered, 'apply 应注册设置页')
  return renderToStaticMarkup(React.createElement(registered.component, registered.spec.inject()))
}

const html = render()

console.log('设置页布局')

check('页面能渲染', () => {
  assert.ok(html.length > 200)
})

check('四个区块标题都在（功能一个没少）', () => {
  for (const title of ['全局能力开关', '软件源镜像', '外网代理', '预设管理']) {
    assert.ok(html.includes(title), `缺少区块：${title}`)
  }
})

check('镜像与代理默认收起', () => {
  const collapsed = (html.match(/aria-expanded="false"/g) ?? []).length
  assert.ok(collapsed >= 2, `应有至少 2 个收起区块，实际 ${collapsed}`)
})

check('收起时高级字段不渲染（首屏更短）', () => {
  assert.ok(!html.includes('pipIndexUrl'), '镜像输入框不该出现在首屏')
})

check('收起时显示摘要而非空白', () => {
  assert.match(html, /默认/, '收起态应给出当前值摘要')
})

check('折叠按钮有可访问性属性', () => {
  assert.ok(html.includes('aria-expanded'), '折叠按钮必须带 aria-expanded')
})

check('能力开关仍直接在首屏（最常改的项不被折叠）', () => {
  assert.ok(html.includes('aria-checked'), '能力勾选框应可见')
})

console.log(`\n${passed} 项通过`)
