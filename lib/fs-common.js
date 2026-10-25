/**
 * 文件工具共用的小工具函数。
 * @module @local/dsh-doc-pipeline/fs-common
 */

/**
 * 解析相对路径所用的选项：以**当前工作目录**（跟随会话 cd）为基准。
 *
 * 历史行为是 `workspaceRoot ?? session.header.cwd`，即永远锚在会话创建时的目录；
 * 冒烟第六轮实测到 `cd` 之后相对路径仍指向工作区根。现在改为优先跟随 cd。
 * 注意：`workspaceRoot` 只作为**兜底基准**，它作为沙箱围栏的职责由
 * `currentPolicy()` 单独承担（写操作仍显式传 sandboxPolicy），换目录不放宽可写范围。
 *
 * @param {object} exec - 工具执行上下文。
 * @param {string} [workspaceRoot] - 沙箱工作区根，仅在拿不到 cd 时作为兜底基准。
 * @param {object} [ctx] - 插件上下文；提供时按 workingDirectory 解析基准。
 * @returns {{cwd?: string, signal: AbortSignal}} fs.resolve 的选项。
 */
export function resolveOptions(exec, workspaceRoot, ctx) {
  let cwd
  if (ctx !== undefined) {
    try {
      cwd = workingCwd(ctx, exec)
    } catch {
      cwd = workspaceRoot ?? exec.agent?.session.header.cwd
    }
  } else {
    cwd = workspaceRoot ?? exec.agent?.session.header.cwd
  }
  return {
    ...(cwd === undefined ? {} : { cwd }),
    signal: exec.signal
  }
}

/**
 * 解析本次调用的沙箱策略；不传策略等于放弃沙箱约束，因此每次都要解析。
 * @param {object} ctx - 插件上下文。
 * @param {object} exec - 工具执行上下文。
 * @returns {object|undefined} 策略对象；组合未挂载 sandboxPolicy 时为 undefined。
 */
export function currentPolicy(ctx, exec) {
  const service = ctx.get('sandboxPolicy')
  if (service === undefined) return undefined
  return service.resolve({ ...(exec.agent === undefined ? {} : { session: exec.agent.session }) })
}

/**
 * 人类可读的字节数。
 * @param {number} bytes - 字节数。
 * @returns {string} 如 `1.2 KB`。
 */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

/**
 * 校验一个必填字符串参数。
 * @param {unknown} value - 原始参数值。
 * @param {string} name - 参数名，用于报错。
 * @returns {string} 去掉首尾空白后仍非空的字符串。
 */
export function requireString(value, name) {
  if (typeof value !== 'string') throw new Error(`${name} 必须是字符串`)
  if (value.trim() === '') throw new Error(`${name} 必须是非空字符串`)
  return value
}

/**
 * 校验一个可选的整数参数。
 * @param {unknown} value - 原始参数值。
 * @param {string} name - 参数名，用于报错。
 * @param {number} fallback - 缺省值。
 * @param {number} [min] - 允许的最小值，默认 1。
 * @returns {number} 校验后的整数。
 */
export function optionalPositiveInt(value, name, fallback, min = 1) {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw new Error(`${name} 必须是不小于 ${min} 的整数`)
  }
  return value
}

/** UTF-8 编码后的字节数。 */
export function utf8Bytes(text) {
  return new TextEncoder().encode(text).length
}

/**
 * 归一化模型给的路径：去掉包裹引号、去掉 `file://` 前缀、展开 `%20`。
 * 目的是让「路径写法」不成为模型出错的地方；分隔符不做转换（Windows 两种都认）。
 * @param {unknown} value - 原始参数值。
 * @param {string} name - 参数名，用于报错。
 * @returns {string} 可直接交给 fs.resolve 的路径。
 */
export function normalizePathInput(value, name) {
  const raw = requireString(value, name).trim()
  let path = raw
  if (path.length >= 2) {
    const first = path[0]
    const last = path[path.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) path = path.slice(1, -1).trim()
  }
  if (path.toLowerCase().startsWith('file://')) {
    path = decodeURIComponent(path.slice('file://'.length).replace(/^\/(?=[A-Za-z]:)/u, ''))
  }
  if (path === '') throw new Error(`${name} 去掉引号后是空路径`)
  return path
}

/**
 * 当前工作目录：**跟随会话的 cd**，而不是永远锚在会话创建时的目录。
 *
 * 背景（冒烟第六轮实测）：`working_directory(cd=…)` 只改运行时快照里的当前目录，
 * 而本插件此前一律用 `session.header.cwd`（会话创建时的目录）解析相对路径，
 * 于是 agent 以为自己"在子目录里"，实际所有相对路径都指向工作区根 —— 很容易读写错位置。
 *
 * 解析顺序：`workingDirectory.get(session)`（跟随 cd）→ `session.header.cwd`（兜底）。
 * 注意：这里只决定**相对路径的基准**；沙箱围栏仍由 `currentPolicy().workspaceRoot` 决定，
 * 两者职责分开 —— 换目录不等于放宽可写范围。
 *
 * @param {object} ctx - 插件上下文。
 * @param {object} exec - 工具执行上下文。
 * @returns {string} 宿主路径。
 */
export function workingCwd(ctx, exec) {
  const session = exec.agent?.session
  if (session !== undefined) {
    try {
      const service = ctx.get('workingDirectory')
      const value = service?.get?.(session)
      if (typeof value === 'string' && value !== '') return value
    } catch {
      /* 服务不可用或抛错时退回会话 cwd */
    }
  }
  const cwd = session?.header.cwd
  if (cwd === undefined) throw new Error('无法确定工作目录：会话没有 cwd，也没有 workingDirectory 服务')
  return cwd
}

/**
 * 本次调用的工作目录（子进程 cwd 等）：跟随会话 cd，沙箱根仅作兜底。
 * @param {object} ctx - 插件上下文。
 * @param {object} exec - 工具执行上下文。
 * @returns {string} 宿主路径。
 */
export function cwdFor(ctx, exec) {
  try {
    return workingCwd(ctx, exec)
  } catch {
    const policy = currentPolicy(ctx, exec)
    if (policy?.workspaceRoot !== undefined) return policy.workspaceRoot
    throw new Error('无法确定工作目录：会话没有 cwd，也没有沙箱工作区根')
  }
}
