/**
 * 文件账本式任务管理：plan_init、task_update、task_show、stage_set。
 *
 * 设计要点（长任务稳定性）：
 *   - 账本是工作区里的一个 Markdown 文件，人和模型都能读、能手改，跨重启存活；
 *   - 每次模型请求都把「压缩后的任务面板」作为动态上下文注入（不是消息、不写日志，
 *     因此被上下文压缩也不会丢），模型任何时候都知道目标 / 进度 / 下一步；
 *   - 面板按 agent 隔离：`assembleContextFor` 把 agent 同时作为 assemble 的 scope，
 *     所以注入回调拿到的 `scope` 就是 Agent 对象，可直接当 WeakMap 键。
 *
 * @module @local/dsh-doc-pipeline/tasks
 */
import { currentPolicy, requireString, resolveOptions } from '../lib/fs-common.js'
import { createToolRegistrar } from './registry.js'

/** 需要 tools、fs 与 systemPrompt。 */
export const inject = ['tools', 'fs', 'systemPrompt']

/**
 * 账本默认相对路径（相对会话工作目录）。
 * 放在工作区根目录是为了人和模型都容易看到；写入时父目录会自动创建
 * （本地 fs 后端在写前 `mkdir(dirname, {recursive:true})`），所以换成
 * 子目录路径（如 `out/TASKS.md`）同样可用。
 */
const DEFAULT_LEDGER = 'TASKS.md'

/** 注入面板的字符上限，避免吃掉宝贵的上下文。 */
const PANEL_MAX_CHARS = 700

/** 面板里逐条列出的任务行上限。 */
const PANEL_MAX_TASK_LINES = 6

/** task_show 返回原文的字符上限。 */
const FULL_MAX_CHARS = 4000

/** 每个 agent 的账本镜像：{ relPath, panel }。 */
const agents = new WeakMap()

/** 状态 ↔ 复选框字符。 */
const STATUS_CHAR = { todo: ' ', doing: '~', done: 'x', blocked: '!' }
const CHAR_STATUS = { ' ': 'todo', '~': 'doing', 'x': 'done', '!': 'blocked' }

/**
 * 解析账本文本；无法识别的行被忽略，因此手写注释不会破坏解析。
 * @param {string} text - 账本原文。
 * @returns {{goal: string, stage: string, tasks: Array<{id: number, status: string, text: string, note?: string}>}} 解析结果。
 */
export function parseLedger(text) {
  const result = { goal: '', stage: '', tasks: [] }
  for (const line of text.replace(/\r\n|\r/g, '\n').split('\n')) {
    const goal = /^goal:\s*(.*)$/.exec(line)
    if (goal !== null) {
      result.goal = goal[1].trim()
      continue
    }
    const stage = /^stage:\s*(.*)$/.exec(line)
    if (stage !== null) {
      result.stage = stage[1].trim()
      continue
    }
    const task = /^- \[([ x~!])\] #(\d+)\s+(.*)$/.exec(line)
    if (task === null) continue
    const body = task[3]
    const separator = body.indexOf(' | ')
    const entry = {
      id: Number(task[2]),
      status: CHAR_STATUS[task[1]] ?? 'todo',
      text: (separator === -1 ? body : body.slice(0, separator)).trim()
    }
    if (separator !== -1) {
      const note = body.slice(separator + 3).trim()
      if (note !== '') entry.note = note
    }
    result.tasks.push(entry)
  }
  return result
}

/**
 * 序列化账本为 Markdown（LF 换行，末尾带换行）。
 * @param {{goal: string, stage: string, tasks: Array<object>}} ledger - 账本对象。
 * @returns {string} 文件内容。
 */
export function serializeLedger(ledger) {
  const lines = ['# 任务面板', `goal: ${ledger.goal}`, `stage: ${ledger.stage}`]
  for (const task of ledger.tasks) {
    const note = task.note === undefined || task.note === '' ? '' : ` | ${task.note}`
    lines.push(`- [${STATUS_CHAR[task.status] ?? ' '}] #${task.id} ${task.text}${note}`)
  }
  return `${lines.join('\n')}\n`
}

