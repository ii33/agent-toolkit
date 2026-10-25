/**
 * preset_create / preset_list / preset_delete：一句话新建、列出、删除 agent 预设。
 *
 * 为什么这样实现：预设只能是 **bundle 补丁里的声明**（注册表不写入任何声明，
 * 也没有接受 YAML 写回的接口），所以这里把声明写进本 bundle 自己的
 * `presets.generated.patch.yml`（与手写的 `cordis.patch.yml` 分开）。
 * patch 文件变化会触发 HMR 重载，新预设随即出现在「新会话」的预设选择器里
 * —— 不需要 plugin_manager、不需要审批。
 *
 * 源数据放在 `presets.generated.json`（JSON 便于合并与删除），YAML 由本文件渲染，
 * 因此**不需要任何 YAML 库**，也就不引入额外依赖。
 *
 * 边界：
 *   - 只能创建/覆盖本文件生成的那批预设，**不动内置预设**（standard / cordis / minimal / ptc …）；
 *   - 新预设只对**新会话**可选（开过轮次的会话会抛 `agent-preset/locked`）。
 *
 * @module @local/dsh-agent-toolkit/tools/preset
 */
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { buildEditOverrides, buildOverrides, readPresetDocument, takeoverShippedTools } from '../lib/preset-inject.js'
import { createToolRegistrar } from './registry.js'

/**
 * 状态文件目录：默认本包根目录；测试用 `DSH_AGENTKIT_STATE_DIR` 指向临时目录，
 * 免得动到真实数据。
 */
const STATE_DIR = process.env.DSH_AGENTKIT_STATE_DIR ?? fileURLToPath(new URL('..', import.meta.url))

/** 生成物路径。 */
const YAML_FILE = join(STATE_DIR, 'presets.generated.patch.yml')
const JSON_FILE = join(STATE_DIR, 'presets.generated.json')

/**
 * 读插件自己的文本文件。
 *
 * **为什么不用 ctx.fs**：宿主行没有会话上下文，`ctx.fs` 会按默认策略（workspace-write）判定，
 * 写包内文件会被拒 —— 实测日志：`cannot write "…presets.generated.json": file access denied
 * under workspace-write mode`。这些是插件自己的数据文件、不是模型操作，所以直接走 node:fs，
 * 不受模型沙箱约束（也与离线脚本的行为一致）。
 * @param {string} path - 绝对路径。
 * @returns {string|undefined} 内容；文件不存在时 undefined。
 */
function readOwn(path) {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined
  } catch {
    return undefined
  }
}

/**
 * 写插件自己的文本文件（UTF-8，必要时建目录）。
 * @param {string} path - 绝对路径。
 * @param {string} text - 内容。
 */
function writeOwn(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, 'utf8')
}

/** 本包名（preset 行要引用它）。 */
const PACKAGE_NAME = '@local/dsh-agentkit'

/**
 * 可选能力名：**必须与 index.js 的 `CAPABILITIES` 键一一对应**（那里是唯一事实来源）。
 * 这里不能 `import` index.js 取键——index.js 反过来 import 本模块，会形成循环依赖，
 * 所以这是同一份名单的显式副本；改 index.js 的能力表时必须同步这里。
 */
const CAPABILITIES = ['fs', 'sftp', 'run', 'sh', 'pwsh', 'env', 'proxy', 'doc', 'split', 'img', 'tasks', 'guard', 'preset']

/** 内置/他人预设 id：一律不许覆盖（避免把出货预设写坏）。 */
const PROTECTED_IDS = ['standard', 'ptc', 'minimal', 'cordis', 'translate', 'local', 'doc-split', 'doc-translate', 'doc-layout', 'doc-pack', 'generic']

/** 合法预设 id。 */
const ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/

/**
 * YAML 双引号字符串。
 * @param {string} value - 原值。
 * @returns {string} 带引号的 YAML 标量。
 */
function yamlString(value) {
  return `"${String(value).replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`
}

/**
 * 渲染整份 generated patch。
 * @param {{presets: object[]}} state - 源数据。
 * @returns {string} patch 文件内容。
 */
