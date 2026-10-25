/**
 * 编码 / 换行 / 字符集 / 远程 全部兜底的文本文件工具：
 *   read_text、write_text、edit_text、list_dir
 *
 * 与内置 `dsh-tool-fs` 的差别（它存在的理由）：
 *   - 读：探测 BOM / UTF-8 / UTF-16 / GBK / Big5 并写进结果元数据；默认带行号；
 *     大文件（≥10MB，UTF-8）走流式；单次输出有 64KB 字节上限与单行 2000 字符上限；
 *     offset 越界**报错**而不是静默夹取。
 *   - 写：**按目标文件的原字符集编码写回**（GBK / UTF-16 不再被迫转 UTF-8），
 *     默认沿用原文件的换行与 BOM；本地非 UTF-8 写回走 Python 助手做原子替换。
 *   - 编辑：匹配前统一换行（消灭 Windows 上最常见的 "old_string not found"）；
 *     非 UTF-8 文件走"读→改→按原字符集写回"。
 *   - 远程：路径写成 `代号:/远程/路径` 时，同样的四个工具直接操作 SFTP 主机
 *     （代号在 sftp-hosts.json 定义，连接由 lib/remote.js 的常驻侧车保活）。
 *
 * @module @local/dsh-doc-pipeline/fs
 */
import { canEncode, encodeText, encodeWriteFile } from '../lib/charset.js'
import {
  detectBom,
  decodeText,
  dominantEol,
  eolLabel,
  encodingLabel,
  looksBinary,
  normalizeEol,
  stripBom
} from '../lib/encoding.js'
import { currentPolicy, formatBytes, normalizePathInput, optionalPositiveInt, resolveOptions, utf8Bytes } from '../lib/fs-common.js'
import { assertPathAllowed, escalationSchemaFields, resolveWritePolicy, withSandboxHint } from '../lib/sandbox.js'
import { MAX_REMOTE_BYTES, remoteList, remoteReadBytes, remoteStat, remoteWriteBytes, resolveRemote } from '../lib/remote.js'
import { createToolRegistrar } from './registry.js'

/** 需要 tools 与 fs 两个服务。 */
export const inject = ['tools', 'fs']

/** ≥ 该体积的 UTF-8 本地文件走流式读取。 */
const STREAM_MIN_SIZE = 10 * 1024 * 1024

/** 编辑/整文件读入内存的上限（非 UTF-8 与远程整文件读同样受此约束）。 */
const MAX_IN_MEMORY_BYTES = 8 * 1024 * 1024

/** 探测既有文件编码/换行时只读文件头这么多字节。 */
const HEAD_BYTES = 4096

/** 一次返回的默认行数与上限。 */
const DEFAULT_LINE_LIMIT = 400
const MAX_LINE_LIMIT = 2000

/** `read_many` 的递归深度与文件数上限（超过就报错，不静默夹取）。 */
const DEFAULT_READ_MANY_DEPTH = 3
const MAX_READ_MANY_DEPTH = 8
const DEFAULT_READ_MANY_FILES = 20
const MAX_READ_MANY_FILES = 200

/**
 * 读一个受上下限约束的整数参数：**超出范围报错**，而不是静默夹取
 * （静默夹取会让调用方以为参数生效了，例如 depth=9 实际只走到 8）。
 * @param {unknown} value - 原始参数。
 * @param {string} name - 参数名（用于报错）。
 * @param {number} fallback - 缺省值。
 * @param {number} min - 允许的最小值。
 * @param {number} max - 允许的最大值。
 * @returns {number} 校验后的整数。
 */
function boundedIntParam(value, name, fallback, min, max) {
  if (value === undefined) return fallback
  const number = Number(value)
  if (!Number.isInteger(number)) throw new Error(`${name} 必须是整数（收到 ${JSON.stringify(value)}）`)
  if (number < min || number > max) throw new Error(`${name} 必须在 ${min}..${max} 之间（收到 ${number}）`)
  return number
}

/** 单次输出上限：字节数与单行字符数（旗舰模型上下文充裕，放宽到 256KB / 8000 字符）。 */
export const MAX_OUTPUT_BYTES = 256 * 1024
export const MAX_LINE_CHARS = 8000

/** 目录一次列出的条目上限。 */
const MAX_DIR_ENTRIES = 300

/** 新文件的默认换行风格（LF 对 git 最友好；需要 CRLF 时显式传 eol）。 */
const DEFAULT_NEW_EOL = 'lf'

/**
 * 解析目标：远程（代号在配置里）或本地。
 * @param {object} ctx - 插件上下文。
 * @param {object} exec - 工具执行上下文。
 * @param {string} pathInput - 模型给的路径。
 * @param {{forWrite?: boolean}} [options] - 写操作按沙箱工作区根解析相对路径。
 * @returns {Promise<object>} `{kind, displayPath, info, target?, remote?, policy?}`。
 */
