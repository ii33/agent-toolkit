/**
 * 装载测试：用假的 ctx 按每个 preset 的能力数组真实调用 apply，
 * 并按 harness 支持的 JSON Schema 子集校验每个工具定义。
 *
 * 它替代了"装进 profile 才发现挂载失败"的反馈回路：
 *   - 能力名写错 → 这里就抛；
 *   - output.schema 用了不支持的键（harness 会 assertSupportedJsonSchema 拒绝并让 preset 挂载失败）→ 这里就报；
 *   - 工具缺 name/description/parameters/render → 这里就报。
 *
 * 运行：node test/load.test.mjs
 */
import assert from 'node:assert/strict'
import { shippedGenericCapabilities } from './deps.mjs'
import { apply } from '../index.js'
import { BANNED_TOOL_NAMES, denyReasonFor } from '../tools/guard.js'

/** harness 支持的 schema 子集（dsh-tools 的 JsonSchemaNode）。 */
const ALLOWED_KEYS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties',
  'items', 'enum', 'const', 'description', 'title', 'default', 'examples'
])
const ALLOWED_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

/** 递归校验一个 schema 节点只使用受支持的键。 */
function checkSchema(node, path, violations) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    violations.push(`${path} 必须是对象`)
    return
  }
  for (const key of Object.keys(node)) {
    if (!ALLOWED_KEYS.has(key)) violations.push(`${path}.${key} 不在支持子集内`)
  }
  if (node.type !== undefined && !ALLOWED_TYPES.has(node.type)) violations.push(`${path}.type=${node.type} 非法`)
  if (node.required !== undefined) {
    if (!Array.isArray(node.required) || node.required.some((name) => typeof name !== 'string')) {
      violations.push(`${path}.required 必须是字符串数组（DSL 的 required:true 已被 defineTool 转换，手写定义要用数组）`)
    }
  }
  if (node.properties !== undefined) {
    if (typeof node.properties !== 'object' || Array.isArray(node.properties)) violations.push(`${path}.properties 必须是对象`)
    else for (const [key, child] of Object.entries(node.properties)) checkSchema(child, `${path}.properties.${key}`, violations)
  }
  if (node.items !== undefined) checkSchema(node.items, `${path}.items`, violations)
  if (node.oneOf !== undefined) {
    if (!Array.isArray(node.oneOf)) violations.push(`${path}.oneOf 必须是数组`)
    else node.oneOf.forEach((child, index) => checkSchema(child, `${path}.oneOf[${index}]`, violations))
  }
}

/**
 * 装载组合。
 *
 * `generic` 直接取自出货 `cordis.patch.yml`（唯一真源，见 test/deps.mjs 的
 * shippedGenericCapabilities）—— 这里不再另抄一份清单，避免三方打架。
 * 其余是覆盖不同能力子集的**合成组合**，只用于验证装载逻辑本身，不是出货预设
 * （当前 profile 只保留 generic 一个）。
 */
const GENERIC_CAPABILITIES = shippedGenericCapabilities()
const PRESETS = {
  generic: GENERIC_CAPABILITIES,
  'coverage-a': ['fs', 'split', 'run', 'sh', 'env', 'doc', 'img', 'sftp', 'tasks', 'guard'],
  'coverage-b': ['fs', 'split', 'run', 'sh', 'env', 'doc', 'img', 'tasks', 'guard'],
  'coverage-c': ['fs', 'run', 'sh', 'env', 'doc', 'img', 'sftp', 'tasks', 'guard'],
  'coverage-d': ['fs', 'run', 'sh', 'doc', 'img', 'tasks', 'guard'],
  'coverage-e': ['fs', 'run', 'sh', 'doc', 'sftp', 'tasks', 'guard']
}

