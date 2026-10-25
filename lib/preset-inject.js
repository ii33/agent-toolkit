/**
 * 预设注入：把一个**已存在的预设**变成"原样 + 通用工具集"。
 *
 * 为什么需要它：出货预设（standard / cordis / minimal / ptc）与流水线预设的声明归各自的
 * bundle 所有，**不能往里追加行**；而补丁方言支持**按行 id 覆盖**一条声明。所以做法是：
 *
 *   1. 用注册表服务读出现有预设的声明 —— `ctx.get('agentPresets').readDocument(id)` 返回
 *      `{ agentPreset, content（插件列表 YAML）, name?, description? }`，`list()` 里能拿到 order；
 *   2. 在它的插件列表里**确保存在**一行 toolkit（已有就替换其 `tools`，保持幂等）；
 *   3. 合成一条 `- id: preset-<id>` 覆盖声明，写进本 bundle 的
 *      `presets.generated.patch.yml` → HMR 重载后该预设就带上工具集了。
 *
 * 每次写入都会**重新读取**现有声明，所以出货预设更新后，重新注入一次即可跟上。
 *
 * 纯函数部分（`ensureToolkitRow` / `renderOverrideBlock`）不依赖 harness，可离线测。
 *
 * @module @local/dsh-agentkit/preset-inject
 */

/** 本插件包名（被注入的 toolkit 行要引用它）。 */
export const PACKAGE_NAME = '@local/dsh-agentkit'

/** YAML 双引号字符串。 */
export function yamlString(value) {
  return `"${String(value).replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`
}

/** 可以直接裸写在 YAML 里的安全标量（不含 `:`/`#`/引号/空白等会改变解析的字符）。 */
const PLAIN_YAML_SCALAR = /^[A-Za-z][A-Za-z0-9._-]*$/u

/**
 * 只在必要时加引号的 YAML 标量：普通 id（standard / my-preset / a.b）输出保持裸写，
 * 保证已有补丁与断言逐字节不变；含特殊字符的 id 才加引号，避免把生成的补丁写坏
 * （顶层条目 id 一旦解析歪掉，组合后的 profile 会进恢复模式）。
 * @param {string} value - 原值。
 * @returns {string} YAML 标量文本。
 */
export function yamlScalar(value) {
  return PLAIN_YAML_SCALAR.test(String(value)) ? String(value) : yamlString(value)
}

/** 一行是不是插件列表里的顶层条目。 */
function isTopLevelEntry(line) {
  return /^- id: /.test(line)
}

/**
 * 本工具集要**接管**的出货工具，以及接管前必须在出货那一行关掉的开关。
 *
 * 为什么必须关：工具注册按 scope 分层（`layers.effect(ctx, layer => layer.tools.insert(...))`），
 * 同一个 preset 作用域里重名会直接抛 `tool "read" is already registered in this scope`。
 * 于是「在 preset 里遮蔽出货实现」只有一条路——让出货那一行**不注册**这个工具：
 *   - cordis / standard / ptc 自带的 `@deepseek-ai/dsh-tool-fs` 有 `read` / `readImage` / `write` / `edit`
 *     四个开关（默认全开），关掉 read/write/edit 即可，`readImage` 留着由出货实现继续提供
 *     （它带附件路由与 UI 图片卡，比本工具集的版本完整）。
 *   - 不关的后果实测过：工具集一挂载就抛同层重名 → 该行 apply 失败 → 注册表把整份预设标成
 *     broken → 新会话的预设选择器里那个预设直接不可选。
 *
 * `pwsh` 不在此表：它由 `tools/registry.js` 的 YIELDED_NAMES 主动让给出货实现
 * （出货的 pwsh 走 ctx.shell 的沙箱与审批，更完整）。
 * @type {ReadonlyMap<string, {module: string, switches: string[]}>}
 */
export const TAKEOVER_SWITCHES = new Map([
  ['fs', { module: '@deepseek-ai/dsh-tool-fs', switches: ['read', 'write', 'edit'] }]
])

/**
 * 按模块名找插件列表里的顶层条目范围。
 * @param {string[]} lines - 插件列表行。
 * @param {string} moduleName - 模块名，如 `@deepseek-ai/dsh-tool-fs`。
 * @returns {{start: number, end: number}|undefined} 范围。
 */