async function openTarget(ctx, exec, pathInput, options = {}) {
  const remote = await resolveRemote(ctx, exec, pathInput)
  if (remote !== undefined) {
    const info = await remoteStat(ctx, exec, remote)
    return { kind: 'remote', remote, displayPath: remote.displayPath, info }
  }
  const policy = options.policy ?? (options.forWrite === true ? currentPolicy(ctx, exec) : undefined)
  const target = await ctx.fs.resolve(pathInput, resolveOptions(exec, policy?.workspaceRoot, ctx))
  const info = await ctx.fs.stat(target, exec.signal)
  return { kind: 'local', target, displayPath: target.displayPath, info, policy }
}

/**
 * 读文件头若干字节（用于编码/换行探测）。
 * @returns {Promise<Uint8Array>} 头部字节。
 */
async function readHead(ctx, exec, opened) {
  if (opened.kind === 'remote') {
    return await remoteReadBytes(ctx, exec, opened.remote, HEAD_BYTES, { offset: 0, length: HEAD_BYTES })
  }
  return await ctx.fs.readByteRange(opened.target, { offset: 0, length: HEAD_BYTES }, exec.signal)
}

/**
 * 增量行收集器：行窗口 + 字节上限 + 单行截断 + 总行数 + 换行统计。
 * 边读边丢，只有进入窗口的行留在内存里。
 * @param {{offset: number, limit: number}} request - 窗口参数。
 * @returns {{feed: (chunk: string) => void, finish: () => object}} 收集器。
 */
function makeCollector({ offset, limit }) {
  let totalLines = 0
  let outputBytes = 0
  let cappedByBytes = false
  let crlf = 0
  let lf = 0
  let carry = ''
  const lines = []

  const push = (raw) => {
    totalLines += 1
    if (raw.endsWith('\r')) crlf += 1
    else lf += 1
    if (cappedByBytes || totalLines < offset || lines.length >= limit) return
    let text = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (text.length > MAX_LINE_CHARS) {
      text = `${text.slice(0, MAX_LINE_CHARS)}…（本行已截断至 ${MAX_LINE_CHARS} 字符）`
    }
    const cost = Buffer.byteLength(text, 'utf8') + 1
    if (outputBytes + cost > MAX_OUTPUT_BYTES) {
      cappedByBytes = true
      return
    }
    outputBytes += cost
    lines.push(text)
  }

  return {
    feed(chunk) {
      carry += chunk
      let index
      while ((index = carry.indexOf('\n')) !== -1) {
        push(carry.slice(0, index))
        carry = carry.slice(index + 1)
      }
    },
    finish() {
      if (carry !== '') push(carry)
      const eol = crlf > 0 && lf > 0 ? 'mixed' : crlf > 0 ? 'crlf' : lf > 0 ? 'lf' : 'none'
      return { lines, totalLines, cappedByBytes, eol }
    }
  }
}

/**
 * 字面量替换第一处（不用 String.replace，避免 `$&` 之类被当成替换模式）。
 * @param {string} text - 原文。
 * @param {string} search - 查找串。
 * @param {string} replacement - 替换串。
 * @returns {string} 结果。
 */
function replaceFirst(text, search, replacement) {
  const index = text.indexOf(search)
  if (index === -1) return text
  return text.slice(0, index) + replacement + text.slice(index + search.length)
}

/**
 * 非 UTF-8 写回绕过了 fs 服务，这里手动兑现观测策略给出的写意图。
 * @param {object|undefined} intent - `fs/write-intent` 的返回值。
 * @param {object|undefined} info - 既有文件信息。
 * @param {string} displayPath - 展示路径。
 */
function assertIntent(intent, info, displayPath) {
  if (intent === undefined) return
  if (intent.kind === 'createIfAbsent' && info !== undefined) {
    throw new Error(`"${displayPath}" 已存在（写意图要求仅新建）`)
  }
  if (intent.kind === 'replaceIfVersion') {
    if (info === undefined) throw new Error(`"${displayPath}" 不存在（写意图要求替换既有版本）`)
    if (info.version !== undefined && info.version !== intent.version) {
      throw new Error(`"${displayPath}" 在读取之后被改动过（版本不匹配），请重新读取后再改`)
    }
  }
}

/** 读文件的元数据头。 */
function readHeader(value) {
  const attrs = [
    `path="${value.path}"`,
    `encoding="${encodingLabel(value.encoding, value.bom)}"`,
    `eol="${eolLabel(value.eol)}"`,
    `lines="${value.from}-${value.to}/${value.total_lines}"`
  ]
  if (value.truncated === true) attrs.push('truncated="true"')
  if (value.capped_by_bytes === true) attrs.push('capped-by-bytes="true"')
  if (value.lossy === true) attrs.push('lossy="true"')
  if (value.remote === true) attrs.push('remote="true"')
  return `<file ${attrs.join(' ')}/>`
}

/**
 * 定义 read_text。
 * @param {object} ctx - 插件上下文。
 * @returns {object} 工具定义。
 */
