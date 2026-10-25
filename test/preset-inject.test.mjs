/**
 * 预设注入器的离线测试（纯函数部分）。
 *
 * 用真实出货预设的插件列表形状做样本，并**用真 YAML 解析器回读**生成的覆盖声明。
 *
 * 运行：node test/preset-inject.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadDependency, resolveShippedFile } from './deps.mjs'
import { ensureToolkitRow, readPersonaPrefix, readToolkitCapabilities, renderEditOverride, renderOverrideBlock, withPersonaPrefix } from '../lib/preset-inject.js'

// 状态文件写到临时目录：preset.js 现在用 node:fs 直写（绕过模型沙箱），
// 所以必须先设好目录再导入它，免得动到真实数据。
const STATE_DIR = mkdtempSync(join(tmpdir(), 'agentkit-test-'))
process.env.DSH_AGENTKIT_STATE_DIR = STATE_DIR
const { syncFromSettings, syncInjections } = await import('../tools/preset.js')
const readStateFile = (name) => readFileSync(join(STATE_DIR, name), 'utf8')

// 真 YAML 解析器（与装机包同一个版本），来源见 test/deps.mjs。
const yaml = loadDependency('js-yaml')

/**
 * 出货补丁里有 `disabled: !!js <表达式>`（harness 的 Loader 会求值它），
 * 普通 js-yaml 不认这个标签 —— 测试里当作普通标量收下即可。
 */
const HARNESS_SCHEMA = yaml.DEFAULT_SCHEMA.extend([
  new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', resolve: (data) => ({ js: data }) })
])
const loadHarnessYaml = (text) => yaml.load(text, { schema: HARNESS_SCHEMA })

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`  ok  ${name}`)
}

/** 样本：出货预设的插件列表 YAML 形状（含字面量块与引号）。 */
const SAMPLE = [
  '- id: persona',
  "  name: '@deepseek-ai/dsh-persona'",
  '  config:',
  '    prefix: |',
  '      你是运行在 Windows 上的编码 agent。',
  '- id: tool-fs',
  "  name: '@deepseek-ai/dsh-tool-fs'",
  ''
].join('\n')

console.log('preset inject')

check('没有 toolkit 行时追加到末尾', () => {
  const out = ensureToolkitRow(SAMPLE, ['fs', 'sh'])
  const rows = out.split('\n').filter((line) => line.startsWith('- id: '))
  assert.deepEqual(rows, ['- id: persona', '- id: tool-fs', '- id: toolkit'])
  assert.match(out, /tools: \[fs, sh\]/)
})

check('已有 toolkit 行时替换其 tools（幂等，不重复追加）', () => {
  const once = ensureToolkitRow(SAMPLE, ['fs'])
  const twice = ensureToolkitRow(once, ['fs', 'sh', 'tasks'])
  assert.equal((twice.match(/^- id: toolkit/gmu) ?? []).length, 1)
  assert.match(twice, /tools: \[fs, sh, tasks\]/)
  assert.doesNotMatch(twice, /tools: \[fs\]/)
})

check('生成的覆盖声明能被真 YAML 解析器接受，且形状正确', () => {
  const doc = { id: 'standard', name: '标准', description: '内置标准预设', order: 10, content: SAMPLE }
  const block = renderOverrideBlock(doc, ['fs', 'sh', 'tasks', 'preset'])
  const parsed = yaml.load(`# 由 preset_inject 生成（顶层覆盖条目）\n${block}\n`)
  const row = parsed[0]
  assert.equal(row.id, 'preset-standard')
  assert.equal(row.name, '@deepseek-ai/dsh-agent-preset')
  assert.equal(row.config.id, 'standard')
  assert.equal(row.config.name, '标准')
  assert.equal(row.config.order, 10)
  assert.deepEqual(row.config.plugins.map((entry) => entry.id), ['persona', 'tool-fs', 'toolkit'])
  const toolkit = row.config.plugins.find((entry) => entry.id === 'toolkit')
  assert.equal(toolkit.name, '@local/dsh-agentkit')
  assert.deepEqual(toolkit.config.tools, ['fs', 'sh', 'tasks', 'preset'])
  // 字面量块必须原样保留（中文与缩进都不能被破坏）
  assert.equal(row.config.plugins[0].config.prefix.trim(), '你是运行在 Windows 上的编码 agent。')
})

