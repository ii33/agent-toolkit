/**
 * split_file：把大文本文件拆成有编号的块文件，并写出一份 manifest.json。
 *
 * 为什么它是流水线的第一阶段：模型一次只装得下一小块，所以「拆分」必须
 * 在进入模型之前完成；产物是磁盘上的块文件 + 清单，而不是对话里的正文。
 *
 * 行为要点：
 *   - 源文件按 UTF-8 → GBK/Big5 回退解码，块一律写成 UTF-8（顺带完成编码归一化）；
 *   - 块文件用 LF 换行，源文件的原换行与编码记进 manifest，供最后合并时还原；
 *   - 父目录不存在会自动创建（本地 fs 后端行为）；
 *   - 结果只回传块数与前若干个文件名，不把内容塞进上下文。
 *
 * @module @local/dsh-doc-pipeline/split
 */
import { decodeText, detectEol, splitLines } from '../lib/encoding.js'
import { currentPolicy, formatBytes, optionalPositiveInt, requireString, resolveOptions, utf8Bytes } from '../lib/fs-common.js'
import { chunkName, planByteChunks, planLineChunks, planMarkerChunks } from '../lib/split-plan.js'
import { createToolRegistrar } from './registry.js'

/** 需要工具注册表与文件系统。 */
export const inject = ['tools', 'fs']

/** 源文件上限：拆分需要把源读进内存，超过这个体积请交给外部工具先切。 */
const MAX_SOURCE_BYTES = 64 * 1024 * 1024

/** 默认块大小。 */
const DEFAULT_LINES_PER_CHUNK = 200
const DEFAULT_CHARS_PER_CHUNK = 12000

/** 结果里最多列出的块文件名数量。 */
const MAX_LISTED_FILES = 40

/**
 * 定义 split_file。
 * @param {object} ctx - 插件上下文。
 * @returns {object} 工具定义。
 */
