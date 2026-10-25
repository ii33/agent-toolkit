/**
 * 量测：每个 preset 的「系统提示词 + 工具 schema」占用。
 *
 * 两个口径：
 *   - harness 口径：dsh-token-meter 的固定密度启发式（CHARS_PER_TOKEN = 4，即 4 字符=1 token），
 *     这是 harness 自己用于上下文压力/压缩的记账方式；
 *   - 中文口径：CJK 字符按 0.6~1.0 token/字 估算（BPE 分词器对中文远密于 4 字符/token），
 *     ASCII 仍按 4 字符/token。真实值取决于分词器，这里给区间。
 *
 * 工具 schema 取模型实际看到的字段（name / description / parameters），与 ToolSchema 一致。
 * web_search / web_fetch 的真实 schema 从会话日志的 request/header 里提取（最准确）。
 *
 * 运行：node test/measure.mjs [会话日志路径或目录]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { pathToFileURL } from 'node:url'
import { loadDependency, resolveShippedFile } from './deps.mjs'
import { apply } from '../index.js'

const yaml = loadDependency('js-yaml')
// dsh-token-meter 是装机包。DSH Desktop 把它放在 resources/app.asar 内，普通 node 读不进去，
// 所以要量测时必须用 $DSH_SHIPPED_MODULES / $DSH_APP_ROOT 指到解包的安装目录；
// 取不到就明确报错 —— 不换成另一套口径冒充 harness 口径。
const meter = await import(pathToFileURL(resolveShippedFile('@deepseek-ai/dsh-token-meter/lib/types/estimate.js').path).href)

const FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const CHARS_PER_TOKEN = 4

/** 多帧 zstd 会话日志解压。 */
function readLog(input) {
  let file = input
  if (statSync(input).isDirectory()) {
    const found = readdirSync(input).filter((name) => name.endsWith('.zstd'))
    if (found.length === 0) return []
    file = join(input, found[0])
  }
  const buffer = readFileSync(file)
  const offsets = []
  let at = buffer.indexOf(FRAME_MAGIC)
  while (at !== -1) {
    offsets.push(at)
    at = buffer.indexOf(FRAME_MAGIC, at + 4)
  }
  const parts = []
  for (const offset of offsets) {
    try {
      parts.push(zstdDecompressSync(buffer.subarray(offset)))
    } catch {
      /* 半帧忽略 */
    }
  }
  return Buffer.concat(parts).toString('utf8').split('\n')
    .filter((line) => line.trim() !== '')
    .flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
}

/** 统计字符构成。 */
function composition(text) {
  let cjk = 0
  let ascii = 0
  let other = 0
  for (const char of text) {
    const code = char.codePointAt(0)
    if ((code >= 0x3000 && code <= 0x9fff) || (code >= 0xff00 && code <= 0xffef) || (code >= 0x20000 && code <= 0x2ffff)) cjk += 1
    else if (code < 0x80) ascii += 1
    else other += 1
  }
  return { cjk, ascii, other, chars: cjk + ascii + other }
}

/** harness 口径 + 中文区间口径。 */
function price(text) {
  const { cjk, ascii, other, chars } = composition(text)
  const harness = Math.ceil(chars / CHARS_PER_TOKEN)
  const low = Math.round(cjk * 0.6 + (ascii + other) / CHARS_PER_TOKEN)
  const high = Math.round(cjk * 1.0 + (ascii + other) / CHARS_PER_TOKEN)
  return { chars, cjk, ascii, harness, low, high }
}

/** 造一个假 ctx 收集工具定义。 */
function collectTools(capabilities) {
  const tools = []
  const ctx = {
    tools: { register: (definition) => { tools.push(definition); return () => {} } },
    systemPrompt: { context: () => () => {} },
    on: () => () => {},
    effect: (fn) => fn(),
    get: () => undefined,
    logger: { info: () => {} },
    waterfall: async () => undefined,
    emit: () => {}
  }
  apply(ctx, { tools: capabilities })
  return tools
}

/** 模型可见的 schema（与 ToolSchema 字段一致）。 */
function modelSchema(tool) {
  return { name: tool.name, description: tool.description, parameters: tool.parameters }
}