/** 每个能力应当注册的工具名。 */
const EXPECTED = {
  fs: ['read', 'read_many', 'write', 'edit', 'list_dir'],
  split: ['split_file'],
  run: ['run'],
  sh: ['sh'],
  pwsh: ['pwsh'],
  env: ['pip_install', 'env_setup'],
  proxy: ['net_check'],
  doc: ['ocr_doc', 'merge_files', 'pack'],
  img: ['read_image', 'image_info', 'crop_image', 'resize_image'],
  sftp: ['sftp_hosts', 'search_remote'],
  tasks: ['plan_init', 'task_update', 'task_show', 'stage_set'],
  preset: ['preset_create', 'preset_list', 'preset_delete', 'preset_inject', 'preset_eject'],
  guard: []
}

/** 造一个足够让 apply() 跑起来的假 ctx，并收集注册结果。 */
function fakeCtx() {
  const state = { tools: [], contexts: [], listeners: [], logs: [] }
  const ctx = {
    tools: { register: (definition) => { state.tools.push(definition); return () => {} } },
    systemPrompt: { context: (entry) => { state.contexts.push(entry); return () => {} } },
    on: (event, listener) => { state.listeners.push({ event, listener }); return () => {} },
    effect: (fn) => fn(),
    get: () => undefined,
    logger: { info: (line) => state.logs.push(line) },
    waterfall: async () => undefined,
    emit: () => {}
  }
  return { ctx, state }
}

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`  ok  ${name}`)
}

console.log('load')

for (const [preset, capabilities] of Object.entries(PRESETS)) {
  check(`preset ${preset} 装载 ${capabilities.length} 个能力`, () => {
    const { ctx, state } = fakeCtx()
    apply(ctx, { tools: capabilities })
    const names = state.tools.map((tool) => tool.name)
    const expected = capabilities.flatMap((name) => EXPECTED[name])
    assert.deepEqual([...names].sort(), [...expected].sort(), `${preset} 注册的工具名不符`)
    assert.equal(state.logs.length, 1, '应当恰好打一行挂载日志')
    assert.match(state.logs[0], /agent-toolkit: tools = /)
  })
}

check('出货 generic 的能力清单与 index.js 的能力表一致', () => {
  assert.deepEqual(
    [...GENERIC_CAPABILITIES].sort(),
    Object.keys(EXPECTED).sort(),
    'cordis.patch.yml 的 generic 与 index.js 的 CAPABILITIES 必须一一对应（新增能力别忘了挂进出货预设）'
  )
})

check('所有工具定义结构合法且 schema 在支持子集内', () => {
  const { ctx, state } = fakeCtx()
  apply(ctx, { tools: Object.keys(EXPECTED) })
  assert.ok(state.tools.length > 0, '应当注册了工具')
  for (const tool of state.tools) {
    assert.equal(typeof tool.name, 'string', 'name 必须是字符串')
    assert.ok(tool.name.length > 0, 'name 不能为空')
    assert.equal(typeof tool.description, 'string', `${tool.name} 缺少 description`)
    assert.ok(tool.description.length > 0, `${tool.name} description 为空`)
    assert.equal(typeof tool.execute, 'function', `${tool.name} 缺少 execute`)
    const violations = []
    checkSchema(tool.parameters, `${tool.name}.parameters`, violations)
    checkSchema(tool.output?.schema, `${tool.name}.output.schema`, violations)
    assert.deepEqual(violations, [], `${tool.name} schema 违规：\n${violations.join('\n')}`)
    assert.equal(typeof tool.output?.render, 'function', `${tool.name} 缺少 output.render`)
    assert.equal(tool.output.schema.type, 'object', `${tool.name} 的 output.schema 必须是对象根`)
  }
})

check('未知能力会直接报错（不静默忽略）', () => {
  const { ctx } = fakeCtx()
  assert.throws(() => apply(ctx, { tools: ['fs', 'nope'] }), /未知能力 nope/)
})

check('空 tools 数组会报错', () => {
  const { ctx } = fakeCtx()
  assert.throws(() => apply(ctx, { tools: [] }), /非空数组/)
})

