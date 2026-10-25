/**
 * 分块规划（纯函数）：把逻辑行数组切成若干块，供 split_file 落盘。
 * @module @local/dsh-doc-pipeline/split-plan
 */

/**
 * 按固定行数切块。
 * @param {number} totalLines - 总行数。
 * @param {number} size - 每块行数。
 * @param {number} overlap - 相邻块重叠行数（0 表示不重叠）。
 * @returns {Array<{from: number, to: number}>} 1-based 闭区间列表。
 */
export function planLineChunks(totalLines, size, overlap = 0) {
  if (totalLines <= 0) return []
  const step = Math.max(1, size - overlap)
  const chunks = []
  for (let from = 1; from <= totalLines; from += step) {
    const to = Math.min(from + size - 1, totalLines)
    chunks.push({ from, to })
    if (to >= totalLines) break
  }
  return chunks
}

/**
 * 按字符预算切块（先按行累积，超过预算即断开，不切碎行）。
 * @param {readonly string[]} lines - 逻辑行。
 * @param {number} maxChars - 每块字符上限。
 * @returns {Array<{from: number, to: number}>} 1-based 闭区间列表。
 */
export function planByteChunks(lines, maxChars) {
  const chunks = []
  let from = 1
  let used = 0
  for (let index = 0; index < lines.length; index += 1) {
    const cost = lines[index].length + 1
    if (used > 0 && used + cost > maxChars) {
      chunks.push({ from, to: index })
      from = index + 1
      used = 0
    }
    used += cost
  }
  if (from <= lines.length) chunks.push({ from, to: lines.length })
  return chunks
}

/**
 * 按标记行切块：标记行作为下一块的开头。
 * @param {readonly string[]} lines - 逻辑行。
 * @param {RegExp} pattern - 标记行的正则。
 * @returns {Array<{from: number, to: number, title?: string}>} 1-based 闭区间列表。
 */
export function planMarkerChunks(lines, pattern) {
  const starts = []
  for (let index = 0; index < lines.length; index += 1) {
    if (pattern.test(lines[index])) starts.push(index)
  }
  if (starts.length === 0) return [{ from: 1, to: lines.length }]
  if (starts[0] > 0) starts.unshift(0)
  const chunks = []
  for (let index = 0; index < starts.length; index += 1) {
    const from = starts[index]
    const to = index + 1 < starts.length ? starts[index + 1] - 1 : lines.length - 1
    if (to < from) continue
    chunks.push({ from: from + 1, to: to + 1, title: lines[from].trim().slice(0, 80) })
  }
  return chunks
}

/**
 * 块文件名。
 * @param {string} prefix - 文件名前缀。
 * @param {number} index - 1-based 块序号。
 * @param {string} extension - 扩展名（含点）。
 * @returns {string} 文件名。
 */
export function chunkName(prefix, index, extension = '.txt') {
  return `${prefix}-${String(index).padStart(4, '0')}${extension}`
}
