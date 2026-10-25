/**
 * `search_remote`：在**远程主机**上做内容检索（本地检索用 harness 的 grep）。
 *
 * 为什么需要它：harness 的 grep / glob 只覆盖本地 ✗；远程工作流此前只能靠 `read` 逐个文件看 ✓，
 * 或者用 `sh` + `ssh`（会碰到远程 shell 禁令与引号地狱 ✗）。这里走 SFTP 侧车：递归列目录 →
 * 逐文件读（大小/二进制/数量都有上限）→ 正则匹配 → 只回报命中行 ✓。
 *
 * 有界输出：命中数、扫描文件数、单文件大小、目录深度都有上限，截断时明确标注 ✓。
 *
 * @module @local/dsh-agentkit/remote-search
 */
import { MAX_REMOTE_BYTES, remoteList, remoteReadBytes, remoteStat, resolveRemote } from '../lib/remote.js'
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS } from '../lib/exec.js'
import { createToolRegistrar } from './registry.js'

/** 只需要工具注册表。 */
export const inject = ['tools']

/** 默认/上限。 */
const DEFAULT_MAX_RESULTS = 50
const MAX_RESULTS_LIMIT = 500
const DEFAULT_MAX_FILES = 200
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024
const DEFAULT_DEPTH = 3
const MAX_DEPTH = 8
const MAX_LINE_CHARS = 300

/** 明显是二进制/不该搜的扩展名。 */
const SKIP_EXTENSIONS = [
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.pdf', '.zip', '.gz', '.tar', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.class', '.jar', '.pyc', '.woff', '.woff2', '.ttf', '.mp3', '.mp4', '.mov'
]

/**
 * 判断字节是否像二进制（有 NUL 字节）。
 * @param {Uint8Array} bytes - 文件字节。
 * @returns {boolean} 是否二进制。
 */
export function looksBinary(bytes) {
  const limit = Math.min(bytes.length, 4096)
  for (let index = 0; index < limit; index += 1) {
    if (bytes[index] === 0) return true
  }
  return false
}

/**
 * 纯匹配器：在一批"已读入的文件"里找命中行（便于离线单测）。
 * @param {Array<{path: string, text: string}>} files - 文件与内容。
 * @param {string} pattern - 正则源码。
 * @param {{maxResults?: number, flags?: string}} [options] - 选项。
 * @returns {{matches: object[], truncated: boolean}} 命中与是否被截断。
 */
export function collectMatches(files, pattern, options = {}) {
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS
  const expression = new RegExp(pattern, options.flags ?? 'u')
  const matches = []
  let truncated = false
  for (const file of files) {
    const lines = String(file.text ?? '').split(/\r?\n/u)
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (line.length > MAX_LINE_CHARS) {
        // 超长行只匹配前段，避免把整行带进上下文
        if (!expression.test(line.slice(0, MAX_LINE_CHARS))) continue
        matches.push({ path: file.path, line: index + 1, text: `${line.slice(0, MAX_LINE_CHARS)}…` })
      } else if (expression.test(line)) {
        matches.push({ path: file.path, line: index + 1, text: line })
      }
      if (matches.length >= maxResults) {
        truncated = true
        return { matches, truncated }
      }
    }
  }
  return { matches, truncated }
}

/**
 * 递归收集远程文件（深度与数量有上限）。
 * @param {object} ctx - 插件上下文。
 * @param {object} exec - 工具执行上下文。
 * @param {object} remote - resolveRemote 的结果。
 * @param {{depth: number, maxFiles: number}} limits - 上限。
 * @returns {Promise<{files: string[], truncated: boolean}>} 文件路径与是否截断。
 */
async function collectRemoteFiles(ctx, exec, remote, limits) {
  const files = []
  let truncated = false
  const walk = async (target, depth) => {
    if (files.length >= limits.maxFiles) {
      truncated = true
      return
    }
    let children
    try {
      children = await remoteList(ctx, exec, target)
    } catch {
      return
    }
    for (const entry of children) {
      if (files.length >= limits.maxFiles) {
        truncated = true
        return
      }
      // 字段名必须是 `remotePath`：lib/remote.js 的协议路径读的是 remote.remotePath。
      // 旧代码建的是 `path`（另一套老 API 的字段名），于是 `{...target}` 让子目录继承了
      // 父目录的 remotePath —— 递归 list 的是**父目录**，遍历会反复列出上层目录并合成
      // 一批并不存在的路径（/data/readme.md 之类），读它们全部失败 → unreadable 被灌水。
      const child = {
        ...target,
        remotePath: target.remotePath === '/' ? `/${entry.name}` : `${target.remotePath}/${entry.name}`,
        displayPath: `${target.displayPath.replace(/\/$/u, '')}/${entry.name}`
      }
      if (entry.type === 'directory') {
        if (depth < limits.depth) await walk(child, depth + 1)
      } else if (entry.type === 'file') {
        const lower = String(entry.name).toLowerCase()
        if (!SKIP_EXTENSIONS.some((extension) => lower.endsWith(extension))) files.push(child.displayPath)
      }
    }
  }
  await walk(remote, 1)
  return { files, truncated }
}

/**
 * 挂载远程检索工具。
 * @param {object} ctx - 插件上下文。
 */