check('缺 name / order 时有合理默认值', () => {
  const block = renderOverrideBlock({ id: 'cordis', content: SAMPLE }, ['fs'])
  const parsed = yaml.load(`${block}\n`)
  const row = parsed[0]
  assert.equal(row.config.name, 'cordis')
  assert.equal(row.config.order, 50)
  assert.match(row.config.description, /cordis/)
})

check('真实出货预设（standard.patch.yml）：抽取 → 注入 → 覆盖声明可解析', () => {
  const { path: file, source } = resolveShippedFile('@deepseek-ai/dsh-web-app/presets/standard.patch.yml')
  console.log(`      （standard.patch.yml 来源：${source}）`)
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line.trim() === '- id: preset-standard')
  assert.notEqual(start, -1, '应能找到 preset-standard')
  const pluginsAt = lines.findIndex((line, index) => index > start && line.trim() === 'plugins:')
  assert.notEqual(pluginsAt, -1, '应能找到 plugins:')
  let end = lines.length
  for (let index = pluginsAt + 1; index < lines.length; index += 1) {
    if (/^ {4}- id: /u.test(lines[index])) {
      end = index
      break
    }
  }
  const pluginLines = lines.slice(pluginsAt + 1, end)
  const indents = pluginLines.filter((line) => line.trim() !== '').map((line) => (/^ */u.exec(line))[0].length)
  const baseIndent = Math.min(...indents)
  const content = pluginLines.map((line) => (line.trim() === '' ? '' : line.slice(baseIndent))).join('\n')
  const rowsBefore = content.split('\n').filter((line) => line.startsWith('- id: ')).length
  assert.ok(rowsBefore > 3, `真实预设应有多行插件（实际 ${rowsBefore}）`)

  const block = renderOverrideBlock({ id: 'standard', name: '标准', order: 10, content }, ['fs', 'sh', 'tasks', 'preset'])
  const parsed = loadHarnessYaml(`${block}\n`)
  const row = parsed[0]
  assert.equal(row.id, 'preset-standard')
  assert.equal(row.config.plugins.length, rowsBefore + 1)
  const injected = row.config.plugins.at(-1)
  assert.equal(injected.id, 'toolkit')
  assert.equal(injected.name, '@local/dsh-agentkit')
  assert.deepEqual(injected.config.tools, ['fs', 'sh', 'tasks', 'preset'])
  console.log(`      （真实预设 ${rowsBefore} 个插件行 → 注入后 ${row.config.plugins.length} 行）`)
})

/** 内存版 ctx.fs，用于测 syncInjections。 */
function memoryContext() {
  const store = new Map()
  return {
    store,
    logger: { info: () => {} },
    fs: {
      resolve: async (path) => ({ targetKey: path, displayPath: path }),
      stat: async (target) => (store.has(target.displayPath) ? { type: 'file', version: 'v1' } : undefined),
      readText: async (target) => store.get(target.displayPath) ?? '',
      writeText: async (target, text) => {
        store.set(target.displayPath, text)
        return { operation: 'update', version: 'v2' }
      }
    }
  }
}

// syncInjections 是异步的，放在最后单独跑
{
  const ctx = memoryContext()
  const first = await syncInjections(ctx, ['standard', 'cordis'], ['fs', 'sh'])
  assert.equal(first.changed, true)
  assert.deepEqual(first.injected, ['standard', 'cordis'])
  passed += 1
  console.log('  ok  syncInjections：首次按设置页并入注入项')

  const again = await syncInjections(ctx, ['standard', 'cordis'], ['fs', 'sh'])
  assert.equal(again.changed, false, '无变化时不应重写文件')
  passed += 1
  console.log('  ok  syncInjections：无变化不写文件（幂等）')

  const third = await syncInjections(ctx, ['cordis'], ['fs'])
  assert.deepEqual(third.injected, ['cordis'])
  const written = JSON.parse(readStateFile('presets.generated.json'))
  assert.deepEqual(written.inject, [{ preset: 'cordis', capabilities: ['fs'], source: 'settings' }])
  passed += 1
  console.log('  ok  syncInjections：改列表后旧项被替换（且标记 source=settings）')

  const cleared = await syncInjections(ctx, [], ['fs'])
  assert.deepEqual(cleared.injected, [])
  passed += 1
  console.log('  ok  syncInjections：清空列表即可撤销设置页驱动的注入')
}

