/**
 * read_image：把一张图片交给模型"看"。
 *
 * 图片走附件服务提交（`attachments.saveImage`），返回的图片块随消息携带，
 * 因此模型能直接看图——这是"OCR 与多模态互校"里多模态那一半的基础能力。
 *
 * 三道闸门（缺一不可，否则提供方会报难懂的错）：
 *   1. 组合必须挂载 attachments（否则无法把图片变成可携带的附件）；
 *   2. 部署必须接受该 media type，且不超过字节上限；
 *   3. 当前模型路由必须**显式声明图片输入**（本地小模型没声明就明确拒绝，
 *      而不是把图片塞进请求让提供方失败）。
 *
 * 支持 `代号:/远程/路径`（经 SFTP 取字节后再提交为附件）。
 *
 * @module @local/dsh-doc-pipeline/image
 */
import { formatBytes, normalizePathInput, resolveOptions } from '../lib/fs-common.js'
import { MAX_REMOTE_BYTES, remoteReadBytes, remoteStat, resolveRemote } from '../lib/remote.js'
import { createToolRegistrar } from './registry.js'

/** 需要工具注册表与文件系统。 */
export const inject = ['tools', 'fs']

/** 按扩展名声明的 media type。 */
const IMAGE_EXTENSIONS = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}

/** 单张图片读取上限。 */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024

/**
 * 取扩展名（小写，含点）。
 * @param {string} path - 路径。
 * @returns {string} 扩展名或空串。
 */
function extensionOf(path) {
  const dot = path.lastIndexOf('.')
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return dot > slash ? path.slice(dot).toLowerCase() : ''
}

/**
 * 取文件名。
 * @param {string} path - 路径。
 * @returns {string} 文件名。
 */
function baseNameOf(path) {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return slash === -1 ? path : path.slice(slash + 1)
}

/**
 * 按文件签名识别图片类型（扩展名缺失或撒谎时的兜底）。
 * @param {Uint8Array} bytes - 文件字节。
 * @returns {string|undefined} media type。
 */