function readTextDefinition(ctx) {
  return {
    name: 'read',
    description: '读取文本文件（本地或 `代号:/远程/路径`），返回带行号的内容与编码、换行、总行数；'
      + '单次输出受 256KB 字节与单行 8000 字符上限保护，被截断时给出续读 offset。'
      + '同时看几个文件用 read_many；按内容检索用 grep。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        file_path: { type: 'string', description: '文件路径；相对路径以当前会话工作目录为基准；`nas:/data/a.md` 表示远程主机。也接受 path。' },
        offset: { type: 'number', description: '起始行号，从 1 开始。默认 1；越界会报错。' },
        limit: { type: 'number', description: `本次最多返回的行数，默认 ${DEFAULT_LINE_LIMIT}，上限 ${MAX_LINE_LIMIT}（超过会报错，不会静默截断）。` },
        numbered: { type: 'boolean', description: '是否给每行加 `行号+制表符` 前缀。默认 true。' }
      },
      required: ['file_path']
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          encoding: { type: 'string' },
          bom: { type: 'boolean' },
          eol: { type: 'string' },
          total_lines: { type: 'integer' },
          from: { type: 'integer' },
          to: { type: 'integer' },
          truncated: { type: 'boolean' },
          capped_by_bytes: { type: 'boolean' },
          lossy: { type: 'boolean' },
          remote: { type: 'boolean' },
          text: { type: 'string' }
        },
        required: ['path', 'encoding', 'bom', 'eol', 'total_lines', 'from', 'to', 'truncated', 'capped_by_bytes', 'text']
      },
      render: (_args, value) => {
        const footer = value.truncated
          ? `\n\n（已显示第 ${value.from}-${value.to} 行 / 共 ${value.total_lines} 行；继续读用 offset=${value.to + 1}${value.capped_by_bytes ? '；本窗口受字节上限截断' : ''}）`
          : ''
        return [{ type: 'text', text: `${readHeader(value)}\n${value.text}${footer}` }]
      }
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const requested = normalizePathInput(args?.file_path ?? args?.path, 'file_path')
      const offset = optionalPositiveInt(args?.offset, 'offset', 1)
      const requestedLimit = optionalPositiveInt(args?.limit, 'limit', DEFAULT_LINE_LIMIT)
      if (requestedLimit > MAX_LINE_LIMIT) {
        throw new Error(`limit 上限是 ${MAX_LINE_LIMIT} 行（收到 ${requestedLimit}）；要读更多请用 offset 分批读`)
      }
      const limit = requestedLimit
      const numbered = args?.numbered !== false
      const opened = await openTarget(ctx, exec, requested)
      if (opened.info === undefined) throw new Error(`无法读取 "${opened.displayPath}"：路径不存在`)
      if (opened.info.type === 'directory') throw new Error(`"${opened.displayPath}" 是目录，请改用 list_dir`)
      if (opened.info.type !== 'file') throw new Error(`无法读取 "${opened.displayPath}"：不是常规文件`)

      const collector = makeCollector({ offset, limit })
      const head = await readHead(ctx, exec, opened)
      const headDecoded = decodeText(head)
      const encoding = headDecoded.encoding
      const bom = headDecoded.bom
      let lossy = headDecoded.lossy

      if (opened.kind === 'remote') {
        const size = opened.info.size
        if (size !== undefined && size > MAX_REMOTE_BYTES) {
          throw new Error(`无法读取 "${opened.displayPath}"：${formatBytes(size)} 超过远程单次读上限 ${formatBytes(MAX_REMOTE_BYTES)}`)
        }
        const bytes = await remoteReadBytes(ctx, exec, opened.remote, MAX_REMOTE_BYTES)
        if (bom === false && looksBinary(bytes)) {
          throw new Error(`无法读取 "${opened.displayPath}"：看起来是二进制文件（含 NUL 字节），read_text 只处理文本`)
        }
        const decoded = decodeText(bytes)
        lossy = decoded.lossy
        collector.feed(decoded.text)
      } else if (encoding !== 'utf-8') {
        const size = opened.info.size
        if (size !== undefined && size > MAX_IN_MEMORY_BYTES) {
          throw new Error(`无法读取 "${opened.displayPath}"：${formatBytes(size)} 的非 UTF-8 文件（${encoding}）超过 ${formatBytes(MAX_IN_MEMORY_BYTES)}；流式读取只支持 UTF-8，请先转换编码`)
        }
        const bytes = await ctx.fs.readBytes(opened.target, exec.signal, MAX_IN_MEMORY_BYTES)
        if (bom === false && looksBinary(bytes)) {
          throw new Error(`无法读取 "${opened.displayPath}"：看起来是二进制文件（含 NUL 字节），read_text 只处理文本`)
        }
        const decoded = decodeText(bytes)
        lossy = decoded.lossy
        collector.feed(decoded.text)
      } else {
        if (bom === false && looksBinary(head)) {
          throw new Error(`无法读取 "${opened.displayPath}"：看起来是二进制文件（含 NUL 字节），read_text 只处理文本`)
        }
        const size = opened.info.size
        const stream = size === undefined || size >= STREAM_MIN_SIZE
          ? await ctx.fs.streamText(opened.target, exec.signal)
          : [await ctx.fs.readText(opened.target, exec.signal)]
        let first = true
        for await (const chunk of stream) {
          collector.feed(first && bom ? stripBom(chunk) : chunk)
          first = false
        }
      }

      const { lines, totalLines, cappedByBytes, eol } = collector.finish()
      if (!cappedByBytes && totalLines > 0 && offset > totalLines) {
        throw new Error(`offset ${offset} 超出范围："${opened.displayPath}" 共 ${totalLines} 行`)
      }
      if (opened.kind === 'local') {
        ctx.emit('fs/observed', opened.target, { kind: 'present', version: opened.info.version }, exec)
      }
      const from = Math.min(offset, Math.max(totalLines, 1))
      const to = lines.length === 0 ? from - 1 : from + lines.length - 1
      return {
        path: opened.displayPath,
        encoding,
        bom,
        eol,
        total_lines: totalLines,
        from,
        to,
        truncated: to < totalLines,
        capped_by_bytes: cappedByBytes,
        ...(lossy === true ? { lossy: true } : {}),
        ...(opened.kind === 'remote' ? { remote: true } : {}),
        text: numbered
          ? lines.map((line, index) => `${from + index}\t${line}`).join('\n')
          : lines.join('\n')
      }
    },
    presentCall(args) {
      const filePath = args.file_path ?? args.path
      return { card: 'generic', title: `读取 ${filePath}`, kind: 'read', locations: [{ path: filePath }] }
    }
  }
}