function findEntryByModule(lines, moduleName) {
  const wanted = new RegExp(`^\\s*name:\\s*["']?${moduleName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}["']?\\s*$`, 'u')
  for (let index = 0; index < lines.length; index += 1) {
    if (!isTopLevelEntry(lines[index])) continue
    let end = lines.length
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (isTopLevelEntry(lines[cursor])) {
        end = cursor
        break
      }
    }
    for (let cursor = index; cursor < end; cursor += 1) {
      if (wanted.test(lines[cursor])) return { start: index, end }
    }
  }
  return undefined
}

/**
 * 在某个条目里把给定的配置键写成 `false`（键不存在就补在 `config:` 块末尾；没有 config 就补一个）。
 * 其它既有配置键原样保留。
 * @param {string[]} lines - 插件列表行。
 * @param {{start: number, end: number}} entry - 条目范围。
 * @param {string[]} keys - 要置为 false 的配置键。
 * @returns {string[]} 新行。
 */
function switchOffKeys(lines, entry, keys) {
  let configAt = -1
  for (let index = entry.start; index < entry.end; index += 1) {
    if (/^\s*config:\s*$/u.test(lines[index])) {
      configAt = index
      break
    }
  }
  if (configAt === -1) {
    // 条目没有 config：补一个，插在 `name:` 之后（顺序只为可读性，YAML 映射本身无序）
    let at = entry.start + 1
    for (let index = entry.start + 1; index < entry.end; index += 1) {
      if (/^\s*name:/u.test(lines[index])) {
        at = index + 1
        break
      }
    }
    const rendered = ['  config:', ...keys.map((key) => `    ${key}: false`)]
    return [...lines.slice(0, at), ...rendered, ...lines.slice(at)]
  }
  const configIndent = (/^ */u.exec(lines[configAt]))[0].length
  const childIndent = configIndent + 2
  let blockEnd = configAt + 1
  for (; blockEnd < entry.end; blockEnd += 1) {
    const line = lines[blockEnd]
    if (line.trim() !== '' && (/^ */u.exec(line))[0].length <= configIndent) break
  }
  const next = [...lines]
  let insertAt = blockEnd
  for (const key of keys) {
    const pattern = new RegExp(`^\\s*${key}:`, 'u')
    let replaced = false
    for (let index = configAt + 1; index < blockEnd; index += 1) {
      if (pattern.test(next[index]) && (/^ */u.exec(next[index]))[0].length === childIndent) {
        next[index] = `${' '.repeat(childIndent)}${key}: false`
        replaced = true
        break
      }
    }
    if (!replaced) {
      next.splice(insertAt, 0, `${' '.repeat(childIndent)}${key}: false`)
      insertAt += 1
      blockEnd += 1
    }
  }
  return next
}

/**
 * 接管前的准备：把该预设自带的、会被本工具集接管的工具在出货那一行关掉。
 *
 * 只动「目标预设声明里确实出现、且能力已开启」的那些行；别的预设、别的模块一概不碰。
 * @param {string} content - 预设的插件列表 YAML。
 * @param {string[]} capabilities - 本次要挂载的能力。
 * @returns {{content: string, notes: string[]}} 变换后的插件列表与说明。
 */
export function takeoverShippedTools(content, capabilities) {
  const enabled = Array.isArray(capabilities) ? capabilities : []
  let lines = String(content ?? '').split('\n')
  const notes = []
  for (const [capability, spec] of TAKEOVER_SWITCHES) {
    if (!enabled.includes(capability)) continue
    const entry = findEntryByModule(lines, spec.module)
    if (entry === undefined) continue
    lines = switchOffKeys(lines, entry, spec.switches)
    notes.push(`${spec.module} 里 ${spec.switches.join('/')} 已关闭（由本工具集接管）`)
  }
  return { content: `${lines.join('\n').replace(/\s+$/u, '')}\n`, notes }
}

/**
 * 在插件列表 YAML 里确保存在 toolkit 行：没有就追加，有就替换它的 `tools`。
 * @param {string} content - `readDocument` 返回的插件列表 YAML。
 * @param {string[]} capabilities - 要挂载的能力。
 * @returns {string} 变换后的插件列表 YAML。
 */
