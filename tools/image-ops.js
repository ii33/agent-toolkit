/**
 * 图片工具：`image_info` / `crop_image` / `resize_image`。
 *
 * 与 `read_image` 的分工：
 *   - `read_image` 把**整张图**交给模型；
 *   - `crop_image` 只把**一块区域**交出去 —— 小目标（字、铭牌、表格单元格）裁出来才看得清；
 *   - `resize_image` 改变尺寸后交出去或落盘；
 *   - `image_info` 先看尺寸，决定要不要裁。
 *
 * 实现细节（不写进工具描述，使用者不需要知道）：图像处理交给 `image_ops.py`，
 * 缺 Pillow 时它按镜像自行安装；本地读写走 `ctx.fs`（受会话沙箱约束），远程走 SFTP 侧车。
 *
 * @module @local/dsh-agentkit/image-ops
 */
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, execCapture, pythonPathArg, pythonPathStyle } from '../lib/exec.js'
import { cwdFor, normalizePathInput, resolveOptions } from '../lib/fs-common.js'
import { resolvePython } from '../lib/python.js'
import { MAX_REMOTE_BYTES, remoteReadBytes, remoteStat, remoteWriteBytes, resolveRemote } from '../lib/remote.js'
import { createToolRegistrar } from './registry.js'

/** 只需要工具注册表。 */
export const inject = ['tools']

/** 侧车脚本。 */
const SIDECAR = fileURLToPath(new URL('./image_ops.py', import.meta.url))

/** 单张图片读取上限（与 read_image 一致）。 */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024

/** 侧车输出格式 → media type。 */
const MEDIA_TYPES = {
  PNG: 'image/png',
  JPEG: 'image/jpeg',
  JPG: 'image/jpeg',
  WEBP: 'image/webp',
  GIF: 'image/gif'
}

/**
 * 读入图片字节：远程走 SFTP 侧车，本地走 fs 服务（受会话沙箱约束）。
 * @param {object} ctx - 插件上下文。
 * @param {object} exec - 工具执行上下文。
 * @param {string} input - 路径（支持 `代号:/远程/路径`）。
 * @returns {Promise<{bytes: Uint8Array, displayPath: string, remote: boolean, name: string, target?: object}>} 读入结果。
 */
async function readImage(ctx, exec, input) {
  const name = input.split(/[\\/]/u).pop() ?? 'image'
  const remote = await resolveRemote(ctx, exec, input)
  if (remote !== undefined) {
    const info = await remoteStat(ctx, exec, remote)
    if (info === undefined) throw new Error(`无法读取 "${remote.displayPath}"：路径不存在`)
    if (info.type !== 'file') throw new Error(`无法读取 "${remote.displayPath}"：不是常规文件`)
    if (info.size !== undefined && info.size > MAX_REMOTE_BYTES) {
      throw new Error(`无法读取 "${remote.displayPath}"：超过远程单次读上限`)
    }
    const bytes = await remoteReadBytes(ctx, exec, remote, MAX_REMOTE_BYTES)
    return { bytes, displayPath: remote.displayPath ?? input, remote: true, name }
  }
  const target = await ctx.fs.resolve(input, resolveOptions(exec, undefined, ctx))
  const info = await ctx.fs.stat(target, exec.signal)
  if (info === undefined || info.type !== 'file') throw new Error(`"${input}" 不是常规文件`)
  const bytes = await ctx.fs.readBytes(target, exec.signal, MAX_IMAGE_BYTES)
  return { bytes, displayPath: input, remote: false, name, target }
}

/**
 * 侧车进程的工作目录：优先用调用方给的，其次会话 cwd，最后进程 cwd
 * （自动化 / 宿主侧调用可能没有会话上下文，不该因此失败）。
 * @param {object} ctx - 插件上下文。
 * @param {object} exec - 工具执行上下文。
 * @returns {string} 工作目录。
 */
function cwdForSidecar(ctx, exec) {
  if (typeof exec?.cwd === 'string' && exec.cwd !== '') return exec.cwd
  try {
    return cwdFor(ctx, exec)
  } catch {
    // **不用 process.cwd()**：宿主的进程 cwd 可能不是一个可用目录，execCapture 会在那里抛错。
    return dirname(process.execPath)
  }
}

/** 侧车操作 → 中文动词，用于统一的失败话术。 */
const OP_LABELS = { info: '读取图片信息', crop: '裁剪图片', resize: '缩放图片' }

/**
 * 把侧车的原始错误包成中文、可操作的话术（三个图片工具共用，避免某个工具漏出 Python 异常名）。
 * @param {object} request - 发给侧车的请求（含 op / name）。
 * @param {object} value - 侧车响应（ok=false 时的 error / code）。
 * @returns {string} 面向模型的错误文本。
 */