/**
 * 定义 write_text。
 * @param {object} ctx - 插件上下文。
 * @returns {object} 工具定义。
 */
function writeTextDefinition(ctx) {
  return {
    name: 'write',
    description: '整文件写入；**按目标文件的原字符集编码写回**（GBK / UTF-16 也支持），默认沿用原文件的换行与 BOM。'
      + '支持 `代号:/远程/路径`。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        file_path: { type: 'string', description: '目标文件路径；`nas:/data/a.md` 表示远程主机。也接受 path。' },
        content: { type: 'string', description: '完整的新内容，会整文件覆盖。' },
        eol: { type: 'string', enum: ['crlf', 'lf', 'cr'], description: '强制换行风格；省略则沿用既有文件（新文件默认 LF）。' },
        bom: { type: 'boolean', description: '是否写 BOM；省略则沿用既有文件（新文件默认不带）。' },
        ...escalationSchemaFields(ctx)
      },
      required: ['file_path', 'content']
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          operation: { type: 'string', enum: ['create', 'update'] },
          bytes: { type: 'integer' },
          eol: { type: 'string' },
          bom: { type: 'boolean' },
          encoding: { type: 'string' },
          remote: { type: 'boolean' }
        },
        required: ['path', 'operation', 'bytes', 'eol', 'bom', 'encoding']
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.operation === 'create' ? '已创建' : '已覆盖'} ${value.path}（${encodingLabel(value.encoding, value.bom)} · ${eolLabel(value.eol)} · ${formatBytes(value.bytes)}）`
      }]
    },
    async execute(args, exec) {
      const requested = normalizePathInput(args?.file_path ?? args?.path, 'file_path')
      if (typeof args?.content !== 'string') throw new Error('content 必须是字符串')
      const policy = await resolveWritePolicy(ctx, exec, args, 'write')
      const opened = await openTarget(ctx, exec, requested, { forWrite: true, policy })

      let eol = args?.eol
      let bom = args?.bom
      let encoding = 'utf-8'
      let operation = opened.info === undefined ? 'create' : 'update'
      if (opened.info?.type === 'file') {
        const head = await readHead(ctx, exec, opened)
        const detected = decodeText(head)
        encoding = detected.encoding
        if (!canEncode(encoding)) {
          throw new Error(`无法写入 "${opened.displayPath}"：该文件是 ${encodingLabel(encoding, detected.bom)}，不支持按该字符集编码写回`)
        }
        eol = eol ?? dominantEol(detected.text, DEFAULT_NEW_EOL)
        bom = bom ?? detected.bom
      } else {
        eol = eol ?? DEFAULT_NEW_EOL
        bom = bom ?? false
      }

      const body = normalizeEol(stripBom(args.content), eol)
      const intent = opened.kind === 'local'
        ? await ctx.waterfall('fs/write-intent', opened.target, exec, () => undefined)
        : undefined

      let bytes
      if (opened.kind === 'remote') {
        const payload = await encodeText(ctx, exec, body, encoding, bom)
        const result = await remoteWriteBytes(ctx, exec, opened.remote, payload)
        bytes = result.bytes
      } else if (encoding === 'utf-8') {
        const text = bom ? `\uFEFF${body}` : body
        let outcome
        try {
          outcome = await ctx.fs.writeText(opened.target, text, intent, exec.signal, opened.policy)
        } catch (error) {
          throw withSandboxHint(error, opened.policy)
        }
        bytes = utf8Bytes(text)
        operation = outcome.operation
        ctx.emit('fs/observed', opened.target, { kind: 'present', version: outcome.version }, exec)
      } else {
        assertIntent(intent, opened.info, opened.displayPath)
        // 非 UTF-8 走 Python 助手直接落盘，绕过了 fs 服务 → 围栏自检必须自己做
        await assertPathAllowed(ctx, opened.policy, opened.target)
        const result = await encodeWriteFile(ctx, exec, opened.target, body, encoding, bom)
        bytes = result.bytes
        const after = await ctx.fs.stat(opened.target, exec.signal)
        if (after !== undefined) ctx.emit('fs/observed', opened.target, { kind: 'present', version: after.version }, exec)
      }

      return {
        path: opened.displayPath,
        operation,
        bytes,
        eol,
        bom,
        encoding,
        ...(opened.kind === 'remote' ? { remote: true } : {})
      }
    },
    presentCall(args) {
      const filePath = args.file_path ?? args.path
      // 与出货 @deepseek-ai/dsh-tool-fs 的 write 卡同形状（card: 'diff' + diffs），
      // 不再用 generic/kind:'edit'（契约里写卡是 diff 卡）。
      return {
        card: 'diff',
        title: `写入 ${filePath}`,
        diffs: [{ path: filePath, oldText: null, newText: typeof args.content === 'string' ? args.content : '' }],
        locations: [{ path: filePath }]
      }
    }
  }
}

/**
 * 定义 edit_text。
 * @param {object} ctx - 插件上下文。
 * @returns {object} 工具定义。
 */
function editTextDefinition(ctx) {
  return {
    name: 'edit',
    description: '按字面量替换文本，匹配前先把换行统一成文件既有风格；非 UTF-8 文件按原字符集写回。支持 `代号:/远程/路径`。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        file_path: { type: 'string', description: '文件路径；`nas:/data/a.md` 表示远程主机。也接受 path。' },
        old_string: { type: 'string', description: '要被替换的原文，换行风格可以随意写。' },
        new_string: { type: 'string', description: '替换后的文本；空字符串表示删除。' },
        replace_all: { type: 'boolean', description: '是否替换全部出现位置。默认 false，此时 old_string 必须唯一。' },
        ...escalationSchemaFields(ctx)
      },
      required: ['file_path', 'old_string', 'new_string']
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          replaced: { type: 'integer' },
          eol: { type: 'string' },
          encoding: { type: 'string' },
          remote: { type: 'boolean' }
        },
        required: ['path', 'replaced', 'eol', 'encoding']
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已替换 ${value.path} 中的 ${value.replaced} 处（按 ${eolLabel(value.eol)} 规范化后匹配；${value.encoding} 写回）`
      }]
    },
    async execute(args, exec) {
      const requested = normalizePathInput(args?.file_path ?? args?.path, 'file_path')
      const oldRaw = typeof args?.old_string === 'string' ? args.old_string : undefined
      const newRaw = typeof args?.new_string === 'string' ? args.new_string : undefined
      if (oldRaw === undefined || oldRaw === '') throw new Error('old_string 必须是非空字符串')
      if (newRaw === undefined) throw new Error('new_string 必须是字符串')
      const policy = await resolveWritePolicy(ctx, exec, args, 'edit')
      const opened = await openTarget(ctx, exec, requested, { forWrite: true, policy })
      if (opened.info === undefined) throw new Error(`无法编辑 "${opened.displayPath}"：路径不存在`)
      if (opened.info.type !== 'file') throw new Error(`无法编辑 "${opened.displayPath}"：不是常规文件`)
      if (opened.info.size !== undefined && opened.info.size > MAX_IN_MEMORY_BYTES) {
        throw new Error(`无法编辑 "${opened.displayPath}"：${formatBytes(opened.info.size)} 超过 ${formatBytes(MAX_IN_MEMORY_BYTES)} 上限`)
      }

      const bytes = opened.kind === 'remote'
        ? await remoteReadBytes(ctx, exec, opened.remote, MAX_IN_MEMORY_BYTES)
        : await ctx.fs.readBytes(opened.target, exec.signal, MAX_IN_MEMORY_BYTES)
      const decoded = decodeText(bytes)
      if (!canEncode(decoded.encoding)) {
        throw new Error(`无法编辑 "${opened.displayPath}"：该文件是 ${encodingLabel(decoded.encoding, decoded.bom)}，不支持按该字符集写回`)
      }
      const eol = dominantEol(decoded.text, DEFAULT_NEW_EOL)
      const oldString = normalizeEol(stripBom(oldRaw), eol)
      const newString = normalizeEol(stripBom(newRaw), eol)
      if (oldString === newString) throw new Error('old_string 与 new_string 相同，这次编辑没有意义')
      const occurrences = decoded.text.split(oldString).length - 1
      const replaceAll = args?.replace_all === true
      if (occurrences === 0) {
        throw new Error(`在 "${opened.displayPath}" 中找不到 old_string（已按 ${eolLabel(eol)} 规范化换行）。请先用 read_text 确认原文，注意行首缩进与全角/半角符号。`)
      }
      if (occurrences > 1 && !replaceAll) {
        throw new Error(`old_string 在 "${opened.displayPath}" 中出现 ${occurrences} 次，不唯一。请补足上下文使其唯一，或传 replace_all: true。`)
      }

      const fastPath = opened.kind === 'local' && decoded.encoding === 'utf-8'
      if (fastPath) {
        try {
          await ctx.fs.editText(
            opened.target,
            { oldString, newString, replaceAll },
            { version: opened.info.version },
            exec.signal,
            opened.policy
          )
        } catch (error) {
          throw withSandboxHint(error, opened.policy)
        }
        const after = await ctx.fs.stat(opened.target, exec.signal)
        if (after !== undefined) ctx.emit('fs/observed', opened.target, { kind: 'present', version: after.version }, exec)
      } else {
        const updated = replaceAll
          ? decoded.text.split(oldString).join(newString)
          : replaceFirst(decoded.text, oldString, newString)
        if (opened.kind === 'remote') {
          const payload = await encodeText(ctx, exec, updated, decoded.encoding, decoded.bom)
          await remoteWriteBytes(ctx, exec, opened.remote, payload)
        } else {
          const intent = await ctx.waterfall('fs/write-intent', opened.target, exec, () => undefined)
          assertIntent(intent, opened.info, opened.displayPath)
          // 非 UTF-8 走 Python 助手直接落盘，绕过了 fs 服务 → 围栏自检必须自己做
          await assertPathAllowed(ctx, opened.policy, opened.target)
          await encodeWriteFile(ctx, exec, opened.target, updated, decoded.encoding, decoded.bom)
          const after = await ctx.fs.stat(opened.target, exec.signal)
          if (after !== undefined) ctx.emit('fs/observed', opened.target, { kind: 'present', version: after.version }, exec)
        }
      }

      return {
        path: opened.displayPath,
        replaced: replaceAll ? occurrences : 1,
        eol,
        encoding: decoded.encoding,
        ...(opened.kind === 'remote' ? { remote: true } : {})
      }
    },
    presentCall(args) {
      const filePath = args.file_path ?? args.path
      // 与出货 @deepseek-ai/dsh-tool-fs 的 edit 卡同形状（card: 'diff' + diffs）。
      return {
        card: 'diff',
        title: `编辑 ${filePath}`,
        diffs: [{
          path: filePath,
          oldText: typeof args.old_string === 'string' ? args.old_string : null,
          newText: typeof args.new_string === 'string' ? args.new_string : ''
        }],
        locations: [{ path: filePath }]
      }
    }
  }
}