function sniffImageMediaType(bytes) {
  const startsWith = (offset, expected) => expected.every((byte, index) => bytes[offset + index] === byte)
  if (startsWith(0, [0x89, 0x50, 0x4e, 0x47])) return 'image/png'
  if (startsWith(0, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(0, [0x47, 0x49, 0x46, 0x38])) return 'image/gif'
  if (startsWith(0, [0x52, 0x49, 0x46, 0x46]) && startsWith(8, [0x57, 0x45, 0x42, 0x50])) return 'image/webp'
  return undefined
}

/**
 * 确认当前模型路由声明了图片输入。
 * @param {object} ctx - 插件上下文。
 * @param {object} exec - 工具执行上下文。
 * @param {string} displayPath - 展示路径。
 */
async function assertImageCapableRoute(ctx, exec, displayPath) {
  const routed = exec.agent?.session.requestHeader()?.config
  const provider = routed?.provider ?? exec.agent?.options.provider
  const model = routed?.model ?? exec.agent?.options.model
  const llm = ctx.get('llm')
  if (provider === undefined || model === undefined || llm === undefined) {
    throw new Error(`无法把 "${displayPath}" 作为图片读取：当前模型路由无法解析`)
  }
  const active = await llm.resolveModelInfo(provider, model, exec.signal)
  if (active.inputModalities === undefined || !active.inputModalities.includes('image')) {
    throw new Error(`无法把 "${displayPath}" 作为图片读取：模型 "${model}" 未声明支持图片输入，请切换到支持图片的模型`)
  }
}

/**
 * 定义 read_image。
 * @param {object} ctx - 插件上下文。
 * @returns {object} 工具定义。
 */
function readImageDefinition(ctx) {
  return {
    name: 'read_image',
    description: '把一张图片（本地或 `代号:/远程/路径`）交给模型直接查看，返回图片本身与尺寸信息。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        file_path: { type: 'string', description: '图片路径（PNG / JPEG / WebP / GIF）；`nas:/scan/page-1.png` 表示远程主机。也接受 path。' }
      },
      required: ['file_path']
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          media_type: { type: 'string' },
          bytes: { type: 'integer' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          attachment_id: { type: 'string' },
          name: { type: 'string' },
          remote: { type: 'boolean' }
        },
        required: ['path', 'media_type', 'bytes', 'width', 'height', 'attachment_id']
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `<image path="${value.path}" type="${value.media_type}" size="${value.width}x${value.height}" bytes="${value.bytes}"/>`
        },
        {
          type: 'image',
          attachment: {
            attachmentId: value.attachment_id,
            mediaType: value.media_type,
            bytes: value.bytes,
            width: value.width,
            height: value.height,
            ...(value.name === undefined ? {} : { name: value.name })
          }
        }
      ]
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const requested = normalizePathInput(args?.file_path ?? args?.path, 'file_path')
      const attachments = ctx.get('attachments')
      if (attachments === undefined) {
        throw new Error('当前组合没有挂载附件服务，无法把图片交给模型')
      }

      let bytes
      let displayPath
      let remote = false
      const resolved = await resolveRemote(ctx, exec, requested)
      if (resolved !== undefined) {
        const info = await remoteStat(ctx, exec, resolved)
        if (info === undefined) throw new Error(`无法读取 "${resolved.displayPath}"：路径不存在`)
        if (info.type !== 'file') throw new Error(`无法读取 "${resolved.displayPath}"：不是常规文件`)
        if (info.size !== undefined && info.size > MAX_REMOTE_BYTES) {
          throw new Error(`无法读取 "${resolved.displayPath}"：${formatBytes(info.size)} 超过远程单次读上限`)
        }
        bytes = await remoteReadBytes(ctx, exec, resolved, MAX_REMOTE_BYTES)
        displayPath = resolved.displayPath
        remote = true
      } else {
        const target = await ctx.fs.resolve(requested, resolveOptions(exec, undefined, ctx))
        const info = await ctx.fs.stat(target, exec.signal)
        if (info === undefined) throw new Error(`无法读取 "${target.displayPath}"：路径不存在`)
        if (info.type !== 'file') throw new Error(`无法读取 "${target.displayPath}"：不是常规文件`)
        const cap = Math.min(MAX_IMAGE_BYTES, attachments.imageLimits.maxImageBytes)
        bytes = await ctx.fs.readBytes(target, exec.signal, cap)
        displayPath = target.displayPath
      }

      const declared = IMAGE_EXTENSIONS[extensionOf(requested)] ?? IMAGE_EXTENSIONS[extensionOf(displayPath)]
      const mediaType = declared ?? sniffImageMediaType(bytes)
      if (mediaType === undefined) {
        throw new Error(`无法读取 "${displayPath}"：不是受支持的图片格式（PNG / JPEG / WebP / GIF）`)
      }
      if (!attachments.imageLimits.mediaTypes.includes(mediaType)) {
        throw new Error(`无法读取 "${displayPath}"：当前部署不接受 ${mediaType} 图片`)
      }
      await assertImageCapableRoute(ctx, exec, displayPath)
      const ref = await attachments.saveImage({ data: bytes, mediaType, name: baseNameOf(displayPath) })
      return {
        path: displayPath,
        media_type: ref.mediaType,
        bytes: ref.bytes,
        width: ref.width,
        height: ref.height,
        attachment_id: ref.attachmentId,
        ...(ref.name === undefined ? {} : { name: ref.name }),
        ...(remote ? { remote: true } : {})
      }
    },
    presentCall(args) {
      const filePath = args.file_path ?? args.path
      return { card: 'generic', title: `查看图片 ${filePath}`, kind: 'read', locations: [{ path: filePath }] }
    }
  }
}

/**
 * 挂载 read_image。
 * @param {object} ctx - preset 作用域的插件上下文。
 */
export function apply(ctx) {
  const register = createToolRegistrar(ctx)
  const dispose = register(readImageDefinition(ctx))
  // 让出时（出货 read_image 已占用该名字）没有可注册的东西，不需要清理。
  void dispose
}
