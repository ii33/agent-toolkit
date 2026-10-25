/**
 * Windows 文本编码 / 换行的探测与规范化（纯函数，无依赖）。
 *
 * 目的：把「GBK 乱码」「UTF-16 读成乱码」「CRLF/LF 不匹配导致 old_string 找不到」
 * 这类 Windows 高频故障，收敛到工具层一次性处理，模型不需要知道细节。
 *
 * @module @local/dsh-doc-pipeline/encoding
 */

/** UTF-8 BOM 字符，写回带 BOM 的文件时使用。 */
export const BOM_CHAR = '\uFEFF'

/** 支持的换行风格。 */
export const EOL_STYLES = ['crlf', 'lf', 'cr']

/**
 * 识别字节流开头的 BOM。
 * @param {Uint8Array} bytes - 文件原始字节。
 * @returns {{encoding: string, length: number}|undefined} BOM 的编码与长度。
 */
export function detectBom(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { encoding: 'utf-8', length: 3 }
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { encoding: 'utf-16le', length: 2 }
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { encoding: 'utf-16be', length: 2 }
  }
  return undefined
}

/**
 * 判断字节流是否像二进制（用于拒绝把 docx/png 当文本读）。
 * 必须在 BOM 判定之后调用：UTF-16 文本本身含 NUL 字节。
 * @param {Uint8Array} bytes - 文件原始字节。
 * @returns {boolean} 前 8KB 内出现 NUL 即视为二进制。
 */
export function looksBinary(bytes) {
  const window = bytes.subarray(0, 8192)
  for (const byte of window) if (byte === 0) return true
  return false
}

/**
 * 把字节流解码为文本，附带编码判定结果。
 * 顺序：BOM → 严格 UTF-8 → GBK → Big5 → 宽松 UTF-8（lossy）。
 * @param {Uint8Array} bytes - 文件原始字节。
 * @returns {{text: string, encoding: string, bom: boolean, lossy?: true}} 解码结果。
 */
export function decodeText(bytes) {
  const bom = detectBom(bytes)
  if (bom !== undefined) {
    const text = new TextDecoder(bom.encoding).decode(bytes.subarray(bom.length))
    return { text, encoding: bom.encoding, bom: true }
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8', bom: false }
  } catch {
    /* 不是合法 UTF-8，继续尝试中文旧编码 */
  }
  for (const candidate of ['gbk', 'big5']) {
    try {
      return { text: new TextDecoder(candidate, { fatal: true }).decode(bytes), encoding: candidate, bom: false }
    } catch {
      /* 换下一个候选编码 */
    }
  }
  return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'utf-8', bom: false, lossy: true }
}

/**
 * 统计文本使用的换行风格。
 * @param {string} text - 任意文本。
 * @returns {'crlf'|'lf'|'cr'|'mixed'|'none'} 风格；混用返回 mixed。
 */
export function detectEol(text) {
  const crlf = (text.match(/\r\n/g) ?? []).length
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length
  const cr = (text.match(/\r(?!\n)/g) ?? []).length
  const kinds = [crlf > 0, lf > 0, cr > 0].filter(Boolean).length
  if (kinds === 0) return 'none'
  if (kinds > 1) return 'mixed'
  return crlf > 0 ? 'crlf' : lf > 0 ? 'lf' : 'cr'
}

/**
 * 取得文本的主导换行风格（mixed 时取出现次数多的一种）。
 * @param {string} text - 任意文本。
 * @param {'crlf'|'lf'|'cr'} [fallback] - 无换行时的回退风格。
 * @returns {'crlf'|'lf'|'cr'} 主导风格。
 */
export function dominantEol(text, fallback = 'lf') {
  const style = detectEol(text)
  if (style === 'mixed') {
    const crlf = (text.match(/\r\n/g) ?? []).length
    const lf = (text.match(/(?<!\r)\n/g) ?? []).length
    return crlf >= lf ? 'crlf' : 'lf'
  }
  return style === 'none' ? fallback : style
}

/**
 * 换行风格对应的字符序列。
 * @param {'crlf'|'lf'|'cr'} eol - 风格。
 * @returns {string} 字符序列。
 */
export function eolChars(eol) {
  if (eol === 'crlf') return '\r\n'
  if (eol === 'cr') return '\r'
  return '\n'
}

/**
 * 把文本里的所有换行统一成目标风格。
 * @param {string} text - 任意文本。
 * @param {'crlf'|'lf'|'cr'} eol - 目标风格。
 * @returns {string} 规范化后的文本。
 */
export function normalizeEol(text, eol) {
  return text.replace(/\r\n|\r|\n/g, eolChars(eol))
}

/**
 * 去掉文本开头的 BOM 字符（模型复制内容时经常带进来）。
 * @param {string} text - 任意文本。
 * @returns {string} 无 BOM 文本。
 */
export function stripBom(text) {
  return text.startsWith(BOM_CHAR) ? text.slice(1) : text
}

/**
 * 按逻辑行切分（统一按 LF 处理后切分，末尾空行不计）。
 * @param {string} text - 任意文本。
 * @returns {string[]} 逻辑行数组。
 */
export function splitLines(text) {
  const normalized = text.replace(/\r\n|\r/g, '\n')
  const lines = normalized.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * 统计逻辑行数。
 * @param {string} text - 任意文本。
 * @returns {number} 行数。
 */
export function countLines(text) {
  return splitLines(text).length
}

/**
 * 人类可读的换行风格标签。
 * @param {string} eol - 风格。
 * @returns {string} 如 `CRLF` / `LF` / `无换行`。
 */
export function eolLabel(eol) {
  if (eol === 'crlf') return 'CRLF'
  if (eol === 'lf') return 'LF'
  if (eol === 'cr') return 'CR'
  return '无换行'
}

/**
 * 人类可读的编码标签。
 * @param {string} encoding - 编码名。
 * @param {boolean} bom - 是否带 BOM。
 * @returns {string} 如 `utf-8 (BOM)`。
 */
export function encodingLabel(encoding, bom) {
  return bom ? `${encoding} (BOM)` : encoding
}