export function ensureToolkitRow(content, capabilities) {
  const row = [
    '- id: toolkit',
    `  name: '${PACKAGE_NAME}'`,
    '  config:',
    `    tools: [${capabilities.join(', ')}]`
  ]
  const text = String(content ?? '')
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line.trim() === '- id: toolkit')
  if (start === -1) {
    const head = text.replace(/\s*$/u, '')
    return head === '' ? `${row.join('\n')}\n` : `${head}\n${row.join('\n')}\n`
  }
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (isTopLevelEntry(lines[index])) {
      end = index
      break
    }
  }
  const next = [...lines.slice(0, start), ...row, ...lines.slice(end)]
  return `${next.join('\n').replace(/\s*$/u, '')}\n`
}

/**
 * 在插件列表里找一项（`- id: <entryId>`）的文本范围。
 * @param {string[]} lines - 插件列表行。
 * @param {string} entryId - 条目 id。
 * @returns {{start: number, end: number}|undefined} 范围。
 */
export function findEntry(lines, entryId) {
  // 引号容错：harness 的 YAML dumper 会写成 `- id: "toolkit"`
  const wanted = new RegExp(`^- id:\\s*["']?${entryId}["']?\\s*$`, 'u')
  const start = lines.findIndex((line) => wanted.test(line.trim()))
  if (start === -1) return undefined
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (isTopLevelEntry(lines[index])) {
      end = index
      break
    }
  }
  return { start, end }
}

/**
 * 读某个键的字符串列表，**两种写法都支持**：
 *   - 内联：`tools: [fs, sh]`
 *   - 块序列：`tools:` 后面跟若干 `- fs` 行（harness 的 YAML dumper 会用这种）
 * @param {string[]} lines - 行。
 * @param {number} from - 起始行（含）。
 * @param {number} to - 结束行（不含）。
 * @param {string} key - 键名。
 * @returns {string[]|undefined} 列表；没有这个键时 undefined。
 */