function imageFailureMessage(request, value) {
  const label = OP_LABELS[request?.op] ?? '处理图片'
  const name = typeof request?.name === 'string' && request.name !== '' ? `"${request.name}"` : '输入'
  const detail = String(value?.error ?? '侧车没有给出错误详情')
  if (value?.code === 'MISSING_DEP' || /No module named|MISSING_DEP/iu.test(detail)) {
    return `${label}失败：${name} 需要 Pillow，但当前解释器里没有（${detail}）。可调用 env_setup({pip_packages:["pillow"]}) 安装。`
  }
  if (/UnidentifiedImageError|cannot identify image file|not a valid|unsupported image|Invalid image/iu.test(detail)) {
    return `${label}失败：${name} 不是可识别的图片（支持 PNG / JPEG / WebP / GIF）。原始错误：${detail}`
  }
  return `${label}失败：${name}。原始错误：${detail}`
}

/**
 * 调侧车：一次请求一次响应（请求走 stdin，避免超长 argv）。
 * @param {object} ctx - 插件上下文。
 * @param {object} exec - 工具执行上下文。
 * @param {object} request - 请求对象。
 * @param {number} timeoutMs - 超时毫秒数。
 * @returns {Promise<object>} 侧车响应。
 */
async function runSidecar(ctx, exec, request, timeoutMs) {
  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined) throw new Error('图片工具需要 subprocess 服务，但当前组合没有挂载它')
  // 解释器统一由 lib/python.js 解析（候选顺序见该模块）：PATH 上的 python 常是没有 pip/Pillow 的 MSYS2 python，
  // 所以这里必须用探针确认真能 `import PIL`。
  const python = await resolvePython(ctx, exec, 'import PIL')
  ctx.logger?.info(`agentkit: 图片侧车用 ${python}`)
  // MSYS2/Cygwin 的 python 用 posixpath：argv 里的 `D:\...\image_ops.py` 没有 `/`，
  // 会被当成相对路径拼到 cwd 上（实测报 `can't open file '/c/.../D:\...\image_ops.py'`）。
  // 先探测解释器属于哪种世界，再把脚本路径改写成它能打开的形式（与 lib/encode_write.py、
  // lib/remote.js 的 SFTP 侧车同一套处理）；原生 Windows python 保持原样。
  const style = await pythonPathStyle(ctx, exec, python)
  const result = await execCapture(ctx, exec, {
    argv: [python, pythonPathArg(SIDECAR, style), '--auto-install'],
    cwd: cwdForSidecar(ctx, exec),
    timeoutMs,
    stdin: JSON.stringify(request)
  })
  const line = result.output
    .split('\n')
    .map((item) => item.trim())
    .filter((item) => item.startsWith('{'))
    .pop()
  if (line === undefined) throw new Error(`图片处理没有返回结果：${result.output.slice(0, 300)}`)
  const value = JSON.parse(line)
  if (value.ok !== true) throw new Error(imageFailureMessage(request, value))
  return value
}

/**
 * 目标是否可写（只读策略下不允许写盘）。
 * @param {object} ctx - 插件上下文。
 * @param {object} exec - 工具执行上下文。
 * @param {string} out - 目标路径。
 */
function assertWritable(ctx, exec, out) {
  const policy = ctx.get('sandboxPolicy')?.resolve({ session: exec.agent?.session })
  if (policy !== undefined && policy.mode === 'read-only') {
    throw new Error(`当前是只读策略，不能写入 "${out}"`)
  }
}

/**
 * 结果输出：本地 out 已由侧车直接写盘；这里处理"交给模型看"与"远程落盘"。
 * @param {object} ctx - 插件上下文。
 * @param {object} exec - 工具执行上下文。
 * @param {object} source - 来源信息。
 * @param {object} result - 侧车响应。
 * @returns {Promise<object>} 工具结果。
 */
async function deliver(ctx, exec, source, result) {
  const mediaType = MEDIA_TYPES[String(result.format ?? 'PNG').toUpperCase()] ?? 'image/png'
  const out = result.out
  if (out !== undefined && out !== '') {
    return {
      path: source.displayPath,
      media_type: mediaType,
      bytes: Number(result.bytes ?? 0),
      width: Number(result.width),
      height: Number(result.height),
      out: String(out),
      name: source.name
    }
  }
  const bytes = Buffer.from(String(result.data_b64 ?? ''), 'base64')
  const attachments = ctx.get('attachments')
  if (attachments === undefined) throw new Error('把图片交给模型需要 attachments 服务')
  const ref = await attachments.saveImage({
    data: new Uint8Array(bytes),
    mediaType,
    name: source.name
  })
  return {
    path: source.displayPath,
    media_type: mediaType,
    bytes: bytes.length,
    width: Number(result.width),
    height: Number(result.height),
    attachment_id: ref.attachmentId,
    name: source.name
  }
}

