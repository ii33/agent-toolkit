/**
 * 文档能力：ocr_doc（docling 包装）、merge_files（按 manifest 合并）、pack（tar 打包）。
 *
 * 这三个工具是"由工具集兜底、不让模型猜参数"的典型：
 *   - ocr_doc 固定 docling 的调用形状，产物落盘，只回传文件清单；
 *   - merge_files 按 manifest 顺序合并，并还原源文件换行，避免手工拼接错序/丢块；
 *   - pack 用 bsdtar 按扩展名自动选格式（zip / tar.gz），不经过 shell。
 *
 * @module @local/dsh-doc-pipeline/doc
 */
import { existsSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { doclingArgv, tarPackArgv } from '../lib/argv.js'
import { normalizeEol, splitLines } from '../lib/encoding.js'
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, execCapture } from '../lib/exec.js'
import { currentPolicy, cwdFor, formatBytes, normalizePathInput, requireString, resolveOptions, utf8Bytes } from '../lib/fs-common.js'
import { createToolRegistrar } from './registry.js'

/** 需要工具注册表与文件系统。 */
export const inject = ['tools', 'fs']

/** 清单里最多列出的产物数量。 */
const MAX_LISTED_FILES = 40

/** 合并时的块数上限，避免误用超大 manifest 把内存吃满。 */
const MAX_CHUNKS = 5000

/** tar 家族与开关探测结果缓存（按 tar 可执行文件路径，进程级只探一次）。 */
const tarTraits = new Map()

/**
 * 探针用的工作目录：**绝不用 `process.cwd()`**。
 *
 * Desktop 宿主的进程 cwd 可能不是一个可用目录；`execCapture` 在那里会直接抛错，
 * 而"探针跑不起来"如果被当成"不是 GNU tar"，真实 pack 就会少 `--force-local`，
 * 于是 GNU tar 又把 `-f C:\...` 当远程主机（live 现场正是这样）。
 * @param {object} ctx - 插件上下文。
 * @param {object} exec - 工具执行上下文。
 * @param {string} executable - 已解析出来的可执行文件（它的目录一定存在）。
 * @returns {string} 一个确定可用的工作目录。
 */
function probeCwdFor(ctx, exec, executable) {
  try {
    const cwd = cwdFor(ctx, exec) // 与真正执行时那次 execCapture 用同一个 cwd
    if (typeof cwd === 'string' && cwd !== '') return cwd
  } catch {
    /* 没有会话上下文 → 退到可执行文件所在目录 */
  }
  return dirname(executable)
}

/** 路径看起来是不是 MSYS2/Cygwin/Git 那套 GNU tar（探测跑不起来时的保守判断依据）。 */
function looksLikeGnuTar(tar) {
  return /[\\/](?:msys64|usr|cygwin|git)[\\/]/iu.test(tar)
}

/**
 * 探测 tar 的家族能力：
 *   - GNU tar 把 `-f C:\...` 当**远程主机**（实测 `tar (child): Cannot connect to C: resolve failed`，
 *     归档 0 字节），必须用 `--force-local` 关掉这个行为；`--force-local --version` 被接受即 GNU 家族。
 *   - bsdtar 不认 `--force-local`，但它本来就把 `C:\...` 当本地路径，而且 `-a` 真的能写 zip。
 * 探针第一次用 {@link probeCwdFor}，失败再退到 tar 所在目录；**两次都跑不起来时不再假装"不是 GNU"**，
 * 而是按可执行文件位置给保守判断并记 warn。
 * @param {object} ctx - 插件上下文。
 * @param {object} exec - 工具执行上下文。
 * @param {string} tar - tar 可执行文件路径。
 * @returns {Promise<{gnu: boolean, forceLocal: boolean, zip: boolean, probed: boolean, cwd: string}>} 家族与能力。
 */