export function renderPatch(state, overrides = []) {
  const header = [
    '# 本文件由 preset_create / preset_delete 生成，手改会在下次写入时被覆盖。',
    '# 源数据：presets.generated.json（改那个文件更安全）。'
  ]
  const lines = [...header, '- insert:']
  if (state.presets.length === 0 && overrides.length === 0) {
    lines.push('    []')
    return `${lines.join('\n')}\n`
  }
  if (state.presets.length === 0) {
    // 只有顶层覆盖声明（`- id: preset-<x>`）时，插入列表必须显式写成空数组：
    // 裸写 `- insert:` 解析出来是 null，Loader 会当成"缺 id 的普通补丁"警告并跳过
    // （实测日志：patch: id is required for non-insert patches），补丁文件也看着像坏了。
    return `${[...header, '- insert: []', ...overrides].join('\n')}\n`
  }
  for (const preset of state.presets) {
    lines.push(
      `    - id: preset-${preset.id}`,
      "      name: '@deepseek-ai/dsh-agent-preset'",
      '      config:',
      `        id: ${preset.id}`,
      `        name: ${yamlString(preset.name)}`,
      `        description: ${yamlString(preset.description)}`,
      `        order: ${preset.order}`,
      '        plugins:',
      '          - id: persona',
      "            name: '@deepseek-ai/dsh-persona'",
      '            config:',
      '              complete: true',
      '              includeRuntimeContext: true',
      '              prefix: |'
    )
    for (const line of preset.prompt.split('\n')) lines.push(`                ${line}`.trimEnd())
    lines.push(
      '              suffix: |',
      '                当前工作目录是 {{cwd}}；相对路径都以它为基准。',
      '          - id: toolkit',
      `            name: '${PACKAGE_NAME}'`,
      '            config:',
      `              tools: [${preset.capabilities.join(', ')}]`,
      '          - id: web-tools',
      "            name: '@deepseek-ai/dsh-tool-web'",
      '            config:',
      '              fetch: true',
      '              searchTimeoutMs: 60000',
      '          - id: compaction',
      '            name: cordis:group',
      '            group: true',
      '            isolate:',
      '              compaction: true',
      '              toolResultPruner: true',
      '            config:',
      '              - id: compaction-basic',
      "                name: '@deepseek-ai/dsh-compaction-basic'",
      '              - id: tool-result-pruner',
      "                name: '@deepseek-ai/dsh-compaction-tool-result-pruner'",
      '                config:',
      '                  thresholdChars: 8192',
      '                  headChars: 4096',
      '                  tailChars: 1024'
    )
  }
  for (const block of overrides) lines.push(block)
  return `${lines.join('\n')}\n`
}

/** 默认提示词：让新建的预设立刻可用。 */
function defaultPrompt(name, capabilities) {
  return [
    `你是「${name}」agent，运行在 Windows 上。`,
    '',
    '可用工具',
    `- 文件读写：read / write / edit / list_dir（编码、换行、字符集自动处理；写回按原字符集）。`,
    ...(capabilities.includes('sh') || capabilities.includes('pwsh') ? ['- shell：sh（bash）、pwsh（PowerShell 7）；Windows PowerShell 5.1 与 cmd 已禁用。'] : []),
    ...(capabilities.includes('tasks') ? ['- 任务面板：plan_init / task_update / task_show / stage_set。'] : []),
    ...(capabilities.includes('sftp') ? ['- 远程主机：sftp_hosts 列出代号；路径写成 `代号:/远程/路径`。'] : []),
    '',
    '纪律',
    '1. 多步任务先 plan_init 写下清单，每推进一步立刻 task_update。',
    '2. 大文件先看总行数再分段读，一次只把一小块放进上下文。',
    '3. 结果写盘后只回报路径与要点，不复述正文。'
  ].join('\n')
}

/**
 * 读生成物源数据。
 * @param {object} ctx - 插件上下文。
 * @param {object} exec - 工具执行上下文。
 * @returns {Promise<{presets: object[]}>} 源数据。
 */
async function readState(ctx, exec) {
  const text = readOwn(JSON_FILE)
  if (text === undefined) return { presets: [], inject: [], edits: {} }
  try {
    const parsed = JSON.parse(text)
    const presets = Array.isArray(parsed?.presets) ? parsed.presets : []
    // 注入项：把现有预设变成"原样 + 工具集"
    const inject = Array.isArray(parsed?.inject)
      ? parsed.inject.filter((item) => item !== null && typeof item?.preset === 'string'
        && Array.isArray(item?.capabilities) && item.capabilities.length > 0)
      : []
    // 精确编辑：预设 id → { capabilities, persona }
    const edits = parsed?.edits !== null && typeof parsed?.edits === 'object' && !Array.isArray(parsed.edits)
      ? parsed.edits
      : {}
    return { presets, inject, edits }
  } catch {
    return { presets: [], inject: [], edits: {} }
  }
}