// ── 1. 从 patch 读 preset 定义 ────────────────────────────────────────────────
const patch = yaml.load(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8'))
const presets = patch[0].insert.map((row) => {
  const config = row.config
  const persona = config.plugins.find((plugin) => plugin.id === 'persona')
  const pipeline = config.plugins.find((plugin) => plugin.id === 'pipeline')
  return {
    id: config.id,
    name: config.name,
    prefix: persona.config.prefix,
    capabilities: pipeline.config.tools,
    web: config.plugins.some((plugin) => plugin.id === 'web-tools')
  }
})

// ── 2. 从会话日志提取真实的 web 工具 schema ───────────────────────────────────
const logArg = process.argv[2] ?? ''
let webSchemas = []
try {
  const events = readLog(logArg)
  const header = events.filter((event) => event.type === 'request/header').at(-1)
  webSchemas = (header?.data?.header?.tools ?? []).filter((tool) => tool.name === 'web_search' || tool.name === 'web_fetch')
} catch {
  webSchemas = []
}

// ── 3. 逐 preset 量测 ────────────────────────────────────────────────────────
const rows = []
for (const preset of presets) {
  const tools = collectTools(preset.capabilities).map(modelSchema)
  const all = preset.web ? [...tools, ...webSchemas] : tools
  const toolsJson = JSON.stringify(all)
  const prompt = price(preset.prefix)
  const toolsPrice = price(toolsJson)
  rows.push({
    id: preset.id,
    name: preset.name,
    caps: preset.capabilities.length,
    toolCount: all.length,
    web: preset.web && webSchemas.length > 0,
    prompt,
    toolsPrice,
    total: {
      chars: prompt.chars + toolsPrice.chars,
      harness: prompt.harness + toolsPrice.harness + 8,
      low: prompt.low + toolsPrice.low,
      high: prompt.high + toolsPrice.high
    }
  })
}

// ── 4. 输出 ─────────────────────────────────────────────────────────────────
const pad = (value, width) => String(value).padEnd(width)
console.log('每行：提示词字符/中文口径token ｜ 工具数/工具token ｜ 合计')
console.log(`${pad('preset', 15)}${pad('能力', 5)}${pad('工具', 5)}${pad('提示词', 18)}${pad('工具schema', 20)}${pad('合计(harness)', 15)}合计(中文区间)`)
for (const row of rows) {
  const promptText = `${row.prompt.chars}字 / ${row.prompt.low}-${row.prompt.high}t`
  const toolsText = `${row.toolCount}个 / ${row.toolsPrice.harness}t(${row.toolsPrice.chars}字)`
  const totalText = `${row.total.harness}t`
  const cnText = `${row.total.low}-${row.total.high}t`
  console.log(`${pad(row.id, 15)}${pad(row.caps, 5)}${pad(row.toolCount, 5)}${pad(promptText, 18)}${pad(toolsText, 20)}${pad(totalText, 15)}${cnText}`)
}

console.log('\n明细（工具逐个，按 schema 字符数排序）')
const localPreset = rows.find((row) => row.id === 'local')
const localTools = collectTools(presets.find((preset) => preset.id === 'local').capabilities).map(modelSchema)
for (const tool of localTools.map((tool) => ({ ...tool, size: JSON.stringify(tool).length })).sort((a, b) => b.size - a.size)) {
  console.log(`  ${pad(tool.name, 14)}${String(tool.size).padStart(5)} 字  ≈${Math.ceil(tool.size / CHARS_PER_TOKEN)}t`)
}
if (webSchemas.length > 0) {
  for (const tool of webSchemas) {
    const size = JSON.stringify(tool).length
    console.log(`  ${pad(tool.name, 14)}${String(size).padStart(5)} 字  ≈${Math.ceil(size / CHARS_PER_TOKEN)}t   (来自会话日志)`)
  }
} else {
  console.log('  (未取到 web 工具 schema：传一个含 web 工具的会话日志路径作为参数)')
}
void localPreset

console.log('\n未计入（运行期追加，可用会话日志精确量测）：')
console.log('  - runtime context：sandbox 策略 / approval 策略 / 子代理声明')
console.log('  - 任务面板注入：≤700 字（仅在 TASKS.md 存在时）')
console.log(`  - 每条消息的 role 框架：+${meter.ROLE_OVERHEAD}t；工具 schema 整体框架 +4t`)

// ── 5. 基线：同一份日志里那个会话（cordis 模式）的真实占用 ────────────────────
try {
  const events = readLog(logArg)
  const header = events.filter((event) => event.type === 'request/header').at(-1)
  const tools = header?.data?.header?.tools ?? []
  const systemEvent = events.find((event) => event.type === 'system/message')
  const systemText = (systemEvent?.data?.message?.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('\n')
  const toolsTokens = meter.estimateToolsTokens({ tools })
  const systemTokens = systemText === '' ? 0 : meter.estimateSystemMessage({ role: 'system', content: [{ type: 'text', text: systemText }] })
  console.log('\n基线（该日志所属会话的真实请求，供对比）：')
  console.log(`  工具 ${tools.length} 个 → ${toolsTokens}t（${JSON.stringify(tools).length} 字）`)
  console.log(`  系统提示词 ${systemText.length} 字 → ${systemTokens}t`)
  console.log(`  合计 ${toolsTokens + systemTokens}t`)
} catch {
  console.log('\n基线：无法读取会话日志')
}