check('不传 config 时挂载全部能力', () => {
  const { ctx, state } = fakeCtx()
  apply(ctx)
  const names = state.tools.map((tool) => tool.name).sort()
  const all = Object.values(EXPECTED).flat().sort()
  assert.deepEqual(names, all)
})

check('tasks 能力注册了面板注入与 agent 监听', () => {
  const { ctx, state } = fakeCtx()
  apply(ctx, { tools: ['tasks'] })
  assert.equal(state.contexts.length, 1)
  assert.equal(state.contexts[0].name, 'doc-pipeline:panel')
  assert.equal(typeof state.contexts[0].text, 'function')
  assert.equal(state.contexts[0].text({ scope: {} }), '', '无账本时面板应为空串')
  assert.ok(state.listeners.some((entry) => entry.event === 'agent/created'))
})

check('guard 能力注册 agent/created 监听', () => {
  const { ctx, state } = fakeCtx()
  apply(ctx, { tools: ['guard'] })
  assert.equal(state.tools.length, 0)
  assert.ok(state.listeners.some((entry) => entry.event === 'agent/created'))
})

check('禁令名单绝不能命中本工具集自己的工具（否则自家 shell 会被自己拦掉）', () => {
  const { ctx, state } = fakeCtx()
  apply(ctx, { tools: Object.keys(EXPECTED) })
  const ownNames = state.tools.map((tool) => tool.name)
  const collisions = ownNames.filter((name) => BANNED_TOOL_NAMES.includes(name))
  assert.deepEqual(collisions, [], `禁令名单与本工具集冲突：${collisions.join(', ')}`)
  // 明确断言：pwsh（PowerShell 7）与 sh（bash）必须放行
  assert.equal(BANNED_TOOL_NAMES.includes('pwsh'), false)
  assert.equal(BANNED_TOOL_NAMES.includes('sh'), false)
  // 明确断言：Windows PowerShell 5.1 与 cmd 必须禁用
  assert.equal(BANNED_TOOL_NAMES.includes('powershell'), true)
  assert.equal(BANNED_TOOL_NAMES.includes('cmd'), true)
})

check('禁 shell：禁 powershell/cmd，放行 pwsh/sh', () => {
  assert.equal(typeof denyReasonFor('powershell', true), 'string')
  assert.equal(typeof denyReasonFor('cmd', true), 'string')
  assert.equal(typeof denyReasonFor('terminal_open', true), 'string')
  assert.equal(denyReasonFor('pwsh', true), undefined)
  assert.equal(denyReasonFor('sh', true), undefined)
  assert.equal(denyReasonFor('run', true), undefined)
})

check('自家工具名永不与禁令冲突（写工具已用内置名 read/write/edit）', () => {
  for (const name of ['read', 'write', 'edit', 'list_dir', 'sh', 'pwsh', 'run', 'read_image', 'write_text', 'edit_text']) {
    assert.equal(denyReasonFor(name), undefined, `${name} 不应被禁`)
  }
  assert.equal(typeof denyReasonFor('powershell'), 'string')
  assert.equal(typeof denyReasonFor('cmd'), 'string')
})

check('宿主行（settingsOnly）不注册任何工具，只承载设置页', () => {
  const { ctx, state } = fakeCtx()
  apply(ctx, { settingsOnly: true, capabilities: { fs: true } })
  assert.equal(state.tools.length, 0)
})

check('设置页的全局闸门与 preset 行的 tools 取交集', () => {
  const { ctx, state } = fakeCtx()
  ctx.get = (name) => (name === 'settings'
    ? { describe: () => [{ ns: 'agentkit', value: { capabilities: { fs: true, sh: true } } }] }
    : undefined)
  apply(ctx, { tools: ['fs', 'run', 'sh'] })
  assert.deepEqual(state.tools.map((tool) => tool.name).sort(), ['edit', 'list_dir', 'read', 'read_many', 'sh', 'write'])
})

console.log(`\n${passed} 项通过`)