/** 主补丁（手写）。HMR 只认它的**内容变化**——实测 mtime 变化不算。 */
const PRIMARY_FILE = join(STATE_DIR, 'cordis.patch.yml')

/**
 * 触发一次重载：在主补丁里更新一行时间戳注释。
 * 生成的补丁文件本身不在 HMR 的监视范围里，所以必须让主补丁的内容变一下，
 * 否则新预设要等到下次重启才出现。
 * @param {object} ctx - 插件上下文。
 * @param {object} exec - 工具执行上下文。
 * @returns {Promise<void>} 完成。
 */
async function kickReload(ctx, exec) {
  const text = readOwn(PRIMARY_FILE)
  if (text === undefined) return
  const marker = /^# preset_create: .*$/mu
  const line = `# preset_create: ${new Date().toISOString()}`
  const next = marker.test(text)
    ? text.replace(marker, line)
    : `${text.replace(/\s*$/u, '')}\n${line}\n`
  writeOwn(PRIMARY_FILE, next)
}

/**
 * 写生成物（JSON 源数据 + YAML patch），并触发重载。
 * @param {object} ctx - 插件上下文。
 * @param {object} exec - 工具执行上下文。
 * @param {{presets: object[]}} state - 源数据。
 * @returns {Promise<void>} 完成。
 */
async function writeState(ctx, exec, state) {
  // 覆盖声明用**正确的 Loader 方言**：顶层条目 `- id: preset-<x>`（**不带 insert**）才会命中并替换
  // 已存在的行；写进 `insert:` 里的同 id 行只会"追加" → 组合后的 profile 出现重复 entry id
  // （实测 `duplicate loader entry id "preset-generic"` → 应用进恢复模式）。
  const edits = state.edits ?? {}
  const editedIds = new Set(Object.keys(edits))
  const overrides = [
    ...(await buildOverrides(ctx, (state.inject ?? []).filter((item) => !editedIds.has(item.preset)), (message) => ctx.logger?.info(message))),
    ...(await buildEditOverrides(ctx, edits, (message) => ctx.logger?.info(message)))
  ]
  if (overrides.length > 0) {
    ctx.logger?.info(`agent-toolkit: 写入 ${overrides.length} 条覆盖声明（顶层 id 条目，不带 insert）`)
  }
  writeOwn(JSON_FILE, `${JSON.stringify(state, null, 2)}\n`)
  writeOwn(YAML_FILE, renderPatch(state, overrides))
  await kickReload(ctx, exec)
}

/**
 * 按设置页的 `inject_into` 同步注入项（宿主行调用）。
 * 只管理 `source === 'settings'` 的条目；用 preset_inject 工具手动注入的保持不动。
 * 没有任何变化时不写文件。
 * @param {object} ctx - 插件上下文。
 * @param {string[]} presetIds - 要注入的预设 id 列表。
 * @param {string[]} capabilities - 注入时挂载的能力（一般取设置页里打开的那些）。
 * @returns {Promise<{changed: boolean, injected: string[]}>} 结果。
 */
export async function syncInjections(ctx, presetIds, capabilities) {
  const exec = {}
  const state = await readState(ctx, exec)
  const wanted = (Array.isArray(presetIds) ? presetIds : [])
    .filter((id) => typeof id === 'string' && id.trim() !== '')
    .map((id) => id.trim())
  const enabled = Array.isArray(capabilities) ? capabilities : []
  const manual = state.inject.filter((item) => item.source !== 'settings')
  const synced = enabled.length === 0
    ? []
    : wanted.map((id) => ({ preset: id, capabilities: enabled, source: 'settings' }))
  const next = [...manual, ...synced]
  if (JSON.stringify(next) === JSON.stringify(state.inject)) {
    return { changed: false, injected: next.map((item) => item.preset) }
  }
  state.inject = next
  await writeState(ctx, exec, state)
  return { changed: true, injected: next.map((item) => item.preset) }
}

/**
 * 按设置页同步三件事：注入项、按预设的精确编辑、从设置页新建预设。
 * 全部幂等：内容没变就不写文件（避免重载循环）。
 * @param {object} ctx - 插件上下文。
 * @param {{capabilities?: string[], injectInto?: string[], edits?: Record<string, object>, newPreset?: object}} wanted - 设置页内容。
 * @returns {Promise<{changed: boolean, injected: string[], edited: string[], created: string[]}>} 结果。
 */
