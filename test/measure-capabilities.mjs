/**
 * 按能力实测工具定义的 token 成本（harness 口径：4 字符 ≈ 1 token，
 * 与 token-meter 的估算一致；中文提示词实际更高，单独标注）。
 *
 * 运行：node test/measure-capabilities.mjs
 */
import { apply } from '../index.js'
import { shippedGenericCapabilities } from './deps.mjs'

/** 与 index.js 的能力表一致。 */
const CAPABILITIES = ['fs', 'sftp', 'run', 'sh', 'pwsh', 'env', 'proxy', 'doc', 'split', 'img', 'tasks', 'guard', 'preset']

/**
 * 挂一个能力，返回它注册的工具与其 schema 成本。
 * @param {string} capability - 能力名。
 * @returns {{tools: string[], tokens: number}} 结果。
 */
function measureOne(capability) {
  const tools = []
  const ctx = {
    tools: { register: (definition) => { tools.push(definition); return () => {} } },
    systemPrompt: { context: () => () => {} },
    on: () => () => {},
    effect: (fn) => fn(),
    get: () => undefined,
    logger: { info: () => {} },
    waterfall: async (_name, _target, _exec, fallback) => fallback(),
    emit: () => {}
  }
  apply(ctx, { tools: [capability] })
  const schemas = tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))
  return { tools: tools.map((tool) => tool.name), tokens: Math.ceil(JSON.stringify(schemas).length / 4) + 4 }
}

/** generic preset 上挂的那些能力：取自出货 cordis.patch.yml（唯一真源）。 */
const GENERIC_ROW = shippedGenericCapabilities()

let total = 0
let toolCount = 0
console.log('能力'.padEnd(8), '工具数', '预估 token', '  工具名')
for (const capability of CAPABILITIES) {
  const { tools, tokens } = measureOne(capability)
  total += tokens
  toolCount += tools.length
  console.log(
    capability.padEnd(8),
    String(tools.length).padStart(4),
    String(tokens).padStart(8),
    `  ${tools.join(', ')}`
  )
}

let genericTotal = 0
let genericTools = 0
for (const capability of GENERIC_ROW) {
  const { tools, tokens } = measureOne(capability)
  genericTotal += tokens
  genericTools += tools.length
}

console.log('')
console.log(`全部 13 个能力：${toolCount} 个工具，约 ${total} token（harness 口径）`)
console.log(`generic 挂的 ${GENERIC_ROW.length} 个：${genericTools} 个工具，约 ${genericTotal} token`)
console.log(`未挂的：${CAPABILITIES.filter((name) => !GENERIC_ROW.includes(name)).join(', ')}（约 ${total - genericTotal} token）`)
