/**
 * 工具注册的**去冲突层**：把"这个名字是不是已经被出货工具占了"变成显式判断。
 *
 * 为什么需要它（按 DSH 0.2.1-rc.2 的实测契约，逐条在下面写明）：
 *   - `ctx.tools.register(def)` 把定义插进**调用者 ctx 所属的 scope 层**
 *     （`@deepseek-ai/dsh-tools` 的 `register()` 走 `layers.effect(this.ctx, layer => layer.tools.insert(...))`，
 *     层由 `@deepseek-ai/dsh-scope` 的 `ScopedLayers.effect()` 按 `scopeOf(ctx)` 选出）。
 *   - 同一层里重名会**抛错**：`tool "<name>" is already registered in this scope`。
 *   - 跨层不抛错：`view()` 先铺全局层、再按 scope 链覆盖，**本 scope 的同名注册会静默遮蔽出货工具**
 *     （`@deepseek-ai/dsh-tools` 自己的说明："Scoped tools shadow globals"）。
 *
 * 于是"静默遮蔽"和"直接抛错挂掉整个 preset"是同一件事的两种失败面。本模块的规则：
 *   1. 注册前先问运行时：`ctx.tools.get(name)`（不带 scope = 全局视图）——出货工具就是从这里看见的。
 *   2. 命中 TAKEOVER（按设计要接管的三个名字）：注册，但**显式**记一条日志与报告，不再是静默遮蔽。
 *   3. 命中其它任何已存在的名字：**跳过注册**（保留出货实现）+ `logger.warn` + 记进报告。
 *   4. 同层重名（register 抛错）与定义不合契约一样：**原样抛出**，不吞错。
 *
 * 判定标准是"运行时当前是否已经解析出同名定义"，而不是一份写死的出货工具名单：
 * 出货工具增删（例如某个包在 0.2.x 里改名）不会让这份判断过期。
 *
 * @module @local/dsh-agentkit/tools/registry
 */

/**
 * 同一 scope 里**按设计**遮蔽出货工具的名字，以及为什么必须这么做。
 * 这三个是工具集存在的理由（编码/换行/远程路径兜底），且实现本身走
 * `ctx.fs` + `fs/write-intent` + `fs/observed`，与出货的观测策略是同一套，所以接管是安全的。
 * @type {ReadonlyMap<string, string>}
 */
export const DESIGNED_TAKEOVERS = new Map([
  ['read', '按原字符集解码（GBK/UTF-16）+ 远程 `代号:/路径`，出货 read 只处理 UTF-8'],
  ['write', '按目标文件原字符集写回 + 远程写，出货 write 只写 UTF-8'],
  ['edit', '匹配前统一换行（消灭 CRLF 导致的 old_string not found）+ 远程编辑']
])

/**
 * 撞名时**主动让给出货实现**的名字，以及让出的理由。
 * 这两个的出货实现比本工具集更强：`pwsh` 走 ctx.shell（沙箱策略 + 审批升级 + 后台作业），
 * `read_image` 走附件服务（路由图像能力闸门 + 去重 + UI 图片卡）。
 * 让出后能力仍在（出货工具对同名 agent 可见），只是实现换成更稳的那个。
 * @type {ReadonlyMap<string, string>}
 */
export const YIELDED_NAMES = new Map([
  ['pwsh', '*本工具集的 pwsh 绕过 ctx.shell 的沙箱策略与审批；出货 tool-pwsh 更完整'],
  ['read_image', '出货 read_image 有图像能力路由闸门与附件持久化；本工具集的版本没有']
])

/** 每个 ctx 的注册报告，供 index.js / 测试读取。 */
const REPORTS = new WeakMap()

/** 已经由本模块登记过的定义对象（判"是自己人"而不是"撞了出货工具"）。 */
const OWN = new WeakSet()

/**
 * 读一个 ctx 的工具注册报告。
 * @param {object} ctx - 插件上下文。
 * @returns {{total: number, registered: string[], takenOver: Array<{name: string, why: string}>, yielded: Array<{name: string, why: string}>, reentrant: string[]}|undefined} 报告。
 */
export function collisionReportOf(ctx) {
  return REPORTS.get(ctx)
}

/**
 * 运行时的可见性查询：当前作用域是否已经解析出同名定义。
 * 老版本没有 `tools.get` 时返回 undefined（退化为"直接注册"，由运行时自己判重名）。
 * @param {object} ctx - 插件上下文。
 * @param {string} name - 工具名。
 * @returns {object|undefined} 已存在的定义。
 */
function visibleDefinition(ctx, name) {
  const tools = ctx?.tools
  if (tools === undefined || typeof tools.get !== 'function') return undefined
  try {
    return tools.get(name)
  } catch {
    // get() 在你 queried 的 scope 上失败不该阻断注册；退化为由 register() 自己判重名。
    return undefined
  }
}