/**
 * 生成注入用的紧凑面板。
 * @param {{goal: string, stage: string, tasks: Array<object>}} ledger - 账本对象。
 * @param {string} relPath - 账本路径，写在首行供模型定位。
 * @returns {string} 面板文本；空账本返回空串。
 */
export function buildPanel(ledger, relPath) {
  if (ledger.tasks.length === 0 && ledger.goal === '') return ''
  const done = ledger.tasks.filter((task) => task.status === 'done').length
  const active = ledger.tasks.filter((task) => task.status === 'doing' || task.status === 'blocked')
  const next = ledger.tasks.find((task) => task.status === 'todo')
  const lines = [`任务面板（${relPath}）`]
  if (ledger.goal !== '') lines.push(`目标: ${ledger.goal}`)
  if (ledger.stage !== '') lines.push(`阶段: ${ledger.stage}`)
  const visible = ledger.tasks.length <= PANEL_MAX_TASK_LINES
    ? ledger.tasks
    : [...active, ...ledger.tasks.filter((task) => task.status === 'todo')].slice(0, PANEL_MAX_TASK_LINES)
  for (const task of visible) {
    const mark = task.status === 'done' ? 'x' : task.status === 'doing' ? '~' : task.status === 'blocked' ? '!' : ' '
    const note = task.note === undefined ? '' : ` | ${task.note}`
    lines.push(`[${mark}] #${task.id} ${task.text}${note}`)
  }
  if (visible.length < ledger.tasks.length) lines.push(`…另有 ${ledger.tasks.length - visible.length} 项，用 task_show 查看`)
  lines.push(`进度: ${done}/${ledger.tasks.length} 完成${active.length > 0 ? `，${active.length} 项进行中/受阻` : ''}`)
  if (next !== undefined) lines.push(`下一步: #${next.id} ${next.text}`)
  const panel = lines.join('\n')
  return panel.length > PANEL_MAX_CHARS ? `${panel.slice(0, PANEL_MAX_CHARS)}…` : panel
}

/**
 * 读取账本；不存在时返回空账本。
 * @param {object} ctx - 插件上下文。
 * @param {object} exec - 工具执行上下文，或等价的 `{agent, signal}`。
 * @param {string} relPath - 账本相对路径。
 * @returns {Promise<{target: object, ledger: object, text: string, exists: boolean}>} 读取结果。
 */
async function readLedger(ctx, exec, relPath) {
  const policy = currentPolicy(ctx, exec)
  const target = await ctx.fs.resolve(relPath, resolveOptions(exec, policy?.workspaceRoot, ctx))
  const info = await ctx.fs.stat(target, exec.signal)
  if (info === undefined || info.type !== 'file') {
    return { target, ledger: { goal: '', stage: '', tasks: [] }, text: '', exists: false }
  }
  const text = await ctx.fs.readText(target, exec.signal)
  return { target, ledger: parseLedger(text), text, exists: true }
}

/**
 * 写回账本并刷新该 agent 的面板镜像。
 * @param {object} ctx - 插件上下文。
 * @param {object} exec - 工具执行上下文。
 * @param {object} target - 已解析的 FsTarget。
 * @param {object} ledger - 账本对象。
 * @param {string} relPath - 账本相对路径。
 * @returns {Promise<string>} 注入用的面板文本。
 */
async function writeLedger(ctx, exec, target, ledger, relPath) {
  const policy = currentPolicy(ctx, exec)
  const intent = await ctx.waterfall('fs/write-intent', target, exec, () => undefined)
  const outcome = await ctx.fs.writeText(target, serializeLedger(ledger), intent, exec.signal, policy)
  ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
  const panel = buildPanel(ledger, relPath)
  if (exec.agent !== undefined) agents.set(exec.agent, { relPath, panel })
  return panel
}

/**
 * 该 agent 当前使用的账本路径。
 * @param {object} exec - 工具执行上下文。
 * @returns {string} 账本相对路径。
 */
function ledgerPathFor(exec) {
  const known = exec.agent === undefined ? undefined : agents.get(exec.agent)
  return known?.relPath ?? DEFAULT_LEDGER
}

/**
 * 定义 plan_init。
 * @param {object} ctx - 插件上下文。
 * @returns {object} 工具定义。
 */