check('读能力：没有 toolkit 行返回 undefined，有则读出数组', () => {
  assert.equal(readToolkitCapabilities(SAMPLE), undefined)
  const withRow = ensureToolkitRow(SAMPLE, ['fs', 'sh', 'tasks'])
  assert.deepEqual(readToolkitCapabilities(withRow), ['fs', 'sh', 'tasks'])
})

check('读 persona：块标量与同行标量都能读出', () => {
  const block = ['- id: persona', "  name: '@deepseek-ai/dsh-persona'", '  config:', '    prefix: |', '      第一行', '      第二行', '- id: tool-fs'].join('\n')
  assert.equal(readPersonaPrefix(block), '第一行\n第二行')
  const inline = ['- id: persona', "  name: '@deepseek-ai/dsh-persona'", '  config:', '    prefix: You are an agent.', '    suffix: cwd is {{cwd}}.'].join('\n')
  assert.equal(readPersonaPrefix(inline), 'You are an agent.')
  assert.equal(readPersonaPrefix('- id: tool-fs\n  name: x\n'), undefined)
})

check('替换 persona：只换 prefix，保留同一行里的其它配置（suffix 等）', () => {
  const content = ['- id: persona', "  name: '@deepseek-ai/dsh-persona'", '  config:', '    prefix: old text', '    suffix: keep me', '- id: tool-fs', "  name: '@deepseek-ai/dsh-tool-fs'"].join('\n')
  const out = withPersonaPrefix(content, '新的人格。\n第二行。')
  assert.equal(readPersonaPrefix(out), '新的人格。\n第二行。')
  assert.match(out, /suffix: keep me/)
  const parsed = loadHarnessYaml(out)
  assert.equal(parsed[0].config.suffix, 'keep me')
  assert.equal(parsed[0].config.prefix.trim(), '新的人格。\n第二行。')
  assert.equal(parsed[1].id, 'tool-fs')
})

check('替换 persona：原本没有 persona 行时补一个', () => {
  const out = withPersonaPrefix('- id: tool-fs\n  name: x\n', '新人格')
  const parsed = loadHarnessYaml(out)
  assert.equal(parsed[0].id, 'persona')
  assert.equal(parsed[0].config.prefix.trim(), '新人格')
  assert.equal(parsed[1].id, 'tool-fs')
})

check('renderEditOverride：同时改能力与 persona，覆盖声明可解析', () => {
  const content = ['- id: persona', "  name: '@deepseek-ai/dsh-persona'", '  config:', '    prefix: old', '- id: tool-fs', "  name: '@deepseek-ai/dsh-tool-fs'"].join('\n')
  const doc = { id: 'cordis', name: '创造模式', description: '', order: 25, content }
  const block = renderEditOverride(doc, { capabilities: ['fs', 'sh'], persona: '你是改造过的 agent。' })
  const row = loadHarnessYaml(`${block}\n`)[0]
  assert.equal(row.id, 'preset-cordis')
  assert.equal(row.config.order, 25)
  const ids = row.config.plugins.map((entry) => entry.id)
  assert.deepEqual(ids, ['persona', 'tool-fs', 'toolkit'])
  assert.equal(row.config.plugins[0].config.prefix.trim(), '你是改造过的 agent。')
  assert.deepEqual(row.config.plugins[2].config.tools, ['fs', 'sh'])
})

check('真实 standard 预设：能读出它的 persona，编辑后其它行不受影响', () => {
  const { path: file } = resolveShippedFile('@deepseek-ai/dsh-web-app/presets/standard.patch.yml')
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line.trim() === '- id: preset-standard')
  const pluginsAt = lines.findIndex((line, index) => index > start && line.trim() === 'plugins:')
  let end = lines.length
  for (let index = pluginsAt + 1; index < lines.length; index += 1) {
    if (/^ {4}- id: /u.test(lines[index])) {
      end = index
      break
    }
  }
  const pluginLines = lines.slice(pluginsAt + 1, end).filter((line) => line.trim() !== '')
  const baseIndent = Math.min(...pluginLines.map((line) => (/^ */u.exec(line))[0].length))
  const content = pluginLines.map((line) => line.slice(baseIndent)).join('\n')

  const persona = readPersonaPrefix(content)
  assert.ok(typeof persona === 'string' && persona.length > 5, `应读出 persona（实际 ${String(persona)}）`)
  assert.equal(readToolkitCapabilities(content), undefined, 'standard 原本没有 toolkit 行')
  const edited = withPersonaPrefix(content, '你是被设置页改过的标准 agent。')
  assert.equal(readPersonaPrefix(edited), '你是被设置页改过的标准 agent。')
  const row = loadHarnessYaml(`${renderEditOverride({ id: 'standard', content: edited }, { capabilities: ['fs', 'sh'] })}\n`)[0]
  const toolkit = row.config.plugins.find((entry) => entry.id === 'toolkit')
  assert.deepEqual(toolkit.config.tools, ['fs', 'sh'])
  assert.ok(row.config.plugins.length > 15, '原有行都应保留')
  console.log(`      （standard 的 persona 原文 ${persona.length} 字符；编辑后仍保留 ${row.config.plugins.length} 行）`)
})