export async function syncFromSettings(ctx, wanted) {
  const exec = {}
  const state = await readState(ctx, exec)
  const enabled = Array.isArray(wanted?.capabilities) ? wanted.capabilities : []
  const ids = (Array.isArray(wanted?.injectInto) ? wanted.injectInto : [])
    .filter((id) => typeof id === 'string' && id.trim() !== '')
    .map((id) => id.trim())

  // 精确编辑：只保留真正有内容的项
  const rawEdits = wanted?.edits !== null && typeof wanted?.edits === 'object' && !Array.isArray(wanted?.edits)
    ? wanted.edits
    : {}
  const edits = {}
  for (const [id, edit] of Object.entries(rawEdits)) {
    if (typeof id !== 'string' || id.trim() === '') continue
    const capabilities = Array.isArray(edit?.capabilities) ? edit.capabilities : []
    const persona = typeof edit?.persona === 'string' ? edit.persona : ''
    const suffix = typeof edit?.suffix === 'string' ? edit.suffix : ''
    const complete = typeof edit?.complete === 'string' ? edit.complete : ''
    if (capabilities.length === 0 && persona.trim() === '' && suffix.trim() === '' && complete === '') continue
    edits[id.trim()] = { capabilities, persona, suffix, complete }
  }

  const manual = (state.inject ?? []).filter((item) => item.source !== 'settings')
  const synced = enabled.length === 0 ? [] : ids.map((id) => ({ preset: id, capabilities: enabled, source: 'settings' }))
  const nextInject = [...manual, ...synced]

  // 从设置页新建预设（同 id 覆盖，幂等）
  const presets = [...(state.presets ?? [])]
  const created = []
  const np = wanted?.newPreset
  const newId = typeof np?.id === 'string' ? np.id.trim() : ''
  if (newId !== '' && ID_PATTERN.test(newId) && !PROTECTED_IDS.includes(newId)) {
    const capabilities = Array.isArray(np.capabilities) && np.capabilities.length > 0 ? np.capabilities : ['fs', 'sh', 'tasks']
    const entry = {
      id: newId,
      name: typeof np.name === 'string' && np.name.trim() !== '' ? np.name.trim() : newId,
      description: typeof np.description === 'string' && np.description.trim() !== '' ? np.description.trim() : `自定义预设 ${newId}`,
      order: Number.isFinite(np.order) ? Math.trunc(np.order) : 30,
      capabilities,
      prompt: typeof np.persona === 'string' && np.persona.trim() !== '' ? np.persona : defaultPrompt(newId, capabilities)
    }
    const at = presets.findIndex((item) => item.id === newId)
    if (at === -1) {
      presets.push(entry)
      created.push(newId)
    } else if (JSON.stringify(presets[at]) !== JSON.stringify(entry)) {
      presets[at] = entry
      created.push(newId)
    }
  }

  const same = JSON.stringify(state.presets ?? []) === JSON.stringify(presets)
    && JSON.stringify(state.inject ?? []) === JSON.stringify(nextInject)
    && JSON.stringify(state.edits ?? {}) === JSON.stringify(edits)
  if (same) {
    return { changed: false, injected: nextInject.map((item) => item.preset), edited: Object.keys(edits), created: [] }
  }
  await writeState(ctx, exec, { presets, inject: nextInject, edits })
  return { changed: true, injected: nextInject.map((item) => item.preset), edited: Object.keys(edits), created }
}

/**
 * 列出注册表里现有的预设 id，用于报错时让模型自我纠正。
 * @param {object} ctx - 插件上下文。
 * @returns {Promise<string>} 形如 `；可用预设：a / b / c`，取不到时为空串。
 */
async function availablePresetHint(ctx) {
  try {
    const registry = ctx.get('agentPresets')
    if (registry === undefined) return ''
    const rows = await registry.list()
    const ids = Array.isArray(rows)
      ? rows.map((row) => row?.id).filter((id) => typeof id === 'string' && id !== '')
      : []
    return ids.length === 0 ? '' : `；可用预设：${ids.join(' / ')}`
  } catch {
    return ''
  }
}