function splitFileDefinition(ctx) {
  return {
    name: 'split_file',
    description: '把大文本文件按行数 / 字符预算 / 标题标记拆成有编号的块文件，并写出 manifest.json 供后续阶段使用。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: '源文件路径。' },
        out_dir: { type: 'string', description: '块文件输出目录，不存在会自动创建。' },
        mode: { type: 'string', enum: ['lines', 'bytes', 'marker'], description: '拆分方式，默认 lines。' },
        size: { type: 'number', description: `lines 模式为每块行数（默认 ${DEFAULT_LINES_PER_CHUNK}）；bytes 模式为每块字符预算（默认 ${DEFAULT_CHARS_PER_CHUNK}）。` },
        marker: { type: 'string', description: 'marker 模式的正则，如 `^#{1,3} `，匹配到的行作为下一块的开头。' },
        prefix: { type: 'string', description: '块文件名前缀，默认取源文件名（去扩展名）。' },
        extension: { type: 'string', description: '块文件扩展名，默认 .txt。' },
        overlap: { type: 'number', description: 'lines 模式下相邻块的重叠行数，默认 0。' }
      },
      required: ['path', 'out_dir']
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          source: { type: 'string' },
          out_dir: { type: 'string' },
          mode: { type: 'string' },
          count: { type: 'integer' },
          total_lines: { type: 'integer' },
          source_encoding: { type: 'string' },
          source_eol: { type: 'string' },
          manifest: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          truncated: { type: 'boolean' }
        },
        required: ['source', 'out_dir', 'mode', 'count', 'total_lines', 'source_encoding', 'source_eol', 'manifest', 'files', 'truncated']
      },
      render: (_args, value) => [{
        type: 'text',
        text: `<split source="${value.source}" mode="${value.mode}" chunks="${value.count}" lines="${value.total_lines}" encoding="${value.source_encoding}" eol="${value.source_eol}"/>\nmanifest: ${value.manifest}\n${value.files.join('\n')}${value.truncated ? '\n…其余块文件见 manifest' : ''}`
      }]
    },
    async execute(args, exec) {
      const source = requireString(args?.path, 'path')
      const outDir = requireString(args?.out_dir, 'out_dir')
      const mode = args?.mode === undefined ? 'lines' : args.mode
      if (!['lines', 'bytes', 'marker'].includes(mode)) throw new Error('mode 必须是 lines / bytes / marker')
      const extension = typeof args?.extension === 'string' && args.extension.trim() !== ''
        ? (args.extension.trim().startsWith('.') ? args.extension.trim() : `.${args.extension.trim()}`)
        : '.txt'
      const overlap = optionalPositiveInt(args?.overlap, 'overlap', 0, 0)

      const policy = currentPolicy(ctx, exec)
      const options = resolveOptions(exec, policy?.workspaceRoot, ctx)
      const target = await ctx.fs.resolve(source, options)
      const info = await ctx.fs.stat(target, exec.signal)
      if (info === undefined) throw new Error(`无法拆分 "${target.displayPath}"：路径不存在`)
      if (info.type !== 'file') throw new Error(`无法拆分 "${target.displayPath}"：不是常规文件`)
      if (info.size !== undefined && info.size > MAX_SOURCE_BYTES) {
        throw new Error(`无法拆分 "${target.displayPath}"：${formatBytes(info.size)} 超过 ${formatBytes(MAX_SOURCE_BYTES)} 上限，请先用外部工具切分`)
      }
      const bytes = await ctx.fs.readBytes(target, exec.signal, MAX_SOURCE_BYTES)
      const decoded = decodeText(bytes)
      const lines = splitLines(decoded.text)
      const sourceEol = detectEol(decoded.text)

      let chunks
      if (mode === 'lines') {
        chunks = planLineChunks(lines.length, optionalPositiveInt(args?.size, 'size', DEFAULT_LINES_PER_CHUNK), overlap)
      } else if (mode === 'bytes') {
        chunks = planByteChunks(lines, optionalPositiveInt(args?.size, 'size', DEFAULT_CHARS_PER_CHUNK))
      } else {
        const marker = requireString(args?.marker, 'marker')
        let pattern
        try {
          pattern = new RegExp(marker)
        } catch (error) {
          throw new Error(`marker 不是合法正则：${error instanceof Error ? error.message : String(error)}`)
        }
        chunks = planMarkerChunks(lines, pattern)
      }
      if (chunks.length === 0) throw new Error(`"${target.displayPath}" 没有可拆分的内容`)

      const base = target.displayPath.replace(/^.*[\\/]/u, '').replace(/\.[^.]*$/u, '')
      const prefix = typeof args?.prefix === 'string' && args.prefix.trim() !== '' ? args.prefix.trim() : base
      const manifest = []
      const written = []
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index]
        const name = chunkName(prefix, index + 1, extension)
        const content = `${lines.slice(chunk.from - 1, chunk.to).join('\n')}\n`
        const fileTarget = await ctx.fs.resolve(`${outDir.replace(/[\\/]$/u, '')}/${name}`, options)
        const intent = await ctx.waterfall('fs/write-intent', fileTarget, exec, () => undefined)
        const outcome = await ctx.fs.writeText(fileTarget, content, intent, exec.signal, policy)
        ctx.emit('fs/observed', fileTarget, { kind: 'present', version: outcome.version }, exec)
        written.push(name)
        manifest.push({
          index: index + 1,
          file: name,
          from: chunk.from,
          to: chunk.to,
          lines: chunk.to - chunk.from + 1,
          chars: utf8Bytes(content),
          ...(chunk.title === undefined ? {} : { title: chunk.title })
        })
      }

      const manifestName = `${prefix}.manifest.json`
      const manifestText = `${JSON.stringify({
        source: target.displayPath,
        source_encoding: decoded.encoding,
        source_eol: sourceEol,
        mode,
        chunks: manifest
      }, null, 2)}\n`
      const manifestTarget = await ctx.fs.resolve(`${outDir.replace(/[\\/]$/u, '')}/${manifestName}`, options)
      const manifestIntent = await ctx.waterfall('fs/write-intent', manifestTarget, exec, () => undefined)
      const manifestOutcome = await ctx.fs.writeText(manifestTarget, manifestText, manifestIntent, exec.signal, policy)
      ctx.emit('fs/observed', manifestTarget, { kind: 'present', version: manifestOutcome.version }, exec)

      return {
        source: target.displayPath,
        out_dir: outDir,
        mode,
        count: chunks.length,
        total_lines: lines.length,
        source_encoding: decoded.encoding,
        source_eol: sourceEol,
        manifest: manifestTarget.displayPath,
        files: written.slice(0, MAX_LISTED_FILES),
        truncated: written.length > MAX_LISTED_FILES
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `拆分 ${args.path}`, kind: 'edit', locations: [{ path: args.path }] }
    }
  }
}

/**
 * 挂载 split_file。
 * @param {object} ctx - preset 作用域的插件上下文。
 */
export function apply(ctx) {
  const register = createToolRegistrar(ctx)
  register(splitFileDefinition(ctx))
}