async function tarTraitsOf(ctx, exec, tar) {
  const cached = tarTraits.get(tar)
  if (cached !== undefined) return cached
  const primary = probeCwdFor(ctx, exec, tar)
  const attempts = primary === dirname(tar) ? [primary] : [primary, dirname(tar)]
  let probed = false
  let accepted = false
  let version = ''
  for (const cwd of attempts) {
    try {
      const probe = await execCapture(ctx, exec, {
        argv: [tar, '--force-local', '--version'],
        cwd,
        timeoutMs: 20_000
      })
      probed = true
      accepted = probe.exitCode === 0
      version = probe.output
      break
    } catch (error) {
      ctx.logger?.warn(`agentkit: 探测 tar 家族失败（cwd=${cwd}）：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  // 判定不依赖解析 --version 文本：
  //   - 接受 `--force-local` 的只有 GNU 家族（bsdtar/libarchive 从无此开关）→ 有 --force-local，且**没有 zip 写入能力**；
  //   - 拒绝它的按 bsdtar 处理（本来就把 C:\... 当本地路径，且 -a 真能写 zip）。
  // 之前的写法把 zip 能力绑在 /GNU tar/ 版本文本上：一旦版本输出取不到，就会把 .zip 交给 GNU tar，
  // 静默写出一个改名成 .zip 的 tar。
  const gnu = probed ? accepted : looksLikeGnuTar(tar)
  const forceLocal = probed ? accepted : gnu
  const traits = { gnu, forceLocal, zip: !gnu, probed, cwd: attempts[0], version: version.trim().split('\n')[0] ?? '' }
  if (probed) {
    ctx.logger?.info(`agentkit: tar 家族探测完成（cwd=${attempts[0]}）：gnu=${gnu} forceLocal=${forceLocal}`
      + `（${traits.version === '' ? '--version 无输出' : traits.version}）`)
  } else {
    ctx.logger?.warn(`agentkit: tar 家族探测两次都无法执行（cwd 试过 ${attempts.join(' / ')}）；`
      + `按可执行文件位置保守判断 gnu=${gnu} → ${forceLocal ? '加' : '不加'} --force-local，zip 能力按 ${gnu ? '不支持' : '支持'}处理`)
  }
  tarTraits.set(tar, traits)
  return traits
}

/**
 * 能写 zip 的 tar：Windows 10+ 自带的 bsdtar（PATH 上的 `tar` 在这台机器上是 MSYS2 的 GNU tar）。
 * @returns {string[]} 候选路径。
 */
function zipTarCandidates() {
  const systemRoot = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
  return [join(systemRoot, 'System32', 'tar.exe')]
}

/**
 * 找一个真能写 zip 的 tar；找不到就给可执行的错，而不是把 tar 冒充成 zip。
 * @param {object} ctx - 插件上下文。
 * @param {object} exec - 工具执行上下文。
 * @returns {Promise<string>} 可执行文件路径。
 */
async function resolveZipTar(ctx, exec) {
  const candidates = zipTarCandidates()
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    try {
      // 与 tarTraitsOf 同理：探针的 cwd 必须是确定可用的目录，不能用 process.cwd()。
      const probe = await execCapture(ctx, exec, {
        argv: [candidate, '--version'],
        cwd: probeCwdFor(ctx, exec, candidate),
        timeoutMs: 20_000
      })
      if (probe.exitCode === 0 && /bsdtar|libarchive/iu.test(probe.output)) return candidate
    } catch {
      /* 试下一个 */
    }
  }
  throw new Error('当前 tar 是 GNU tar，不能写 zip（-a 对 .zip 不生效，会写出一个改名成 .zip 的 tar）。'
    + `请把 out 改成 .tar.gz / .tgz，或启用 bsdtar（Windows 10+ 自带 ${candidates[0]}）。`)
}

/**
 * 解析出可执行文件，失败时给出可操作的提示。
 * @param {object} ctx - 插件上下文。
 * @param {object} exec - 工具执行上下文。
 * @param {string} program - 程序名。
 * @param {string} hint - 失败提示。
 * @returns {Promise<string>} 可执行文件路径。
 */
async function resolveOrHint(ctx, exec, program, hint) {
  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined) throw new Error('需要 subprocess 服务，但当前组合没有挂载它')
  try {
    return await subprocess.resolveExecutable(program, undefined, exec.signal)
  } catch {
    throw new Error(`找不到 ${program}。${hint}`)
  }
}

/**
 * 定义 ocr_doc。
 * @param {object} ctx - 插件上下文。
 * @returns {object} 工具定义。
 */
function ocrDocDefinition(ctx) {
  return {
    name: 'ocr_doc',
    description: '用 docling 把 PDF / 图片 / Office 文档转成 Markdown 等文本并落盘；结果只回传产物清单，不回传正文。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        input: { type: 'string', description: '输入文件路径（PDF / 图片 / docx 等）。' },
        out_dir: { type: 'string', description: '输出目录；不存在时由 docling 创建。' },
        to: { type: 'string', enum: ['md', 'json', 'text', 'html'], description: '目标格式，默认由 docling 决定（通常是 md）。' },
        timeout_ms: { type: 'number', description: `超时毫秒数，默认 600000（docling 较慢），上限 ${MAX_TIMEOUT_MS}。` }
      },
      required: ['input', 'out_dir']
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          exit_code: { type: 'integer' },
          out_dir: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          truncated: { type: 'boolean' },
          output: { type: 'string' }
        },
        required: ['exit_code', 'out_dir', 'files', 'truncated', 'output']
      },
      render: (_args, value) => [{
        type: 'text',
        text: `<docling exit="${value.exit_code}" out="${value.out_dir}"/>\n${value.files.length === 0 ? '(未发现产物)' : value.files.join('\n')}${value.truncated ? '\n…其余产物见目录' : ''}\n${value.output === '' ? '' : `\n${value.output}`}`
      }]
    },
    async execute(args, exec) {
      const inputRaw = normalizePathInput(args?.input, 'input')
      const outDirRaw = normalizePathInput(args?.out_dir, 'out_dir')
      const to = typeof args?.to === 'string' && args.to !== '' ? args.to : undefined
      const cwd = cwdFor(ctx, exec)
      const docling = await resolveOrHint(ctx, exec, 'docling',
        'docling 是 Python 包，先调用 env_setup({pip_packages:["docling"]})（已配置镜像加速），装好后再重试。')
      const options = resolveOptions(exec, undefined, ctx)
      const inputTarget = await ctx.fs.resolve(inputRaw, options)
      const inputInfo = await ctx.fs.stat(inputTarget, exec.signal)
      if (inputInfo === undefined) throw new Error(`无法转换 "${inputTarget.displayPath}"：路径不存在`)
      const outTarget = await ctx.fs.resolve(outDirRaw, options)
      const timeoutMs = args?.timeout_ms === undefined ? 600_000 : Number(args.timeout_ms)
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
        throw new Error(`timeout_ms 必须在 1..${MAX_TIMEOUT_MS} 之间`)
      }
      const result = await execCapture(ctx, exec, {
        argv: [docling, ...doclingArgv({ input: inputTarget.displayPath, outDir: outTarget.displayPath, to })],
        cwd,
        timeoutMs
      })
      let files = []
      const outInfo = await ctx.fs.stat(outTarget, exec.signal)
      if (outInfo?.type === 'directory') {
        const children = await ctx.fs.listDir(outTarget, exec.signal)
        files = children.map((entry) => `${entry.type === 'directory' ? '[目录] ' : ''}${entry.name}${entry.size === undefined ? '' : ` ${formatBytes(entry.size)}`}`)
      }
      return {
        exit_code: result.exitCode,
        out_dir: outTarget.displayPath,
        files: files.slice(0, MAX_LISTED_FILES),
        truncated: files.length > MAX_LISTED_FILES,
        output: result.output
      }
    },
    presentCall(args) {
      return { card: 'terminal', title: `docling ${args.input}`, description: `→ ${args.out_dir}` }
    }
  }
}

/**
 * 定义 merge_files。
 * @param {object} ctx - 插件上下文。
 * @returns {object} 工具定义。
 */
function mergeFilesDefinition(ctx) {
  return {
    name: 'merge_files',
    description: '按 manifest.json 里的顺序把块文件合并成一个文件，并可按源文件风格还原换行。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        manifest: { type: 'string', description: 'split_file 产出的 *.manifest.json 路径。' },
        out: { type: 'string', description: '合并后的输出文件路径。' },
        eol: { type: 'string', enum: ['source', 'lf', 'crlf'], description: '换行风格：source 表示还原源文件风格（默认），或强制 lf / crlf。' },
        header: { type: 'string', description: '可选：写在最前面的标题行（会按目标换行风格写入）。' }
      },
      required: ['manifest', 'out']
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          out: { type: 'string' },
          files: { type: 'integer' },
          lines: { type: 'integer' },
          bytes: { type: 'integer' },
          eol: { type: 'string' }
        },
        required: ['out', 'files', 'lines', 'bytes', 'eol']
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已合并 ${value.files} 个块 → ${value.out}（${value.lines} 行，${formatBytes(value.bytes)}，${value.eol === 'crlf' ? 'CRLF' : 'LF'}）`
      }]
    },
    async execute(args, exec) {
      const manifestRaw = normalizePathInput(args?.manifest, 'manifest')
      const outRaw = normalizePathInput(args?.out, 'out')
      const policy = currentPolicy(ctx, exec)
      const options = resolveOptions(exec, policy?.workspaceRoot, ctx)
      const manifestTarget = await ctx.fs.resolve(manifestRaw, options)
      const manifestInfo = await ctx.fs.stat(manifestTarget, exec.signal)
      if (manifestInfo === undefined) throw new Error(`找不到 manifest："${manifestTarget.displayPath}"`)
      const manifestText = await ctx.fs.readText(manifestTarget, exec.signal)
      let manifest
      try {
        manifest = JSON.parse(manifestText)
      } catch (error) {
        throw new Error(`manifest 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
      }
      if (!Array.isArray(manifest?.chunks) || manifest.chunks.length === 0) {
        throw new Error('manifest 里没有 chunks，请先用 split_file 生成')
      }
      if (manifest.chunks.length > MAX_CHUNKS) throw new Error(`manifest 有 ${manifest.chunks.length} 个块，超过 ${MAX_CHUNKS} 上限`)
      const dir = manifestTarget.displayPath.replace(/[\\/][^\\/]*$/u, '')
      const parts = []
      for (const chunk of manifest.chunks) {
        const file = typeof chunk?.file === 'string' ? chunk.file : undefined
        if (file === undefined) throw new Error('manifest 的某个 chunk 缺少 file 字段')
        const chunkTarget = await ctx.fs.resolve(`${dir}/${file}`, options)
        const chunkInfo = await ctx.fs.stat(chunkTarget, exec.signal)
        if (chunkInfo === undefined) throw new Error(`块文件缺失：${file}`)
        const text = await ctx.fs.readText(chunkTarget, exec.signal)
        // split_file 写块时在逻辑行末尾**只补了 1 个 `\n`**（分隔符），而 marker 模式下
        // "下一个标题前的空行"是上一块的**最后一行**，所以块尾可能是 `…text\n\n`。
        // 这里只能剥掉那 1 个分隔符：剥掉全部尾部换行会把空行吃掉（实测 6 个标题 → 丢 6 个空行）。
        parts.push(text.replace(/\r\n|\r/g, '\n').replace(/\n$/u, ''))
      }
      const requested = args?.eol ?? 'source'
      const sourceEol = typeof manifest.source_eol === 'string' ? manifest.source_eol : 'lf'
      const eol = requested === 'source' ? (sourceEol === 'crlf' ? 'crlf' : 'lf') : requested
      const header = typeof args?.header === 'string' && args.header.trim() !== ''
        ? `${args.header.trim()}\n`
        : ''
      const finalText = normalizeEol(`${header}${parts.join('\n')}\n`, eol)
      const outTarget = await ctx.fs.resolve(outRaw, options)
      const intent = await ctx.waterfall('fs/write-intent', outTarget, exec, () => undefined)
      const outcome = await ctx.fs.writeText(outTarget, finalText, intent, exec.signal, policy)
      ctx.emit('fs/observed', outTarget, { kind: 'present', version: outcome.version }, exec)
      return {
        out: outTarget.displayPath,
        files: manifest.chunks.length,
        lines: splitLines(finalText).length,
        bytes: utf8Bytes(finalText),
        eol
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `合并 → ${args.out}`, kind: 'edit', locations: [{ path: args.out }] }
    }
  }
}

/**
 * 定义 pack。
 * @param {object} ctx - 插件上下文。
 * @returns {object} 工具定义。
 */
function packDefinition(ctx) {
  return {
    name: 'pack',
    description: '用 tar 把文件/目录打包成 zip 或 tar.gz（按输出扩展名自动选格式），并回报归档体积。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        out: { type: 'string', description: '归档输出路径，例如 out/book.zh.zip 或 out/book.tar.gz。' },
        items: { type: 'array', items: { type: 'string' }, description: '要打包的条目（相对 dir 的路径或名称）。' },
        dir: { type: 'string', description: '归档内条目的基准目录；省略则用当前会话工作目录。' },
        timeout_ms: { type: 'number', description: `超时毫秒数，默认 300000，上限 ${MAX_TIMEOUT_MS}。` }
      },
      required: ['out', 'items']
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          out: { type: 'string' },
          bytes: { type: 'integer' },
          items: { type: 'array', items: { type: 'string' } },
          exit_code: { type: 'integer' },
          output: { type: 'string' }
        },
        required: ['out', 'bytes', 'items', 'exit_code', 'output']
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.exit_code === 0
          ? `<pack exit="0" out="${value.out}" size="${formatBytes(value.bytes)}"/>\n${value.items.join('\n')}${value.output === '' ? '' : `\n${value.output}`}`
          // 失败时**不给 size**：一个 45 B 的空归档配上 size 属性读起来像成功。
          : `<pack exit="${value.exit_code}" out="${value.out}" failed="true"/>\n打包失败，目标没有生成（归档器退出码 ${value.exit_code}）：${value.items.join(', ')}\n${value.output}`
      }]
    },
    async execute(args, exec) {
      if (!Array.isArray(args?.items) || args.items.length === 0) throw new Error('items 必须是非空字符串数组')
      const items = args.items.map((item, index) => {
        if (typeof item !== 'string' || item.trim() === '') throw new Error(`items[${index}] 必须是非空字符串`)
        return item.trim()
      })
      const outRaw = normalizePathInput(args?.out, 'out')
      const cwd = cwdFor(ctx, exec)
      const tar = await resolveOrHint(ctx, exec, 'tar', 'Windows 10+ 自带 bsdtar；确认 PATH 里有 tar。')
      const policy = currentPolicy(ctx, exec)
      const options = resolveOptions(exec, policy?.workspaceRoot, ctx)
      const outTarget = await ctx.fs.resolve(outRaw, options)
      const dirRaw = args?.dir === undefined ? undefined : normalizePathInput(args.dir, 'dir')
      const dirTarget = await ctx.fs.resolve(dirRaw ?? '.', options)
      const timeoutMs = args?.timeout_ms === undefined ? 300_000 : Number(args.timeout_ms)
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
        throw new Error(`timeout_ms 必须在 1..${MAX_TIMEOUT_MS} 之间`)
      }
      // GNU tar 需要 --force-local 才会把 `-f C:\...` 当本地文件；zip 只有 bsdtar 写得出来。
      const traits = await tarTraitsOf(ctx, exec, tar)
      const wantsZip = /\.zip$/iu.test(outTarget.displayPath)
      let tarCommand = tar
      let tarForceLocal = traits.forceLocal
      if (wantsZip && !traits.zip) {
        tarCommand = await resolveZipTar(ctx, exec)
        tarForceLocal = false
        ctx.logger?.info(`agentkit: pack 要 zip 而 ${tar} 是 GNU tar（不能写 zip）→ 改用 ${tarCommand}`)
      }
      const tarArgv = [
        tarCommand,
        ...(tarForceLocal ? ['--force-local'] : []),
        ...tarPackArgv({ output: outTarget.displayPath, dir: dirTarget.displayPath, items })
      ]
      ctx.logger?.info(`agentkit: pack argv = ${JSON.stringify(tarArgv)}`
        + `（cwd=${cwd}, forceLocal=${tarForceLocal}, gnu=${traits.gnu}, probed=${traits.probed}, probeCwd=${traits.cwd}）`)
      // 运行前先看目标是否存在：失败时只允许删除**本次调用新建**的文件。
      const existedBefore = (await ctx.fs.stat(outTarget, exec.signal)) !== undefined
      const result = await execCapture(ctx, exec, {
        argv: tarArgv,
        cwd,
        timeoutMs
      })
      let cleanup = ''
      if (result.exitCode !== 0) {
        // 失败时不能留下"可打开、零条目"的空归档：那会让调用方以为打包成功了。
        const broken = await ctx.fs.stat(outTarget, exec.signal)
        if (broken !== undefined && !existedBefore) {
          try {
            unlinkSync(outTarget.displayPath)
            cleanup = '；本次新建的残缺产物已删除'
          } catch (error) {
            cleanup = `；删除本次新建的残缺产物失败：${error instanceof Error ? error.message : String(error)}`
          }
        } else if (broken !== undefined) {
          cleanup = '；目标文件在运行前已存在，未删除（其内容可能已被归档器截断）'
        }
      }
      const info = await ctx.fs.stat(outTarget, exec.signal)
      return {
        out: outTarget.displayPath,
        bytes: info?.size ?? 0,
        items,
        exit_code: result.exitCode,
        output: `[tar] ${tarCommand}${tarForceLocal ? ' --force-local' : ''}`
          + `\n[pack] ${result.exitCode === 0 ? '归档完成' : `归档器退出码 ${result.exitCode}，本次没有产出可用归档${cleanup}`}`
          + `\n${result.output}`
      }
    },
    presentCall(args) {
      return { card: 'terminal', title: `打包 → ${args.out}`, description: 'bsdtar' }
    }
  }
}

/**
 * 挂载 ocr_doc、merge_files 与 pack。
 * @param {object} ctx - preset 作用域的插件上下文。
 */
export function apply(ctx) {
  const register = createToolRegistrar(ctx)
  register(ocrDocDefinition(ctx))
  register(mergeFilesDefinition(ctx))
  register(packDefinition(ctx))
}
