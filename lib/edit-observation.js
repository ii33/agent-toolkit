/**
 * 放宽「编辑前必须先读」的观测策略。
 *
 * 问题：出货的 `fs-observation-policy` 对 `fs/edit-intent` 要求该 (agent, 文件) 先被
 * **观测**过，否则抛 `FS_NOT_OBSERVED`（"edit requires reading ... first"）。在
 * generic 预设里这是失败率最高的工具路径（edit 30/1016）。失败一次 → 重试一次
 * → 模型学到"绕开 edit，用 `sh -c 'cat > file'` 或 `sed -i` 更快"，这正是
 * shell 冗余率 84% 的一部分来源。
 *
 * 取舍：`fs/stale` 由文件版本（CAS）守护，与"是否读过"无关——`editText()` 仍然带着
 * `{ version: observed.version }` 做版本校验，文件被外部改动照样报 `FS_STALE_VERSION`。
 * 所以放开的只是"没见过这个文件"这一种拒绝，**不是**放开并发冲突保护。
 *
 * 实现：`fs/edit-intent` 是 waterfall。本模块的监听器把 `next()` 的拒绝接住，
 * 只在 code === 'FS_NOT_OBSERVED' 时改答 `undefined`（= 不加版本前提），
 * 其它错误（`FS_NOT_FOUND`、沙箱拒绝等）原样抛出。
 *
 * 注意次序：`ctx.on()` 的监听器按注册次序串进瀑布，后注册的在上游。本插件在
 * preset 作用域里先于出货的 `fs-observation-policy` 挂在宿主层，因此这里会是
 * 内层（先被调用）——这正好：先问它，再决定要不要兜住它的拒绝。
 *
 * @module @local/dsh-agent-toolkit/edit-observation
 */

/** 出货观测策略"没见过这个文件"的拒绝码。 */
const NOT_OBSERVED = 'FS_NOT_OBSERVED'

/**
 * 读取错误对象上的 code 字段。
 * @param {unknown} error - 抛出的值。
 * @returns {string|undefined} 错误码。
 */
function codeOf(error) {
  if (error === null || typeof error !== 'object') return undefined
  const code = /** @type {{ code?: unknown }} */ (error).code
  return typeof code === 'string' ? code : undefined
}

/**
 * 登记 `fs/edit-intent` 的放宽监听器。
 *
 * 用可选的 `config.relaxEditRequiresRead === false` 关掉（默认开启）。
 * @param {object} ctx - 作用域上下文。
 * @returns {boolean} 是否成功登记。
 */
export function applyEditObservation(ctx) {
  if (typeof ctx?.on !== 'function') return false
  try {
    ctx.effect(() => ctx.on('fs/edit-intent', async (target, actor, next) => {
      try {
        return await next()
      } catch (error) {
        if (codeOf(error) !== NOT_OBSERVED) throw error
        // 只放行"没读过"：其余拒绝（未找到、沙箱）继续向上抛。
        return undefined
      }
    }), 'agent-toolkit: relax edit requires read')
    return true
  } catch {
    return false
  }
}