/**
 * 定义 list_dir。
 * @param {object} ctx - 插件上下文。
 * @returns {object} 工具定义。
 */
/**
 * 把文件名通配转成正则：`*` 不跨目录、`**` 跨目录、`?` 单字符。
 * @param {string} pattern - 通配串，如 `*.diff`。
 * @returns {RegExp} 匹配文件名的正则。
 */
export function globToRegExp(pattern) {
  const source = String(pattern ?? '*')
    .replace(/[.+^${}()|[\]\\]/gu, '\\$&')
    .replace(/\*\*/gu, '\u0000')
    .replace(/\*/gu, '[^/]*')
    .replace(/\?/gu, '.')
    .replace(/\u0000/gu, '.*')
  return new RegExp(`^${source}$`, 'u')
}

/**
 * 递归收集匹配通配的文件（本地与远程都支持），覆盖"一个目录下批量看文件"的场景。
 * @param {object} ctx - 插件上下文。
 * @param {object} exec - 工具执行上下文。
 * @param {string} rootInput - 起始路径（目录或文件）。
 * @param {string} pattern - 文件名通配。
 * @param {{depth: number, maxFiles: number}} limits - 深度与数量上限。
 * @returns {Promise<string[]>} 匹配到的路径。
 */
async function collectByGlob(ctx, exec, rootInput, pattern, limits) {
  const expression = globToRegExp(pattern)
  const found = []
  const walk = async (input, depth) => {
    if (found.length >= limits.maxFiles) return
    const opened = await openTarget(ctx, exec, input)
    if (opened.info === undefined) return
    if (opened.info.type !== 'directory') {
      if (expression.test(input.split(/[\\/]/u).pop() ?? input)) found.push(input)
      return
    }
    const children = opened.kind === 'remote'
      ? await remoteList(ctx, exec, opened.remote)
      : await ctx.fs.listDir(opened.target, exec.signal)
    for (const entry of children) {
      if (found.length >= limits.maxFiles) return
      const child = opened.kind === 'remote'
        ? `${String(opened.displayPath).replace(/\/$/u, '')}/${entry.name}`
        : `${input.replace(/[\\/]$/u, '')}/${entry.name}`
      if (entry.type === 'directory') {
        if (depth < limits.depth) await walk(child, depth + 1)
      } else if (expression.test(String(entry.name))) {
        found.push(child)
      }
    }
  }
  await walk(rootInput, 1)
  return found
}