/**
 * 造一个去冲突注册器。每个 `apply(ctx)` 造一个，并在里面注册本能力的全部工具。
 * @param {object} ctx - preset 作用域的插件上下文。
 * @param {{takeovers?: Map<string, string>, yields?: Map<string, string>}} [policy] - 覆盖默认策略（测试与将来配置化用）。
 * @returns {((definition: object) => (() => void)|undefined)} 注册函数；`register.report` 是本次报告。
 */
export function createToolRegistrar(ctx, policy = {}) {
  const takeovers = policy.takeovers ?? DESIGNED_TAKEOVERS
  const yields = policy.yields ?? YIELDED_NAMES
  const logger = ctx?.logger
  // index.js 是**一个 ctx 上依次挂多个能力**，所以报告按 ctx 累加而不是覆盖：
  // 否则只能读到最后一个能力的报告。
  const report = REPORTS.get(ctx) ?? { total: 0, registered: [], takenOver: [], yielded: [], reentrant: [] }
  REPORTS.set(ctx, report)
  const seen = new Set()

  /**
   * 注册一个工具定义。
   * @param {object} definition - ToolDefinition。
   * @returns {(() => void)|undefined} 卸载函数（让出时 undefined）。
   */
  function register(definition) {
    const name = definition?.name
    if (typeof name !== 'string' || name === '') {
      throw new TypeError('agentkit: 工具定义缺少 name（ToolDefinition 要求 name/description/parameters/output）')
    }
    if (seen.has(name)) throw new Error(`agentkit: 同一次挂载里重复注册工具 "${name}"`)
    seen.add(name)
    report.total += 1

    const existing = visibleDefinition(ctx, name)
    let takeoverWhy
    if (existing !== undefined && !OWN.has(existing)) {
      if (takeovers.has(name)) {
        // 先动手再记账：能不能接管取决于同名定义是"更外层（全局）"还是"同一个 preset 作用域"。
        takeoverWhy = takeovers.get(name)
      } else {
        const why = yields.get(name) ?? '本工具集的同名实现与出货工具重复'
        report.yielded.push({ name, why })
        logger?.warn(`agentkit: 跳过注册 "${name}" —— 当前作用域已被出货工具占用，保留出货实现：${why}`)
        return undefined
      }
    } else if (existing !== undefined) {
      // 自己上一代注册还没卸载（HMR 重入）：跳过而不是抛错，保持幂等。
      report.reentrant.push(name)
      logger?.info(`agentkit: "${name}" 已由本插件注册过，跳过重复挂载`)
      return undefined
    }

    // 同层重名（`tool "<name>" is already registered in this scope`）有两种来源，处理必须分开：
    //   1. 目标预设**自带的插件**（例如 cordis 的 tool-fs 注册了 read/write/edit）与我们在同一个
    //      preset 作用域里注册 —— 这时接管不可能发生（同层禁止重名），抛错会让整个预设 mount 失败、
    //      注册表把它标成 broken，于是「新会话」里那个预设直接不可选。
    //      实测踩过：给内置 cordis 注入工具集后，cordis 从选择器里消失。
    //      结论：让出，保留预设自带实现，只记一条警告。
    //   2. 其它任何失败（定义不合 ToolDefinition 契约、run_code 保留名等）：原样抛出，不吞错。
    let dispose
    try {
      dispose = ctx.tools.register(definition)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!/is already registered in this scope/u.test(message)) throw error
      const why = `同一 preset 作用域里已有同名工具（${message}）`
      report.yielded.push({ name, why })
      logger?.warn(`agentkit: 跳过注册 "${name}" —— 该预设自带的插件已在同一作用域注册了同名工具，保留它：${why}`)
      return undefined
    }
    if (takeoverWhy !== undefined) {
      report.takenOver.push({ name, why: takeoverWhy })
      logger?.info(`agentkit: "${name}" 按设计接管当前作用域里的同名出货工具（本 preset 作用域遮蔽全局定义）：${takeoverWhy}`)
    }
    OWN.add(definition)
    report.registered.push(name)
    return dispose
  }

  register.report = report
  return register
}

/**
 * 把报告压成一行日志文本（`apply` 末尾调用，便于在宿主日志里一眼看到撞名结论）。
 * @param {object} report - {@link createToolRegistrar} 的报告。
 * @returns {string} 单行摘要。
 */
export function summarizeReport(report) {
  if (report === undefined) return 'agentkit: 无注册报告'
  const parts = [`已注册 ${report.registered.length}/${report.total}`]
  if (report.takenOver.length > 0) parts.push(`接管 ${report.takenOver.map((item) => item.name).join(', ')}`)
  if (report.yielded.length > 0) parts.push(`让出 ${report.yielded.map((item) => item.name).join(', ')}`)
  if (report.reentrant.length > 0) parts.push(`重复挂载跳过 ${report.reentrant.join(', ')}`)
  return `agentkit: ${parts.join('；')}`
}