function planInitDefinition(ctx) {
  return {
    name: 'plan_init',
    description: '建立或重置任务面板：写下总目标与有序任务清单，之后用 task_update 推进。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        goal: { type: 'string', description: '本次工作的总目标，一句话。' },
        tasks: { type: 'array', items: { type: 'string' }, description: '任务清单，按执行顺序排列，每条一句话。' },
        stage: { type: 'string', description: '当前阶段标签，如 `2/4 OCR+翻译`。省略则按 `1/N 第一条` 生成。' },
        path: { type: 'string', description: `账本文件路径（所在目录必须已存在）。默认 ${DEFAULT_LEDGER}。` }
      },
      required: ['goal', 'tasks']
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          count: { type: 'integer' },
          panel: { type: 'string' }
        },
        required: ['path', 'count', 'panel']
      },
      render: (_args, value) => [{ type: 'text', text: `已写入任务面板 ${value.path}（${value.count} 项）\n\n${value.panel}` }]
    },
    async execute(args, exec) {
      const goal = requireString(args?.goal, 'goal')
      if (!Array.isArray(args?.tasks) || args.tasks.length === 0) throw new Error('tasks 必须是非空字符串数组')
      const texts = args.tasks.map((item, index) => requireString(item, `tasks[${index}]`))
      const relPath = typeof args?.path === 'string' && args.path.trim() !== '' ? args.path : DEFAULT_LEDGER
      const stage = typeof args?.stage === 'string' && args.stage.trim() !== '' ? args.stage.trim() : `1/${texts.length} ${texts[0]}`
      const ledger = {
        goal,
        stage,
        tasks: texts.map((text, index) => ({ id: index + 1, status: 'todo', text }))
      }
      const policy = currentPolicy(ctx, exec)
      const target = await ctx.fs.resolve(relPath, resolveOptions(exec, policy?.workspaceRoot, ctx))
      const panel = await writeLedger(ctx, exec, target, ledger, relPath)
      return { path: target.displayPath, count: ledger.tasks.length, panel }
    },
    presentCall(args) {
      return { card: 'generic', title: `建立任务面板（${args.tasks?.length ?? 0} 项）`, kind: 'edit' }
    }
  }
}

/**
 * 定义 task_update。
 * @param {object} ctx - 插件上下文。
 * @returns {object} 工具定义。
 */
function taskUpdateDefinition(ctx) {
  return {
    name: 'task_update',
    description: '更新任务面板里某一项的状态与备注；状态推进是长任务不跑偏的主要手段。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'number', description: '任务编号，见任务面板里的 #N。' },
        status: { type: 'string', enum: ['todo', 'doing', 'done', 'blocked'], description: '新状态。' },
        note: { type: 'string', description: '一句话备注（如当前处理的文件）；传空字符串清除备注。' },
        path: { type: 'string', description: '账本路径；省略则沿用本会话已用的路径。' }
      },
      required: ['id', 'status']
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          changed: { type: 'string' },
          panel: { type: 'string' }
        },
        required: ['path', 'changed', 'panel']
      },
      render: (_args, value) => [{ type: 'text', text: `${value.changed}\n\n${value.panel}` }]
    },
    async execute(args, exec) {
      const id = args?.id
      if (typeof id !== 'number' || !Number.isInteger(id) || id < 1) throw new Error('id 必须是正整数')
      const status = args?.status
      if (!['todo', 'doing', 'done', 'blocked'].includes(status)) {
        throw new Error('status 必须是 todo / doing / done / blocked 之一')
      }
      const relPath = typeof args?.path === 'string' && args.path.trim() !== '' ? args.path : ledgerPathFor(exec)
      const { target, ledger, exists } = await readLedger(ctx, exec, relPath)
      if (!exists) throw new Error(`任务面板 ${relPath} 还不存在，请先用 plan_init 建立`)
      const task = ledger.tasks.find((item) => item.id === id)
      if (task === undefined) {
        throw new Error(`任务面板里没有 #${id}；现有编号：${ledger.tasks.map((item) => `#${item.id}`).join(' ')}`)
      }
      task.status = status
      if (typeof args?.note === 'string') {
        if (args.note.trim() === '') delete task.note
        else task.note = args.note.trim()
      }
      const panel = await writeLedger(ctx, exec, target, ledger, relPath)
      const note = task.note === undefined ? '' : `（${task.note}）`
      return { path: target.displayPath, changed: `#${id} → ${status}${note}`, panel }
    }
  }
}

