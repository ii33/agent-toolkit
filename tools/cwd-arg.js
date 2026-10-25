/**
 * 工具调用的 `cwd` 参数解析与校验（run / sh / pwsh 共用）。
 *
 * 为什么需要它：相对路径如果原样交给 `spawn`，子进程会拿**宿主进程的 cwd** 当基准；
 * 一旦那个基准不可用（Desktop 宿主的进程 cwd 就常常不是会话工作目录），失败抛的是
 * `spawn <program> ENOENT` —— 看起来像"程序不存在"，实际是"工作目录不合法"，
 * 模型会朝完全错误的方向修。
 *
 * 本模块统一的规则：
 *   1. 相对路径按 `cwdFor(ctx, exec)`（会话工作目录）解析 —— 与 fs 类工具的解析基准一致；
 *   2. Windows 上额外接受 bash 里写惯的 `/c/Users/x` 形式（转换后确实存在才采用）；
 *   3. 解析结果必须**存在且是目录**，否则报错并同时给出"真正的原因"和原始值；
 *   4. 没有会话工作目录时只接受绝对路径（错误信息说清楚这一点）。
 *
 * @module @local/dsh-agentkit/tools/cwd-arg
 */
import { existsSync, statSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { cwdFor, normalizePathInput } from '../lib/fs-common.js'

/**
 * 会话工作目录；取不到（没有会话上下文）时返回 undefined。
 * @param {object} ctx - 插件上下文。
 * @param {object} exec - 工具执行上下文。
 * @returns {string|undefined} 绝对工作目录。
 */
function sessionCwd(ctx, exec) {
  try {
    const cwd = cwdFor(ctx, exec)
    return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
  } catch {
    return undefined
  }
}

/**
 * Windows 上把 MSYS/Cygwin 的 `/c/Users/x` 转成 `C:\Users\x`（仅当转换结果存在时采用）。
 * @param {string} value - 形如 `/c/…` 的路径。
 * @returns {string|undefined} Windows 形式路径，或 undefined（不是该形式/不存在）。
 */
function fromPosixDrivePath(value) {
  const match = /^\/([A-Za-z])\/(.*)$/u.exec(value)
  if (match === null) return undefined
  const candidate = `${match[1].toUpperCase()}:\\${match[2].replace(/\//gu, '\\')}`
  return existsSync(candidate) ? candidate : undefined
}

/**
 * 解析并校验一次工具调用的 cwd。
 * @param {object} ctx - 插件上下文。
 * @param {object} exec - 工具执行上下文。
 * @param {unknown} value - 模型给的 `cwd`；undefined 表示用会话工作目录。
 * @returns {string} 可直接交给 spawn 的绝对目录。
 * @throws {Error} 相对路径但没有会话工作目录；解析结果不存在；解析结果不是目录。
 */
export function resolveCallCwd(ctx, exec, value) {
  const base = sessionCwd(ctx, exec)
  if (value === undefined) {
    if (base === undefined) throw new Error('cwd 无法确定：本次调用没有会话工作目录，请显式给一个绝对路径')
    return base
  }
  const raw = normalizePathInput(value, 'cwd')
  let resolved = raw
  if (!isAbsolute(raw)) {
    if (base === undefined) throw new Error(`cwd 必须是绝对路径（本次调用没有会话工作目录可作基准）："${raw}"`)
    resolved = resolvePath(base, raw)
  } else if (process.platform === 'win32') {
    const translated = fromPosixDrivePath(raw)
    if (translated !== undefined) resolved = translated
  }
  if (!existsSync(resolved)) {
    throw new Error(`cwd 不存在："${raw}"（按${isAbsolute(raw) ? '原样' : `会话工作目录 ${base} `}解析为 ${resolved}）`)
  }
  let info
  try {
    info = statSync(resolved)
  } catch (error) {
    throw new Error(`cwd 无法访问："${raw}"（${error instanceof Error ? error.message : String(error)}）`)
  }
  if (!info.isDirectory()) throw new Error(`cwd 不是目录："${raw}"（解析为 ${resolved}）`)
  return resolved
}