export function readListValue(lines, from, to, key) {
  const strip = (value) => value.trim().replace(/^["']|["']$/gu, '')
  for (let index = from; index < to; index += 1) {
    const inline = new RegExp(`^\\s*${key}:\\s*\\[(.*)\\]\\s*$`, 'u').exec(lines[index])
    if (inline !== null) {
      return inline[1].split(',').map(strip).filter((name) => name !== '')
    }
    const head = new RegExp(`^(\\s*)${key}:\\s*$`, 'u').exec(lines[index])
    if (head !== null) {
      const indent = head[1].length
      const items = []
      for (let cursor = index + 1; cursor < to; cursor += 1) {
        const line = lines[cursor]
        if (line.trim() === '') continue
        if ((/^ */u.exec(line))[0].length <= indent) break
        const item = /^\s*-\s*(.+)$/u.exec(line)
        if (item !== null) items.push(strip(item[1]))
      }
      return items
    }
  }
  return undefined
}

/**
 * 读出 toolkit 行当前挂的能力（没有 toolkit 行时返回 undefined）。
 * @param {string} content - 插件列表 YAML。
 * @returns {string[]|undefined} 能力名。
 */
export function readToolkitCapabilities(content) {
  const lines = String(content ?? '').split('\n')
  const entry = findEntry(lines, 'toolkit')
  if (entry === undefined) return undefined
  // 内联数组与块序列两种写法都要认（harness 的 YAML dumper 用块序列）
  return readListValue(lines, entry.start, entry.end, 'tools') ?? []
}

/**
 * 读出 persona 行的 prefix 正文（块标量或同行标量）。
 * @param {string} content - 插件列表 YAML。
 * @returns {string|undefined} persona 文本；没有 persona 行时 undefined。
 */
export function readPersonaPrefix(content) {
  const lines = String(content ?? '').split('\n')
  const entry = findEntry(lines, 'persona')
  if (entry === undefined) return undefined
  for (let index = entry.start; index < entry.end; index += 1) {
    const block = /^(\s*)prefix:\s*[|>][-+]?\s*$/u.exec(lines[index])
    if (block !== null) {
      const indent = block[1].length
      const body = []
      for (let cursor = index + 1; cursor < entry.end; cursor += 1) {
        const line = lines[cursor]
        if (line.trim() !== '' && (/^ */u.exec(line))[0].length <= indent) break
        body.push(line)
      }
      const nonEmpty = body.filter((line) => line.trim() !== '')
      const base = nonEmpty.length === 0 ? 0 : Math.min(...nonEmpty.map((line) => (/^ */u.exec(line))[0].length))
      return body.map((line) => (line.trim() === '' ? '' : line.slice(base))).join('\n').replace(/\s+$/u, '')
    }
    const inline = /^\s*prefix:\s*(.+)$/u.exec(lines[index])
    if (inline !== null) return inline[1].replace(/^["']|["']$/gu, '')
  }
  return ''
}

/**
 * 把 persona 的 prefix 换成给定正文（保留该行的其它配置），没有 persona 行就补一个。
 * @param {string} content - 插件列表 YAML。
 * @param {string} prefix - 新的 persona 文本。
 * @returns {string} 变换后的插件列表 YAML。
 */
export function withPersonaPrefix(content, prefix) {
  const lines = String(content ?? '').split('\n')
  const entry = findEntry(lines, 'persona')
  /** 按给定缩进渲染 prefix 块。 */
  const blockFor = (indent) => {
    const pad = ' '.repeat(indent)
    return [`${pad}prefix: |`, ...prefix.split('\n').map((line) => (line === '' ? '' : `${pad}  ${line}`))]
  }
  if (entry === undefined) {
    const head = ['- id: persona', "  name: '@deepseek-ai/dsh-persona'", '  config:', ...blockFor(4), '']
    return `${[...head, ...lines].join('\n').replace(/\s+$/u, '')}\n`
  }
  let prefixAt = -1
  for (let index = entry.start; index < entry.end; index += 1) {
    if (/^\s*prefix:/u.test(lines[index])) {
      prefixAt = index
      break
    }
  }
  if (prefixAt === -1) {
    // 没有 prefix：插在 config: 之后（没有 config 就插在 name 之后并补一个 config）
    let configAt = -1
    for (let index = entry.start; index < entry.end; index += 1) {
      if (/^\s*config:\s*$/u.test(lines[index])) {
        configAt = index
        break
      }
    }
    if (configAt === -1) {
      const at = entry.start + 1
      return [...lines.slice(0, at), '  config:', ...blockFor(4), ...lines.slice(at)].join('\n').replace(/\s+$/u, '') + '\n'
    }
    const indent = (/^ */u.exec(lines[configAt]))[0].length + 2
    return [...lines.slice(0, configAt + 1), ...blockFor(indent), ...lines.slice(configAt + 1)].join('\n').replace(/\s+$/u, '') + '\n'
  }
  const indent = (/^ */u.exec(lines[prefixAt]))[0].length
  let end = prefixAt + 1
  for (; end < entry.end; end += 1) {
    const line = lines[end]
    if (line.trim() !== '' && (/^ */u.exec(line))[0].length <= indent) break
  }
  return [...lines.slice(0, prefixAt), ...blockFor(indent), ...lines.slice(end)].join('\n').replace(/\s+$/u, '') + '\n'
}

/**
 * 定位某一项里的某个键（含块体范围）。
 * @param {string[]} lines - 行。
 * @param {string} entryId - 条目 id。
 * @param {string} key - 键名。
 * @returns {{start: number, end: number, indent: number}|undefined} 范围（start 为 -1 表示没有该键）。
 */
function locateKey(lines, entryId, key) {
  const entry = findEntry(lines, entryId)
  if (entry === undefined) return undefined
  for (let index = entry.start; index < entry.end; index += 1) {
    const match = new RegExp(`^(\\s*)${key}:`, 'u').exec(lines[index])
    if (match === null) continue
    const indent = match[1].length
    let end = index + 1
    for (; end < entry.end; end += 1) {
      const line = lines[end]
      if (line.trim() !== '' && (/^ */u.exec(line))[0].length <= indent) break
    }
    return { start: index, end, indent }
  }
  return { start: -1, end: -1, indent: -1 }
}

/**
 * 设置某一项里的键：文本写成 `|` 块，标量写成一行；该键不存在就插在 `config:` 之后。
 * @param {string[]} lines - 行。
 * @param {string} entryId - 条目 id。
 * @param {string} key - 键名。
 * @param {string[]|string} value - 文本行数组，或单个标量（如 'true'）。
 * @returns {string[]} 新行。
 */
function setKey(lines, entryId, key, value) {
  const found = locateKey(lines, entryId, key)
  if (found === undefined) return lines
  const isScalar = typeof value === 'string'
  if (found.start >= 0) {
    const indent = ' '.repeat(found.indent)
    const rendered = isScalar
      ? [`${indent}${key}: ${value}`]
      : [`${indent}${key}: |`, ...value.map((line) => (line === '' ? '' : `${indent}  ${line}`))]
    return [...lines.slice(0, found.start), ...rendered, ...lines.slice(found.end)]
  }
  const entry = findEntry(lines, entryId)
  const configAt = lines.findIndex((line, index) => index >= entry.start && index < entry.end && /^\s*config:\s*$/u.test(line))
  const indent = configAt === -1 ? '  ' : `${(/^ */u.exec(lines[configAt]))[0]}  `
  const rendered = isScalar
    ? [`${indent}${key}: ${value}`]
    : [`${indent}${key}: |`, ...value.map((line) => (line === '' ? '' : `${indent}  ${line}`))]
  if (configAt === -1) {
    return [...lines.slice(0, entry.start + 1), '  config:', ...rendered, ...lines.slice(entry.start + 1)]
  }
  return [...lines.slice(0, configAt + 1), ...rendered, ...lines.slice(configAt + 1)]
}

/**
 * 读 persona 行的 prefix / suffix / complete。
 * @param {string} content - 插件列表 YAML。
 * @returns {{prefix: string, suffix: string, complete: boolean, found: boolean}} 字段。
 */
export function readPersonaFields(content) {
  const lines = String(content ?? '').split('\n')
  const entry = findEntry(lines, 'persona')
  if (entry === undefined) return { prefix: '', suffix: '', complete: false, found: false }
  const readText = (key) => {
    const found = locateKey(lines, 'persona', key)
    if (found === undefined || found.start < 0) return ''
    const head = new RegExp(`^${' '.repeat(found.indent)}${key}:\\s*(.*)$`, 'u').exec(lines[found.start])
    const inline = head === null ? '' : head[1]
    if (inline !== '' && !/^[|>][-+]?$/u.test(inline)) return inline.replace(/^["']|["']$/gu, '')
    const body = lines.slice(found.start + 1, found.end)
    const nonEmpty = body.filter((line) => line.trim() !== '')
    const base = nonEmpty.length === 0 ? 0 : Math.min(...nonEmpty.map((line) => (/^ */u.exec(line))[0].length))
    return body.map((line) => (line.trim() === '' ? '' : line.slice(base))).join('\n').replace(/\s+$/u, '')
  }
  let complete = false
  const flag = locateKey(lines, 'persona', 'complete')
  if (flag !== undefined && flag.start >= 0) complete = /complete:\s*true/u.test(lines[flag.start])
  return { prefix: readText('prefix'), suffix: readText('suffix'), complete, found: true }
}

/**
 * 写 persona 的字段（只写传入的；prefix/suffix 为空字符串表示不动）。
 * @param {string} content - 插件列表 YAML。
 * @param {{prefix?: string, suffix?: string, complete?: boolean}} fields - 要写的字段。
 * @returns {string} 变换后的插件列表 YAML。
 */
export function withPersonaFields(content, fields = {}) {
  let lines = String(content ?? '').split('\n')
  if (findEntry(lines, 'persona') === undefined) {
    lines = ['- id: persona', "  name: '@deepseek-ai/dsh-persona'", '  config:', ...lines]
  }
  if (typeof fields.prefix === 'string' && fields.prefix.trim() !== '') {
    lines = setKey(lines, 'persona', 'prefix', fields.prefix.split('\n'))
  }
  if (typeof fields.suffix === 'string' && fields.suffix.trim() !== '') {
    lines = setKey(lines, 'persona', 'suffix', fields.suffix.split('\n'))
  }
  if (fields.complete === true) lines = setKey(lines, 'persona', 'complete', 'true')
  if (fields.complete === false) {
    const found = locateKey(lines, 'persona', 'complete')
    if (found !== undefined && found.start >= 0) lines = [...lines.slice(0, found.start), ...lines.slice(found.end)]
  }
  return `${lines.join('\n').replace(/\s+$/u, '')}\n`
}

/**
 * 列出该预设里"还会向系统提示词注入段落"的其它行（只读提示用）。
 * persona 只提供一句话时，其余段落由这些行分别注入。
 * @param {string} content - 插件列表 YAML。
 * @returns {string[]} 条目 id。
 */
export function promptContributors(content) {
  const lines = String(content ?? '').split('\n')
  const known = ['agent-instructions', 'skill-filesystem', 'planning', 'delegation', 'compaction', 'command-goal', 'tool-goal']
  const found = []
  for (const line of lines) {
    const match = /^- id:\s*(\S+)\s*$/u.exec(line)
    if (match !== null && known.includes(match[1])) found.push(match[1])
  }
  return found
}

/**
 * 用给定的插件列表合成一条**覆盖声明**。
 *
 * Loader 方言：顶层条目 `- id: <既有 id>`（**不带 `insert`**）才会命中并替换已存在的行；
 * 写进 `insert:` 里的同 id 行只会"追加" → 组合后的 profile 出现重复 entry id（实测会让应用进恢复模式）。
 * 所以这里按顶层条目缩进输出：条目键 2 空格、config 键 4 空格、plugins 子项 6 空格。
 *
 * @param {{id: string, name?: string, description?: string, order?: number}} doc - 原声明元数据。
 * @param {string} pluginsYaml - 插件列表 YAML（缩进 0）。
 * @param {string} [fallbackDescription] - 没有描述时的兜底文案。
 * @returns {string} 覆盖声明文本（顶层条目）。
 */
export function renderOverride(doc, pluginsYaml, fallbackDescription) {
  const id = doc.id
  const name = doc.name === undefined || doc.name === '' ? id : doc.name
  const description = doc.description === undefined || doc.description === ''
    ? (fallbackDescription ?? `原预设 ${id}`)
    : doc.description
  const order = Number.isFinite(doc.order) ? doc.order : 50
  // id 裸写在这里是"补丁行 id"，必须能被 YAML 原样读回；非普通 token 走引号形式。
  // 唯一性由调用方保证（同一个 id 在 insert: 与顶层各出现一次会产生重复 entry id）。
  const lines = [
    `- id: ${yamlScalar(`preset-${id}`)}`,
    "  name: '@deepseek-ai/dsh-agent-preset'",
    '  config:',
    `    id: ${yamlScalar(id)}`,
    `    name: ${yamlString(name)}`,
    `    description: ${yamlString(description)}`,
    `    order: ${order}`,
    '    plugins:'
  ]
  for (const line of String(pluginsYaml ?? '').split('\n')) {
    lines.push(line.trimEnd() === '' ? '' : `      ${line}`)
  }
  return lines.join('\n')
}

/**
 * 合成一条覆盖声明（`- id: preset-<id>`），即"原声明 + toolkit 行"。
 * @param {{id: string, name?: string, description?: string, order?: number, content: string}} doc - 现有声明。
 * @param {string[]} capabilities - 要挂载的能力。
 * @returns {string} 覆盖声明的 YAML 文本。
 */
export function renderOverrideBlock(doc, capabilities) {
  // 先关掉出货行里会被接管的工具开关，再追加 toolkit 行：否则同一 preset 作用域里同层重名，
  // 工具集这一行会 apply 失败，整份预设被判 broken（新会话里不可选）。
  const prepared = takeoverShippedTools(doc.content, capabilities).content
  return renderOverride(doc, ensureToolkitRow(prepared, capabilities), `原预设 ${doc.id} + 通用 agent 工具集`)
}

/**
 * 按"设置页编辑"合成覆盖声明：可同时改能力与 persona。
 * @param {{id: string, name?: string, description?: string, order?: number, content: string}} doc - 现有声明。
 * @param {{capabilities?: string[], persona?: string}} edit - 编辑内容（空字段表示不动）。
 * @returns {string} 覆盖声明的 YAML 文本。
 */
export function renderEditOverride(doc, edit) {
  let content = doc.content
  if (Array.isArray(edit?.capabilities) && edit.capabilities.length > 0) {
    // 同 renderOverrideBlock：先把出货行里被接管的工具关掉，避免同层重名把整份预设打成 broken。
    content = ensureToolkitRow(takeoverShippedTools(content, edit.capabilities).content, edit.capabilities)
  }
  const personaFields = {}
  if (typeof edit?.persona === 'string' && edit.persona.trim() !== '') personaFields.prefix = edit.persona
  if (typeof edit?.suffix === 'string' && edit.suffix.trim() !== '') personaFields.suffix = edit.suffix
  // complete 用三态字符串：'true' 打开、'false' 关掉、''（默认）不动 —— 免得误删原有的 complete: true
  if (edit?.complete === 'true') personaFields.complete = true
  if (edit?.complete === 'false') personaFields.complete = false
  if (Object.keys(personaFields).length > 0) content = withPersonaFields(content, personaFields)
  return renderOverride(doc, content, `原预设 ${doc.id}（已按设置页编辑）`)
}

/**
 * 把若干"精确编辑"渲染成覆盖声明块（每个预设可改能力与 persona）。
 * @param {object} ctx - 插件上下文。
 * @param {Record<string, {capabilities?: string[], persona?: string}>} edits - 预设 id → 编辑内容。
 * @param {(message: string) => void} [log] - 日志回调。
 * @returns {Promise<string[]>} 覆盖声明块数组。
 */
export async function buildEditOverrides(ctx, edits, log) {
  const blocks = []
  for (const [preset, edit] of Object.entries(edits ?? {})) {
    try {
      const doc = await readPresetDocument(ctx, preset)
      blocks.push(renderEditOverride(doc, edit))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (log !== undefined) log(`preset_edit: 读取预设 ${preset} 失败：${message}`)
    }
  }
  return blocks
}

/**
 * 读一个现有预设的声明（走注册表服务，不碰文件路径）。
 * @param {object} ctx - 插件上下文。
 * @param {string} id - 预设 id。
 * @returns {Promise<{id: string, name?: string, description?: string, order?: number, content: string}>} 声明。
 */
export async function readPresetDocument(ctx, id) {
  const registry = ctx.get('agentPresets')
  if (registry === undefined) throw new Error('agentPresets 服务不可用，无法读取现有预设')
  const document = await registry.readDocument(id)
  // 注册表对未知 id 可能不抛错而返回空文档（不同装机实现的语义不同）。
  // 空声明意味着"读不到这个预设"，必须报错 —— 否则会渲染出一个空覆盖条目，
  // 让调用方以为注入成功（冒烟第五/六轮都踩过这条）。
  const content = document?.content
  if (typeof content !== 'string' || content.trim() === '') {
    throw new Error(`预设 "${id}" 没有可读的声明（注册表返回空文档）`)
  }
  let order
  try {
    const rows = await registry.list()
    const row = Array.isArray(rows) ? rows.find((entry) => entry !== null && entry.id === id) : undefined
    if (row !== undefined && Number.isFinite(row.order)) order = row.order
  } catch {
    order = undefined
  }
  return {
    id,
    ...(document?.name === undefined ? {} : { name: document.name }),
    ...(document?.description === undefined ? {} : { description: document.description }),
    ...(order === undefined ? {} : { order }),
    content
  }
}

/**
 * 把若干注入项渲染成覆盖声明块。
 * @param {object} ctx - 插件上下文。
 * @param {{preset: string, capabilities: string[]}[]} items - 注入项。
 * @param {(message: string) => void} [log] - 日志回调。
 * @returns {Promise<string[]>} 覆盖声明块数组。
 */
export async function buildOverrides(ctx, items, log) {
  const blocks = []
  for (const item of items) {
    try {
      const doc = await readPresetDocument(ctx, item.preset)
      blocks.push(renderOverrideBlock(doc, item.capabilities))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (log !== undefined) log(`preset_inject: 读取预设 ${item.preset} 失败：${message}`)
    }
  }
  return blocks
}