/**
 * 把一条目录项渲染成一行文本。
 * @param {{name: string, type: string, size?: number, time?: number|string}} row - 条目。
 * @returns {string} 文本行。
 */
function renderEntry(row) {
  const size = row.size === undefined ? '' : ` ${formatBytes(row.size)}`
  let time = ''
  if (typeof row.time === 'number' && Number.isFinite(row.time)) {
    const stamp = row.time < 1e12 ? row.time * 1000 : row.time
    time = ` ${new Date(stamp).toISOString().slice(0, 16).replace('T', ' ')}`
  } else if (typeof row.time === 'string' && row.time !== '') {
    time = ` ${row.time.slice(0, 16).replace('T', ' ')}`
  }
  return `${row.type === 'directory' ? '[目录]' : '[文件]'} ${row.name}${size}${time}`
}

function listDirDefinition(ctx) {
  return {
    name: 'list_dir',
    description: '列出目录的直接子项（名称、类型、大小、修改时间），或给一个文件路径时返回该文件的详情；'
      + '不读取内容，支持 `代号:/远程/路径`。要按名字找文件用 glob、按内容找用 grep。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: '目录或文件路径；省略则用当前会话工作目录；`nas:/data` 表示远程主机。' },
        sort: { type: 'string', enum: ['name', 'mtime', 'size'], description: '排序依据，默认 name（按名排序时目录在前）。' },
        order: { type: 'string', enum: ['asc', 'desc'], description: '排序方向，默认 asc。' }
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          kind: { type: 'string' },
          entries: { type: 'array', items: { type: 'string' } },
          truncated: { type: 'boolean' },
          remote: { type: 'boolean' }
        },
        required: ['path', 'kind', 'entries', 'truncated']
      },
      render: (_args, value) => [{
        type: 'text',
        text: `<${value.kind === 'file' ? 'file-info' : 'dir'} path="${value.path}" count="${value.entries.length}"${value.truncated ? ' truncated="true"' : ''}${value.remote === true ? ' remote="true"' : ''}/>\n${value.entries.join('\n')}`
      }]
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const requested = typeof args?.path === 'string' && args.path.trim() !== '' ? normalizePathInput(args.path, 'path') : '.'
      const opened = await openTarget(ctx, exec, requested)
      if (opened.info === undefined) throw new Error(`无法列出 "${opened.displayPath}"：路径不存在`)
      const sortKey = args?.sort === 'mtime' || args?.sort === 'size' ? args.sort : 'name'
      const descending = args?.order === 'desc'
      const remoteFlag = opened.kind === 'remote' ? { remote: true } : {}

      // 给的是文件：只回报该文件详情（相当于零成本的 stat，不读内容）
      if (opened.info.type !== 'directory') {
        const row = {
          name: opened.displayPath.split(/[\\/]/u).pop() ?? opened.displayPath,
          type: opened.info.type,
          size: opened.info.size,
          time: opened.info.mtime ?? opened.info.modifiedAt ?? opened.info.mtimeMs
        }
        return { path: opened.displayPath, kind: opened.info.type, entries: [renderEntry(row)], truncated: false, ...remoteFlag }
      }

      const children = opened.kind === 'remote'
        ? await remoteList(ctx, exec, opened.remote)
        : await ctx.fs.listDir(opened.target, exec.signal)
      // 带大小与修改时间，并支持按名 / 修改时间 / 大小排序 —— "哪个最新、哪个最大"不必再回落到 ls -t / ls -S。
      const rows = children.map((entry) => ({
        name: String(entry.name),
        type: entry.type,
        size: typeof entry.size === 'number' ? entry.size : undefined,
        time: entry.mtime ?? entry.modifiedAt ?? entry.mtimeMs
      }))
      const stamp = (row) => {
        if (typeof row.time === 'number' && Number.isFinite(row.time)) return row.time < 1e12 ? row.time * 1000 : row.time
        if (typeof row.time === 'string' && row.time !== '') return Date.parse(row.time) || 0
        return 0
      }
      rows.sort((left, right) => {
        if (sortKey === 'name' && (left.type === 'directory') !== (right.type === 'directory')) {
          return left.type === 'directory' ? -1 : 1
        }
        const raw = sortKey === 'mtime'
          ? stamp(left) - stamp(right)
          : (sortKey === 'size' ? (left.size ?? 0) - (right.size ?? 0) : left.name.localeCompare(right.name, 'zh'))
        return descending ? -raw : raw
      })
      const entries = rows.map((row) => renderEntry(row))
      return {
        path: opened.displayPath,
        kind: 'directory',
        entries: entries.slice(0, MAX_DIR_ENTRIES),
        truncated: entries.length > MAX_DIR_ENTRIES,
        ...remoteFlag
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `列出 ${args.path ?? '.'}`, kind: 'search' }
    }
  }
}