/**
 * 定义 task_show。
 * @param {object} ctx - 插件上下文。
 * @returns {object} 工具定义。
 */
function taskShowDefinition(ctx) {
  return {
    name: 'task_show',
    description: '读取任务面板原文（面板只注入摘要，需要细节时用本工具）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: '账本路径；省略则沿用本会话已用的路径。' }
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          exists: { type: 'boolean' },
          panel: { type: 'string' },
          full: { type: 'string' },
          truncated: { type: 'boolean' }
        },
        required: ['path', 'exists', 'panel', 'full', 'truncated']
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.exists
          ? `${value.panel}\n\n<raw path="${value.path}"${value.truncated ? ' truncated="true"' : ''}>\n${value.full}\n</raw>`
          : `任务面板 ${value.path} 还不存在，请用 plan_init 建立。`
      }]
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const relPath = typeof args?.path === 'string' && args.path.trim() !== '' ? args.path : ledgerPathFor(exec)
      const { target, ledger, text, exists } = await readLedger(ctx, exec, relPath)
      const panel = buildPanel(ledger, relPath)
      if (exec.agent !== undefined) agents.set(exec.agent, { relPath, panel })
      const truncated = text.length > FULL_MAX_CHARS
      return {
        path: target.displayPath,
        exists,
        panel,
        full: truncated ? text.slice(0, FULL_MAX_CHARS) : text,
        truncated
      }
    }
  }
}

/**
 * 定义 stage_set：只更新面板上的阶段标签。
 * @param {object} ctx - 插件上下文。
 * @returns {object} 工具定义。
 */
function stageSetDefinition(ctx) {
  return {
    name: 'stage_set',
    description: '更新任务面板的阶段标签（如从 `1/4 拆分` 切到 `2/4 OCR+翻译`）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        stage: { type: 'string', description: '新的阶段标签。' },
        path: { type: 'string', description: '账本路径；省略则沿用本会话已用的路径。' }
      },
      required: ['stage']
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          panel: { type: 'string' }
        },
        required: ['path', 'panel']
      },
      render: (_args, value) => [{ type: 'text', text: `${value.panel}` }]
    },
    async execute(args, exec) {
      const stage = requireString(args?.stage, 'stage')
      const relPath = typeof args?.path === 'string' && args.path.trim() !== '' ? args.path : ledgerPathFor(exec)
      const { target, ledger, exists } = await readLedger(ctx, exec, relPath)
      if (!exists) throw new Error(`任务面板 ${relPath} 还不存在，请先用 plan_init 建立`)
      ledger.stage = stage
      const panel = await writeLedger(ctx, exec, target, ledger, relPath)
      return { path: target.displayPath, panel }
    }
  }
}

/**
 * 挂载任务面板工具，并把面板注册为动态上下文。
 * @param {object} ctx - preset 作用域的插件上下文。
 */
export function apply(ctx) {
  const register = createToolRegistrar(ctx)
  register(planInitDefinition(ctx))
  register(taskUpdateDefinition(ctx))
  register(taskShowDefinition(ctx))
  register(stageSetDefinition(ctx))

  // order 200 排在 sandbox(110)/approval(115)/delegation(120) 之后：位置最新鲜，最不容易被忽略。
  ctx.systemPrompt.context({
    name: 'doc-pipeline:panel',
    order: 200,
    text: ({ scope }) => agents.get(scope)?.panel ?? ''
  })

  // 会话建立时把工作区里已有的账本读进来；失败不影响会话创建。
  ctx.on('agent/created', async ({ agent, signal }) => {
    try {
      const { ledger, exists } = await readLedger(ctx, { agent, signal }, DEFAULT_LEDGER)
      agents.set(agent, { relPath: DEFAULT_LEDGER, panel: exists ? buildPanel(ledger, DEFAULT_LEDGER) : '' })
    } catch {
      agents.set(agent, { relPath: DEFAULT_LEDGER, panel: '' })
    }
  })
}
