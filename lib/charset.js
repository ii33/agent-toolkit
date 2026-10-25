/**
 * 字符集写出：把 UTF-8 文本按目标字符集编码后原子写回文件。
 *
 * 为什么需要外部程序：harness 的 `ctx.fs.writeText` 只接受字符串，落盘即 UTF-8，
 * 服务层没有"写原始字节"的接口。Windows 上大量既有文件是 GBK / UTF-16，
 * 写回时必须按原字符集编码，否则就是整文件乱码。
 *
 * 因此这里用 Python 侧的小助手（lib/encode_write.py）：内容走 stdin（UTF-8），
 * 由它按 codec 编码、同目录临时文件 + os.replace 原子替换。路径用
 * `ctx.fs.processPath(target)` 取进程世界的规范路径，避免路径风格不一致。
 *
 * @module @local/dsh-doc-pipeline/charset
 */
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execCapture, pythonPathArg, pythonPathStyle, usableCwd } from './exec.js'
import { resolvePython } from './python.js'

/** Python 侧助手脚本的绝对路径。 */
const HELPER = fileURLToPath(new URL('./encode_write.py', import.meta.url))

/** 可写回的字符集（探测结果名 → Python codec 名）。 */
export const WRITABLE = new Map([
  ['utf-8', 'utf-8'],
  ['utf-16le', 'utf-16le'],
  ['utf-16be', 'utf-16be'],
  ['gbk', 'gbk'],
  ['gb18030', 'gb18030'],
  ['big5', 'big5'],
  ['latin1', 'latin1']
])

/**
 * 该探测结果能否按原字符集写回。
 * @param {string} encoding - decodeText 报告的编码名。
 * @returns {boolean} 是否支持写回。
 */
export function canEncode(encoding) {
  return WRITABLE.has(encoding)
}

/**
 * 把 UTF-8 文本编码成目标字符集的字节（不落盘）。
 * 远程（SFTP）写回需要字节，本地写回走 {@link encodeWriteFile}。
 * @param {object} ctx - 插件上下文（需要 subprocess 服务）。
 * @param {object} exec - 工具执行上下文（提供 signal）。
 * @param {string} text - UTF-8 文本。
 * @param {string} encoding - 目标字符集。
 * @param {boolean} bom - 是否写 BOM。
 * @returns {Promise<Uint8Array>} 编码后的字节。
 */
export async function encodeText(ctx, exec, text, encoding, bom) {
  // 任何能跑的 Python 都行（只用标准库 codecs）：不探针，直接取优先级最高的解释器
  // —— 优先 DSH 自带的那份，而不是 PATH 上可能没有 codec 依赖的 MSYS python。
  const python = await resolvePython(ctx, exec, '')
  // MSYS2 python 不认 `D:\…` 形式的 argv 路径（会被当成相对路径），要先探测再转写。
  const style = await pythonPathStyle(ctx, exec, python)
  const result = await execCapture(ctx, exec, {
    argv: [python, pythonPathArg(HELPER, style), '--encode-only', encoding, bom ? '1' : '0'],
    // cwd 必须**保证存在**：process.cwd() 指向已删除目录时不会抛错，只会让 spawn ENOENT。
    // 助手脚本自己的目录（lib/）必然存在；`--encode-only` 不碰任何文件路径，与 cwd 无关。
    cwd: usableCwd(dirname(HELPER)),
    timeoutMs: 60_000,
    stdin: text
  })
  if (result.exitCode !== 0) {
    throw new Error(`无法按 ${encoding} 编码内容（退出码 ${result.exitCode}）：${result.output || '(无输出)'}`)
  }
  return new Uint8Array(Buffer.from(result.stdout.trim(), 'base64'))
}

/**
 * 按指定字符集原子写入本地文件。
 * @param {object} ctx - 插件上下文（需要 subprocess 服务）。
 * @param {object} exec - 工具执行上下文（提供 signal）。
 * @param {object} target - 已解析的 FsTarget。
 * @param {string} text - UTF-8 文本内容。
 * @param {string} encoding - 目标字符集（探测结果名）。
 * @param {boolean} bom - 是否写 BOM。
 * @returns {Promise<{bytes: number}>} 写出的字节数。
 */
export async function encodeWriteFile(ctx, exec, target, text, encoding, bom) {
  const python = await resolvePython(ctx, exec, '')
  const processPath = ctx.fs.processPath(target)
  const style = await pythonPathStyle(ctx, exec, python)
  const result = await execCapture(ctx, exec, {
    argv: [python, pythonPathArg(HELPER, style), pythonPathArg(processPath, style), encoding, bom ? '1' : '0'],
    // 同一类：目标目录可能**还不存在**（助手自己会 os.makedirs），拿它当 cwd 会让 spawn 直接 ENOENT。
    // 助手用的是绝对目标路径（os.path.abspath），与 cwd 无关；所以这里用助手自己的目录，
    // 既保证存在，也不改变落盘位置。
    cwd: usableCwd(dirname(HELPER)),
    timeoutMs: 120_000,
    stdin: text
  })
  if (result.exitCode !== 0) {
    throw new Error(`按 ${encoding} 写回 "${target.displayPath}" 失败（退出码 ${result.exitCode}）：${result.output || '(无输出)'}`)
  }
  const match = /ok (\d+)/u.exec(result.output)
  return { bytes: match === null ? 0 : Number(match[1]) }
}
