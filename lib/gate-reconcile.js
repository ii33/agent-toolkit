/**
 * 能力闸门对账：把「设置页里实际打开的能力」与「每个预设行声明的 tools」对齐。
 *
 * 背景（实测缺陷）：设置页关掉某个能力后，`settingsGate()` 会在注册时拦住它，
 * 但预设补丁里那一行的 `tools: [...]` 数组原样不动 —— 配置与实际生效完全脱节。
 * 用户此前只能自己去 YAML 里手删，删漏了就会出现
 * 「工具没注册上、却仍出现在预设声明里」的静默不一致。
 *
 * 本模块只做纯计算：给定闸门、预设当前能力表，算出应当写入的能力表。
 * 写回由调用方（tools/preset.js 的 syncFromSettings）负责。
 *
 * @module @local/dsh-agentkit/lib/gate-reconcile
 */

/**
 * 把预设的能力表与闸门取交集。
 *
 * 语义要点：
 * - 闸门为 `undefined` = 设置页没配置过，此时是「不设闸门」，**不做裁剪**；
 * - 闸门为空数组 = 显式全关，结果为空（调用方据此把预设标成不可用，而不是默默留旧值）；
 * - 只裁剪、不新增：用户在预设里没开的能力，不因为闸门开着就凭空加进去。
 *
 * @param {string[]} declared - 预设行当前声明的能力。
 * @param {string[]|undefined} gate - 闸门打开的能力；undefined 表示不设闸门。
 * @returns {{capabilities: string[], removed: string[], changed: boolean}} 对账结果。
 */
export function reconcileCapabilities(declared, gate) {
  const list = Array.isArray(declared) ? declared.filter((name) => typeof name === 'string') : []
  if (gate === undefined) return { capabilities: list, removed: [], changed: false }
  const allowed = new Set(gate)
  const kept = list.filter((name) => allowed.has(name))
  const removed = list.filter((name) => !allowed.has(name))
  // 顺序沿用声明顺序，避免每次同步都把数组重排成另一份内容
  return { capabilities: kept, removed, changed: removed.length > 0 }
}

/**
 * 修正一组预设编辑项。
 *
 * @param {Record<string, {capabilities?: string[]}>} edits - 现有的每预设编辑（来自状态文件）。
 * @param {string[]|undefined} gate - 闸门。
 * @param {string[]} managed - 本工具集管理的预设 id（只对它们动手）。
 * @returns {{edits: Record<string, object>, fixed: Array<{preset: string, removed: string[]}>}} 结果。
 */
export function reconcileEdits(edits, gate, managed) {
  const next = { ...(edits ?? {}) }
  const fixed = []
  if (gate === undefined) return { edits: next, fixed }
  for (const id of managed ?? []) {
    const current = next[id]
    if (current === undefined || !Array.isArray(current.capabilities)) continue
    const { capabilities, removed, changed } = reconcileCapabilities(current.capabilities, gate)
    if (!changed) continue
    next[id] = { ...current, capabilities }
    fixed.push({ preset: id, removed })
  }
  return { edits: next, fixed }
}