export function apply(ctx) {
  const register = createToolRegistrar(ctx)
  register({
    name: 'search_remote',
    description: '在远程主机上按正则检索文件内容（本地检索用 grep）。返回命中的路径、行号与行内容；'
      + '递归深度、扫描文件数、单文件大小与命中数都有上限。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: '远程目录或文件，形如 `remote1:/srv/app`。' },
        pattern: { type: 'string', description: '正则表达式（JS 语法），例如 `TODO|FIXME`。' },
        depth: { type: 'number', description: `递归深度，默认 ${DEFAULT_DEPTH}，上限 ${MAX_DEPTH}。` },
        max_results: { type: 'number', description: `最多返回多少条命中，默认 ${DEFAULT_MAX_RESULTS}，上限 ${MAX_RESULTS_LIMIT}。` },
        max_files: { type: 'number', description: `最多扫描多少个文件，默认 ${DEFAULT_MAX_FILES}。` },
        timeout_ms: { type: 'number', description: `超时毫秒数，默认 ${DEFAULT_TIMEOUT_MS}，上限 ${MAX_TIMEOUT_MS}。` }
      },
      required: ['path', 'pattern']
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          pattern: { type: 'string' },
          scanned: { type: 'integer' },
          matches: { type: 'array', items: { type: 'object' } },
          truncated: { type: 'boolean' },
          unreadable: { type: 'integer' }
        },
        required: ['path', 'pattern', 'scanned', 'matches', 'truncated']
      },
      render: (_args, value) => [{
        type: 'text',
        text: `<search-remote path="${value.path}" pattern="${value.pattern}" scanned="${value.scanned}" matches="${value.matches.length}"${value.truncated ? ' truncated="true"' : ''}`
          + `${value.unreadable === undefined || value.unreadable === 0 ? '' : ` unreadable="${value.unreadable}"`}/>\n`
          + (value.matches.length === 0
            ? '（无命中）'
            : value.matches.map((item) => `${item.path}:${item.line}: ${item.text}`).join('\n'))
      }]
    },
    async execute(args, exec) {
      const input = String(args?.path ?? '').trim()
      const pattern = String(args?.pattern ?? '')
      if (input === '') throw new Error('search_remote 需要 path')
      if (pattern === '') throw new Error('search_remote 需要 pattern')
      try {
        // 先编译一次，正则写错时立刻报错（而不是每个文件都失败）
        void new RegExp(pattern, 'u')
      } catch (problem) {
        throw new Error(`pattern 不是合法正则：${problem instanceof Error ? problem.message : String(problem)}`)
      }
      const depth = Math.max(1, Math.min(MAX_DEPTH, Number(args?.depth ?? DEFAULT_DEPTH)))
      const maxResults = Math.max(1, Math.min(MAX_RESULTS_LIMIT, Number(args?.max_results ?? DEFAULT_MAX_RESULTS)))
      const maxFiles = Math.max(1, Number(args?.max_files ?? DEFAULT_MAX_FILES))
      const timeoutMs = args?.timeout_ms === undefined ? DEFAULT_TIMEOUT_MS : Number(args.timeout_ms)
      const remote = await resolveRemote(ctx, exec, input)
      if (remote === undefined) {
        throw new Error(`"${input}" 不是远程路径（远程要写 \`代号:/路径\`）；本地检索请用 grep`)
      }

      const started = Date.now()
      const single = await remoteStat(ctx, exec, remote)
      const targets = []
      let dirTruncated = false
      if (single !== undefined && single.type === 'file') {
        targets.push(remote.displayPath ?? input)
      } else {
        const collected = await collectRemoteFiles(ctx, exec, remote, { depth, maxFiles })
        targets.push(...collected.files)
        dirTruncated = collected.truncated
      }

      const files = []
      const seen = new Set()
      let unreadable = 0
      for (const path of targets) {
        // 同一路径可能被多条边走到（符号链接/多挂载点），去重避免把 scanned/unreadable 灌水。
        if (seen.has(path)) continue
        seen.add(path)
        if (Date.now() - started > timeoutMs) break
        try {
          const resolved = await resolveRemote(ctx, exec, path)
          if (resolved === undefined) continue
          const bytes = await remoteReadBytes(ctx, exec, resolved, Math.min(MAX_REMOTE_BYTES, DEFAULT_MAX_FILE_BYTES))
          if (looksBinary(bytes)) continue
          files.push({ path, text: Buffer.from(bytes).toString('utf8') })
        } catch {
          // 只有"确实是文件"才计入 unreadable：目录（含后端把目录误报成普通条目的情况）
          // 直接跳过。否则真实主机上每个目录都会让 unreadable 虚高，把模型带偏。
          let kind
          try {
            const again = await resolveRemote(ctx, exec, path)
            const info = again === undefined ? undefined : await remoteStat(ctx, exec, again)
            kind = info?.type
          } catch {
            kind = undefined
          }
          if (kind !== undefined && kind !== 'file') continue
          unreadable += 1
        }
      }

      const { matches, truncated } = collectMatches(files, pattern, { maxResults })
      return {
        path: remote.displayPath ?? input,
        pattern,
        scanned: files.length,
        matches,
        truncated: truncated || dirTruncated,
        unreadable
      }
    }
  })
}