/**
 * 处理 out 参数：远程 out 侧车写不到，需要取回字节用 SFTP 写。
 * @param {object} ctx - 插件上下文。
 * @param {object} exec - 工具执行上下文。
 * @param {object} args - 工具参数。
 * @param {object} request - 侧车请求（本地 out 会写进这里）。
 * @returns {Promise<{remote: object|undefined, out: string|undefined}>} 远程目标与本地目标。
 */
async function prepareOut(ctx, exec, args, request) {
  const raw = args?.out
  if (raw === undefined || raw === '') return { remote: undefined, out: undefined }
  const out = normalizePathInput(String(raw), 'out')
  assertWritable(ctx, exec, out)
  const remote = await resolveRemote(ctx, exec, out)
  if (remote === undefined) request.out = out
  return { remote, out }
}

/** 输出 schema（两种形态共用：落盘给 out，交给模型给 attachment_id）。 */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string' },
    media_type: { type: 'string' },
    bytes: { type: 'integer' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    attachment_id: { type: 'string' },
    out: { type: 'string' },
    name: { type: 'string' }
  },
  required: ['path', 'media_type', 'bytes', 'width', 'height']
}

/**
 * 统一渲染：交给模型时同时给一行说明和一个图片块。
 * @param {string} label - 标签（image-crop / image-resize）。
 * @param {object} value - 工具结果。
 * @returns {object[]} 内容 part。
 */
function renderResult(label, value) {
  const head = {
    type: 'text',
    text: `<${label} path="${value.path}" type="${value.media_type}" size="${value.width}x${value.height}" bytes="${value.bytes}"`
      + `${value.out === undefined ? '' : ` out="${value.out}"`}/>`
  }
  if (value.attachment_id === undefined) return [head]
  return [head, {
    type: 'image',
    attachment: {
      attachmentId: value.attachment_id,
      mediaType: value.media_type,
      bytes: value.bytes,
      width: value.width,
      height: value.height,
      ...(value.name === undefined ? {} : { name: value.name })
    }
  }]
}

/**
 * 挂载图片工具。
 * @param {object} ctx - 插件上下文。
 */