/**
 * 一次读多个文件：覆盖 `cat a b c` 这类"同时看几个文件"的场景。
 * 内部复用 read 工具，所以每个文件仍受同样的编码/换行兜底、行号、截断与续读提示保护；
 * 单个文件读失败不影响其它文件（失败项单独回报）。
 * @param {object} ctx - 插件上下文。
 * @param {object} readTool - 已注册的 read 工具定义。
 * @returns {object} 工具定义。
 */
function readManyDefinition(ctx, readTool) {
  return {
    name: 'read_many',
    description: '一次读取多个文本文件（各自带行号、编码与总行数），用于同时看几个文件；'
      + '单个文件读失败不影响其它文件，失败项单独回报。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: '目录路径（本地或 `代号:/远程/路径`）；与 glob 搭配可一次读一批文件。' },
        glob: { type: 'string', description: '文件名通配，默认 *；支持 * 与 ?，** 跨目录（如 `*.diff`）。' },
        depth: { type: 'number', description: `目录递归深度（仅 path + glob 模式），默认 ${DEFAULT_READ_MANY_DEPTH}，上限 ${MAX_READ_MANY_DEPTH}（超过会报错）。` },
        max_files: { type: 'number', description: `最多读多少个文件（两种模式都受此约束），默认 ${DEFAULT_READ_MANY_FILES}，上限 ${MAX_READ_MANY_FILES}（超过会报错）。` },
        file_paths: {
          type: 'array',
          items: { type: 'string' },
          description: `文件路径列表（本地或 \`代号:/远程/路径\`）；个数超过 max_files（默认 ${DEFAULT_READ_MANY_FILES}）会报错，不再静默丢弃多余的。`
        },
        numbered: { type: 'boolean', description: '是否带行号，默认 true。' },
        limit: { type: 'number', description: `每个文件最多读多少行，默认 ${DEFAULT_LINE_LIMIT}，上限 ${MAX_LINE_LIMIT}（超过会报错）。` }
      },
      required: []
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer' },
          files: { type: 'array', items: { type: 'object' } },
          failed: { type: 'array', items: { type: 'object' } }
        },
        required: ['count', 'files', 'failed']
      },
      render: (_args, value) => [{
        type: 'text',
        text: `<read-many count="${value.count}" failed="${value.failed.length}"/>\n`
          + value.files.map((item) => item.text).join('\n\n')
          + (value.failed.length === 0
            ? ''
            : `\n\n读取失败：\n${value.failed.map((item) => `- ${item.path}：${item.error}`).join('\n')}`)
      }]
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      // 上限一律**先校验**：无论走哪条分支，越界都报错，绝不静默夹取或忽略。
      // depth 只在 path+glob 模式下生效，但给了越界值仍然是调用方的错误。
      const depth = boundedIntParam(args?.depth, 'depth', DEFAULT_READ_MANY_DEPTH, 1, MAX_READ_MANY_DEPTH)
      const maxFiles = boundedIntParam(args?.max_files, 'max_files', DEFAULT_READ_MANY_FILES, 1, MAX_READ_MANY_FILES)
      const explicit = Array.isArray(args?.file_paths)
        ? args.file_paths.filter((item) => typeof item === 'string' && item.trim() !== '')
        : []
      // 以前这里静默 slice(0, 20)：超出部分被无声丢弃。改为报错，并把口径统一到 max_files。
      if (explicit.length > maxFiles) {
        throw new Error(`file_paths 有 ${explicit.length} 个，超过 max_files=${maxFiles}；`
          + `请分批读，或把 max_files 调大（上限 ${MAX_READ_MANY_FILES}）`)
      }
      let list = explicit
      const root = typeof args?.path === 'string' && args.path.trim() !== '' ? args.path.trim() : undefined
      if (list.length === 0 && root !== undefined) {
        // 目录 + 通配：一次读一批文件（替代 shell 里的 for 循环）
        list = await collectByGlob(ctx, exec, root, typeof args?.glob === 'string' && args.glob !== '' ? args.glob : '*', { depth, maxFiles })
      }
      if (list.length === 0) throw new Error('read_many 需要 file_paths，或 path（可选 glob，如 *.diff）')
      const files = []
      const failed = []
      for (const path of list) {
        try {
          const value = await readTool.execute({
            file_path: path,
            ...(args?.numbered === undefined ? {} : { numbered: args.numbered }),
            ...(args?.limit === undefined ? {} : { limit: args.limit })
          }, exec)
          files.push({
            path: value.path,
            lines: value.total_lines,
            text: `<file path="${value.path}" lines="${value.total_lines}"/>\n${value.text}`
          })
        } catch (problem) {
          failed.push({ path, error: problem instanceof Error ? problem.message : String(problem) })
        }
      }
      return { count: files.length, files, failed }
    }
  }
}

/**
 * 挂载文本文件工具。
 * @param {object} ctx - preset 作用域的插件上下文。
 */
export function apply(ctx) {
  const register = createToolRegistrar(ctx)
  const readTool = readTextDefinition(ctx)
  register(readTool)
  register(readManyDefinition(ctx, readTool))
  register(writeTextDefinition(ctx))
  register(editTextDefinition(ctx))
  register(listDirDefinition(ctx))
}