// syncFromSettings：设置页的编辑 → 覆盖声明（这正是"保存成功但没反应"的那条路径）
{
  const ctx = memoryContext()
  const declaration = [
    '- id: persona',
    "  name: '@deepseek-ai/dsh-persona'",
    '  config:',
    '    prefix: 旧的人格',
    '- id: toolkit',
    "  name: '@local/dsh-agentkit'",
    '  config:',
    '    tools: [fs, sh]'
  ].join('\n')
  ctx.get = (name) => (name === 'agentPresets'
    ? {
        readDocument: async () => ({ agentPreset: 'generic', name: '通用环境', content: declaration }),
        list: async () => [{ id: 'generic', order: 20 }]
      }
    : undefined)

  const result = await syncFromSettings(ctx, {
    capabilities: ['fs', 'sh', 'tasks'],
    injectInto: [],
    edits: { generic: { capabilities: ['fs', 'tasks'], persona: '新的人格。\n第二行。' } },
    newPreset: {}
  })
  assert.equal(result.changed, true)
  assert.deepEqual(result.edited, ['generic'])
  passed += 1
  console.log('  ok  syncFromSettings：设置页的 persona/能力编辑被同步')

  const json = JSON.parse(readStateFile('presets.generated.json'))
  assert.deepEqual(json.edits.generic, {
    capabilities: ['fs', 'tasks'], persona: '新的人格。\n第二行。', suffix: '', complete: ''
  })
  passed += 1
  console.log('  ok  syncFromSettings：编辑内容落到 presets.generated.json')

  // 覆盖声明必须是**顶层 id 条目**（不带 insert）—— 写成 insert 里的同 id 行会"追加"成重复 entry id
  const patch = readStateFile('presets.generated.patch.yml')
  const parsedPatch = loadHarnessYaml(patch)
  const override = parsedPatch.find((entry) => entry !== null && entry.id === 'preset-generic')
  assert.ok(override !== undefined, 'patch 里应有顶层覆盖条目 preset-generic')
  assert.equal(override.insert, undefined, '覆盖条目不能带 insert（那会变成追加）')
  assert.equal(override.name, '@deepseek-ai/dsh-agent-preset')
  const toolkitRow = override.config.plugins.find((entry) => entry.id === 'toolkit')
  assert.deepEqual(toolkitRow.config.tools, ['fs', 'tasks'])
  assert.equal(override.config.plugins.find((entry) => entry.id === 'persona').config.prefix.trim(), '新的人格。\n第二行。')
  passed += 1
  console.log('  ok  syncFromSettings：覆盖声明是顶层 id 条目（方言正确）')

  // 幂等：再同步一次不应重写
  const again = await syncFromSettings(ctx, {
    capabilities: ['fs', 'sh', 'tasks'],
    injectInto: [],
    edits: { generic: { capabilities: ['fs', 'tasks'], persona: '新的人格。\n第二行。' } },
    newPreset: {}
  })
  assert.equal(again.changed, false)
  passed += 1
  console.log('  ok  syncFromSettings：无变化不重写（幂等，避免重载循环）')
}

check('能力解析：内联数组与块序列都支持（harness dumper 用块序列 + 引号）', () => {
  const inline = ['- id: toolkit', '  name: x', '  config:', '    tools: [fs, sh]', ''].join('\n')
  assert.deepEqual(readToolkitCapabilities(inline), ['fs', 'sh'])
  const block = ['- id: "toolkit"', '  name: x', '  config:', '    tools:', '      - fs', '      - sh', '      - tasks', ''].join('\n')
  assert.deepEqual(readToolkitCapabilities(block), ['fs', 'sh', 'tasks'])
  assert.equal(readToolkitCapabilities(['- id: persona', '  name: x', ''].join('\n')), undefined)
})

console.log(`\n${passed} 项通过`)