export function apply(ctx) {
  const register = createToolRegistrar(ctx)
  register({
    name: 'image_info',
    description: '查看图片的尺寸、格式与字节数，用来决定要不要先裁切。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        file_path: { type: 'string', description: '图片路径；远程写 `代号:/远程/路径`。' }
      },
      required: ['file_path']
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          format: { type: 'string' },
          bytes: { type: 'integer' },
          has_alpha: { type: 'boolean' },
          orientation: { type: 'integer' }
        },
        required: ['path', 'width', 'height', 'format', 'bytes']
      },
      render: (_args, value) => [{
        type: 'text',
        text: `<image-info path="${value.path}" size="${value.width}x${value.height}" format="${value.format}" bytes="${value.bytes}"/>`
      }]
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input = normalizePathInput(args?.file_path, 'file_path')
      const source = await readImage(ctx, exec, input)
      const info = await runSidecar(ctx, exec, {
        op: 'info',
        data_b64: Buffer.from(source.bytes).toString('base64'),
        name: source.name
      }, DEFAULT_TIMEOUT_MS)
      return {
        path: source.displayPath,
        width: Number(info.width),
        height: Number(info.height),
        format: String(info.format ?? 'unknown'),
        bytes: Number(info.bytes ?? source.bytes.length),
        has_alpha: info.has_alpha === true,
        orientation: Number(info.orientation ?? 1)
      }
    }
  })

  register({
    name: 'crop_image',
    description: '裁出图片的一块区域：默认直接交给模型看（小目标裁出来才看得清），给了 out 就写文件。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        file_path: { type: 'string', description: '图片路径；远程写 `代号:/远程/路径`。' },
        box: { type: 'array', items: { type: 'integer' }, description: '像素框 [左, 上, 右, 下]；与 ratio **二选一**（两个都给会报错）。' },
        ratio: { type: 'array', items: { type: 'number' }, description: '比例框 [x, y, 宽, 高]，取值 0–1；与 box **二选一**（两个都给会报错）。' },
        out: { type: 'string', description: '写到这个路径；省略则直接交给模型看。' },
        timeout_ms: { type: 'number', description: `超时毫秒数，默认 ${DEFAULT_TIMEOUT_MS}，上限 ${MAX_TIMEOUT_MS}。` }
      },
      required: ['file_path']
    },
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => renderResult('image-crop', value) },
    async execute(args, exec) {
      const input = normalizePathInput(args?.file_path, 'file_path')
      const timeoutMs = args?.timeout_ms === undefined ? DEFAULT_TIMEOUT_MS : Number(args.timeout_ms)
      const source = await readImage(ctx, exec, input)
      const data = Buffer.from(source.bytes).toString('base64')
      const request = { op: 'crop', data_b64: data, name: source.name }
      const box = args?.box
      const ratio = args?.ratio
      // 两个都给时**报错**而不是静默优先 box：静默忽略参数是最难查的一类"没生效"。
      if (box !== undefined && ratio !== undefined) {
        throw new Error('box 与 ratio 只能给一个：box=[左,上,右,下]（像素），ratio=[x,y,宽,高]（0–1 比例）；两个都给会有一个被静默忽略')
      }
      if (box !== undefined) {
        if (!Array.isArray(box) || box.length !== 4) throw new Error('box 必须是 [左,上,右,下] 四个像素值')
        request.box = box.map((value) => Number(value))
      } else if (ratio !== undefined) {
        if (!Array.isArray(ratio) || ratio.length !== 4) throw new Error('ratio 必须是 [x,y,宽,高] 四个 0–1 的比例值')
        const info = await runSidecar(ctx, exec, { op: 'info', data_b64: data, name: source.name }, timeoutMs)
        const [x, y, w, h] = ratio.map((value) => Number(value))
        request.box = [
          Math.round(x * info.width),
          Math.round(y * info.height),
          Math.round((x + w) * info.width),
          Math.round((y + h) * info.height)
        ]
      } else {
        throw new Error('crop_image 需要 box（像素）或 ratio（0–1 比例）之一')
      }
      const { remote } = await prepareOut(ctx, exec, args, request)
      const result = await runSidecar(ctx, exec, request, timeoutMs)
      if (remote !== undefined) {
        const bytes = Buffer.from(String(result.data_b64 ?? ''), 'base64')
        await remoteWriteBytes(ctx, exec, remote, bytes)
        result.out = remote.displayPath ?? String(args.out)
        result.bytes = bytes.length
      }
      return deliver(ctx, exec, source, result)
    }
  })

  register({
    name: 'resize_image',
    description: '等比缩放图片：默认直接交给模型看，给了 out 就写文件。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        file_path: { type: 'string', description: '图片路径；远程写 `代号:/远程/路径`。' },
        max_side: { type: 'integer', description: '最长边的目标像素数；与 width/height 三选一。' },
        width: { type: 'integer', description: '目标宽度；省略则按等比推算。' },
        height: { type: 'integer', description: '目标高度；省略则按等比推算。' },
        out: { type: 'string', description: '写到这个路径；省略则直接交给模型看。' },
        timeout_ms: { type: 'number', description: `超时毫秒数，默认 ${DEFAULT_TIMEOUT_MS}，上限 ${MAX_TIMEOUT_MS}。` }
      },
      required: ['file_path']
    },
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => renderResult('image-resize', value) },
    async execute(args, exec) {
      const input = normalizePathInput(args?.file_path, 'file_path')
      const timeoutMs = args?.timeout_ms === undefined ? DEFAULT_TIMEOUT_MS : Number(args.timeout_ms)
      const source = await readImage(ctx, exec, input)
      const request = {
        op: 'resize',
        data_b64: Buffer.from(source.bytes).toString('base64'),
        name: source.name,
        ...(args?.max_side === undefined ? {} : { max_side: Number(args.max_side) }),
        ...(args?.width === undefined ? {} : { width: Number(args.width) }),
        ...(args?.height === undefined ? {} : { height: Number(args.height) })
      }
      const { remote } = await prepareOut(ctx, exec, args, request)
      const result = await runSidecar(ctx, exec, request, timeoutMs)
      if (remote !== undefined) {
        const bytes = Buffer.from(String(result.data_b64 ?? ''), 'base64')
        await remoteWriteBytes(ctx, exec, remote, bytes)
        result.out = remote.displayPath ?? String(args.out)
        result.bytes = bytes.length
      }
      return deliver(ctx, exec, source, result)
    }
  })
}

/** 侧车路径（测试用）。 */
export const SIDECAR_PATH = SIDECAR

/** 工具名（测试用）。 */
export const TOOL_NAMES = ['image_info', 'crop_image', 'resize_image']