/**
 * 补丁文件里是否真的出现了某个预设的覆盖条目（`- id: preset-<id>`）。
 * 用于写入后兜底核对：注入是否**真的落到产物上**，而不是只在状态里记了一笔。
 * @param {object} ctx - 插件上下文。
 * @param {object} exec - 工具执行上下文。
 * @param {string} id - 预设 id。
 * @returns {Promise<boolean>} 出现即为 true。
 */
async function patchMentionsPreset(ctx, exec, id) {
  const text = readOwn(YAML_FILE)
  if (typeof text !== 'string' || text === '') return false
  return new RegExp(`^-\\s*id:\\s*['"]?preset-${id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}['"]?\\s*$`, 'mu').test(text)
}

/**
 * 读一个**必须存在**的预设声明：读不到就抛错，并列出可选 id。
 * 纯只读、无副作用 —— 供会在写入前校验的工具（preset_inject）使用，
 * 避免"注册表读不到 → buildOverrides 静默跳过 → patch 仍是空的，却回报成功"。
 * @param {object} ctx - 插件上下文。
 * @param {string} id - 预设 id。
 * @returns {Promise<object>} {@link readPresetDocument} 的结果。
 */
async function requirePresetDocument(ctx, id) {
  // 先按注册表清单判存在性：`readDocument` 对未知 id 是抛错还是返回空文档，取决于装机实现，
  // 不能只靠它兜底。清单里没有就一定不存在，直接报错（不依赖任何异常语义）。
  try {
    const registry = ctx.get('agentPresets')
    if (registry !== undefined && typeof registry.list === 'function') {
      const rows = await registry.list()
      if (Array.isArray(rows)) {
        const ids = rows.map((row) => row?.id).filter((value) => typeof value === 'string' && value !== '')
        if (ids.length > 0 && !ids.includes(id)) {
          throw new Error(`预设 "${id}" 不存在或读不到：注册表里没有这个 id；可用预设：${ids.join(' / ')}`)
        }
      }
    }
  } catch (error) {
    // 上面主动抛出的"不存在"要原样冒出去；只有清单本身取不到时才继续用 readDocument 兜底。
    if (error instanceof Error && error.message.startsWith('预设 "')) throw error
  }
  try {
    return await readPresetDocument(ctx, id)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`预设 "${id}" 不存在或读不到：${message}${await availablePresetHint(ctx)}`)
  }
}

/**
 * 挂载预设管理工具。
 * @param {object} ctx - 插件上下文。
 */
export function apply(ctx) {
  const register = createToolRegistrar(ctx)
  register({
    name: 'preset_create',
    description: '新建或覆盖一个 agent 预设：写入本插件的 presets.generated.patch.yml，重载后出现在「新会话」的预设选择器里。'
      + '只能创建自己的预设，不能改内置预设；新预设只对新会话可选。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '预设 id：小写字母开头，只含小写字母/数字/连字符，如 fast-edit。' },
        name: { type: 'string', description: '用户看到的名字，如「快速编辑」。' },
        description: { type: 'string', description: '一句话说明这个预设的用途。' },
        capabilities: {
          type: 'array',
          items: { type: 'string', enum: CAPABILITIES },
          description: `要挂载的能力，可选：${CAPABILITIES.join(' / ')}。`
        },
        prompt: { type: 'string', description: '整份系统提示词；省略时按能力生成一份默认的。' },
        order: { type: 'number', description: '在预设列表里的排序，默认 30。' },
        replace: { type: 'boolean', description: '同 id 已存在时是否覆盖，默认 false。' }
      },
      required: ['id', 'name', 'capabilities']
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          replaced: { type: 'boolean' },
          file: { type: 'string' },
          presets: { type: 'array', items: { type: 'string' } },
          note: { type: 'string' }
        },
        required: ['id', 'replaced', 'file', 'presets', 'note']
      },
      render: (_args, value) => [{
        type: 'text',
        text: `<preset id="${value.id}" replaced="${value.replaced}" file="${value.file}"/>\n`
          + `现有自定义预设：${value.presets.join(', ') || '（无）'}\n${value.note}`
      }]
    },
    async execute(args, exec) {
      const id = typeof args?.id === 'string' ? args.id.trim() : ''
      if (!ID_PATTERN.test(id)) throw new Error(`预设 id 不合法：${id || '(空)'}（小写字母开头，只含小写字母/数字/连字符，≤32 字符）`)
      if (PROTECTED_IDS.includes(id)) throw new Error(`"${id}" 是内置或他人预设的 id，不能占用；换一个 id（例如 ${id}-x）`)
      const capabilities = Array.isArray(args?.capabilities) ? args.capabilities : []
      if (capabilities.length === 0) throw new Error(`capabilities 不能为空；可选：${CAPABILITIES.join(' / ')}`)
      const unknown = capabilities.filter((name) => !CAPABILITIES.includes(name))
      if (unknown.length > 0) throw new Error(`未知能力 ${unknown.join(', ')}；可选：${CAPABILITIES.join(' / ')}`)
      const name = typeof args?.name === 'string' && args.name.trim() !== '' ? args.name.trim() : id
      const description = typeof args?.description === 'string' ? args.description.trim() : `自定义预设 ${name}`
      const order = Number.isFinite(args?.order) ? Math.trunc(args.order) : 30
      const prompt = typeof args?.prompt === 'string' && args.prompt.trim() !== ''
        ? args.prompt
        : defaultPrompt(name, capabilities)

      const state = await readState(ctx, exec)
      const index = state.presets.findIndex((entry) => entry.id === id)
      const replaced = index !== -1
      if (replaced && args?.replace !== true) {
        throw new Error(`预设 "${id}" 已存在；要覆盖请传 replace=true`)
      }
      const entry = { id, name, description, order, capabilities, prompt }
      if (replaced) state.presets[index] = entry
      else state.presets.push(entry)
      await writeState(ctx, exec, state)
      return {
        id,
        replaced,
        file: YAML_FILE,
        presets: state.presets.map((item) => item.id),
        note: '已写入；patch 变化会触发重载，之后在「新会话」的预设选择器里可见（已开过轮次的会话不可切换）。'
      }
    }
  })

  register({
    name: 'preset_list',
    description: '列出本插件生成的自定义预设（含能力组合与提示词长度）。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          lines: { type: 'array', items: { type: 'string' } },
          file: { type: 'string' }
        },
        required: ['lines', 'file']
      },
      render: (_args, value) => [{ type: 'text', text: `<presets file="${value.file}"/>\n${value.lines.join('\n')}` }]
    },
    async execute(_args, exec) {
      const state = await readState(ctx, exec)
      const lines = state.presets.map((item) => `- ${item.id}（${item.name}，order ${item.order}）能力：${item.capabilities.join(', ')}；提示词 ${item.prompt.length} 字符`)
      for (const item of state.inject) lines.push(`- [注入] ${item.preset} ← 工具集能力：${item.capabilities.join(', ')}`)
      return { file: YAML_FILE, lines }
    }
  })

  register({
    name: 'preset_delete',
    description: '删除一个由本插件生成的自定义预设。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { id: { type: 'string', description: '要删除的预设 id。' } },
      required: ['id']
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          removed: { type: 'boolean' },
          presets: { type: 'array', items: { type: 'string' } },
          file: { type: 'string' }
        },
        required: ['removed', 'presets', 'file']
      },
      render: (_args, value) => [{
        type: 'text',
        text: `<presets removed="${value.removed}" file="${value.file}"/>\n剩余：${value.presets.join(', ') || '（无）'}`
      }]
    },
    async execute(args, exec) {
      const id = typeof args?.id === 'string' ? args.id.trim() : ''
      const state = await readState(ctx, exec)
      const before = state.presets.length
      state.presets = state.presets.filter((entry) => entry.id !== id)
      const removed = state.presets.length !== before
      if (removed) await writeState(ctx, exec, state)
      return { removed, presets: state.presets.map((entry) => entry.id), file: YAML_FILE }
    }
  })

  register({
    name: 'preset_inject',
    description: '把通用 agent 工具集注入一个**已存在的预设**：用注册表读它的声明，插入（或替换）toolkit 行，再写成覆盖声明 —— 效果是"原样 + 工具集"。'
      + '出货预设（standard / ptc / minimal / cordis / generic）与流水线预设都可以；每次写入都会重新读取该预设的最新声明，所以出货预设更新后重新注入一次即可跟上。'
      + '预设 id 不存在时会直接报错并列出可选 id，**不会**写入任何东西。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        preset: { type: 'string', description: '要注入的预设 id，如 standard / ptc / minimal / cordis / generic。' },
        capabilities: {
          type: 'array',
          items: { type: 'string', enum: CAPABILITIES },
          description: `要挂载的能力，可选：${CAPABILITIES.join(' / ')}。`
        }
      },
      required: ['preset', 'capabilities']
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          preset: { type: 'string' },
          replaced: { type: 'boolean' },
          capabilities: { type: 'array', items: { type: 'string' } },
          injected: { type: 'array', items: { type: 'string' } },
          notes: { type: 'array', items: { type: 'string' } },
          file: { type: 'string' }
        },
        required: ['preset', 'replaced', 'capabilities', 'injected', 'notes', 'file']
      },
      render: (_args, value) => [{
        type: 'text',
        text: `<preset_inject preset="${value.preset}" replaced="${value.replaced}" file="${value.file}"/>\n`
          + `能力：${value.capabilities.join(', ')}\n已注入的预设：${value.injected.join(', ') || '（无）'}\n`
          + (value.notes.length === 0 ? '' : `接管说明：${value.notes.join('；')}\n`)
          + '重载后，该预设 = 原样 + 工具集（在「新会话」里可选）。'
      }]
    },
    async execute(args, exec) {
      const preset = typeof args?.preset === 'string' ? args.preset.trim() : ''
      if (preset === '') throw new Error('preset 不能为空')
      const capabilities = Array.isArray(args?.capabilities) ? args.capabilities : []
      if (capabilities.length === 0) throw new Error(`capabilities 不能为空；可选：${CAPABILITIES.join(' / ')}`)
      const unknown = capabilities.filter((name) => !CAPABILITIES.includes(name))
      if (unknown.length > 0) throw new Error(`未知能力 ${unknown.join(', ')}；可选：${CAPABILITIES.join(' / ')}`)
      // **先校验预设真的存在**（纯只读）——否则 buildOverrides 会静默跳过读不到的 id，
      // patch 保持 `- insert: []`，工具却回报成功：用户以为注入生效了。
      const doc = await requirePresetDocument(ctx, preset)
      // 接管哪些出货工具、在出货那一行关了哪些开关 —— 让结果自解释（重名撞车会把整份预设打成 broken）。
      const notes = takeoverShippedTools(doc.content, capabilities).notes
      const state = await readState(ctx, exec)
      const index = state.inject.findIndex((item) => item.preset === preset)
      const replaced = index !== -1
      const entry = { preset, capabilities }
      const previous = state.inject[index]
      if (replaced) state.inject[index] = entry
      else state.inject.push(entry)
      await writeState(ctx, exec, state)
      // **兜底：以产物为准。** 注册表清单不可用时（`list()` 抛错）上面那道校验无从判断，
      // 而 buildOverrides 又会静默跳过读不到的 id。所以再确认补丁里确实出现了该预设的覆盖条目；
      // 没有就回滚状态并报错 —— 绝不回报"成功但什么都没发生"。
      if (!(await patchMentionsPreset(ctx, exec, preset))) {
        if (replaced) state.inject[index] = previous
        else state.inject = state.inject.filter((item) => item.preset !== preset)
        await writeState(ctx, exec, state)
        throw new Error(`预设 "${preset}" 无法注入：读不到它的声明，补丁里没有生成覆盖条目（已回滚，未改动任何状态）。`
          + await availablePresetHint(ctx))
      }
      return {
        preset,
        replaced,
        capabilities,
        injected: state.inject.map((item) => item.preset),
        notes,
        file: YAML_FILE
      }
    }
  })

  register({
    name: 'preset_eject',
    description: '撤掉某个预设的工具集注入（该预设回到原来的声明）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { preset: { type: 'string', description: '要撤销注入的预设 id。' } },
      required: ['preset']
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          preset: { type: 'string' },
          removed: { type: 'boolean' },
          injected: { type: 'array', items: { type: 'string' } },
          file: { type: 'string' }
        },
        required: ['preset', 'removed', 'injected', 'file']
      },
      render: (_args, value) => [{
        type: 'text',
        text: `<preset_eject preset="${value.preset}" removed="${value.removed}"/>\n剩余注入：${value.injected.join(', ') || '（无）'}`
      }]
    },
    async execute(args, exec) {
      const preset = typeof args?.preset === 'string' ? args.preset.trim() : ''
      if (preset === '') throw new Error('preset 不能为空')
      const state = await readState(ctx, exec)
      const before = state.inject.length
      state.inject = state.inject.filter((item) => item.preset !== preset)
      const removed = state.inject.length !== before
      if (removed) await writeState(ctx, exec, state)
      return { preset, removed, injected: state.inject.map((item) => item.preset), file: YAML_FILE }
    }
  })
}
