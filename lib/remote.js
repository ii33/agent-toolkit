/**
 * 远程 SFTP 后端：把「主机代号」映射成一台远程主机，并复用一条常驻连接。
 *
 * 模型看到的是一个**代号**（如 `nas`），在路径里写成 `nas:/data/book.md` 就能像本地
 * 一样读写——代号在 `sftp-hosts.json` 里定义，工具描述会告诉模型"这个代号代表一台远程主机"。
 *
 * 连接保活：每个代号对应一个常驻 Python 侧车（AsyncSSH），侧车持有长连接；
 * 空闲超过 idle 时间才断开（进程继续存活，下次请求重连）。因此批量文档操作
 * 不会每次都付一次登录/握手成本。
 *
 * 凭据不进模型上下文：密码只通过**环境变量名**（`password_env`）交给侧车，
 * 私钥用路径；两者都不会出现在工具参数或返回值里。
 *
 * 配置文件（工作区根目录，任选其一）:
 *   sftp-hosts.json
 *   .dsh/sftp-hosts.json
 * 形如:
 *   {
 *     "hosts": {
 *       "nas": {
 *         "host": "10.0.0.5", "port": 22, "user": "me",
 *         "key": "C:/Users/me/.ssh/id_ed25519",
 *         "password_env": "NAS_SFTP_PASSWORD",
 *         "root": "/volume1", "description": "家庭 NAS 文档库",
 *         "idle_seconds": 900
 *       }
 *     }
 *   }
 *
 * @module @local/dsh-doc-pipeline/remote
 */
import { fileURLToPath } from 'node:url'
import { PIP_INDEX_URL, pythonPathArg, pythonPathStyle, subprocessEnv } from './exec.js'
import { resolvePython } from './python.js'
import { resolveOptions } from './fs-common.js'
import { expandHome, loadSettings, sftpHosts } from './settings.js'

/** 侧车脚本路径。 */
const SIDECAR = fileURLToPath(new URL('../tools/sftp_sidecar.py', import.meta.url))

/** 配置文件名（按顺序探测）。 */
const HOST_FILES = ['sftp-hosts.json', '.dsh/sftp-hosts.json']

/** 单次远程读的上限。 */
export const MAX_REMOTE_BYTES = 16 * 1024 * 1024

/** 单次请求等待上限。 */
const REQUEST_TIMEOUT_MS = 120_000

/** 默认空闲断开时间（秒）。 */
const DEFAULT_IDLE_SECONDS = 900

/** 每个代号一个会话。 */
const sessions = new Map()

/**
 * 从路径里拆出主机代号。
 * 规则：`code:/path` 或 `code://path`；单字母 + 紧跟分隔符视为 Windows 盘符（`C:\…`）。
 * @param {string} pathInput - 模型给的路径。
 * @returns {{code: string, remotePath: string}|undefined} 代号与远程路径。
 */
export function splitHostCode(pathInput) {
  const match = /^([A-Za-z][A-Za-z0-9_-]{0,31}):(.*)$/u.exec(pathInput)
  if (match === null) return undefined
  const code = match[1].toLowerCase()
  const rest = match[2]
  if (code.length === 1 && /^[\\/]/u.test(rest)) return undefined
  if (!rest.startsWith('/') && !rest.startsWith('\\')) return undefined
  return { code, remotePath: rest.replace(/^[\\/]+/u, '/') }
}

/**
 * 读取主机配置（工作区根目录的 sftp-hosts.json）。
 * @param {object} ctx - 插件上下文。
 * @param {object} exec - 工具执行上下文。
 * @returns {Promise<{hosts: Record<string, object>, file?: string, error?: string}>} 配置。
 */
export async function loadHosts(ctx, exec) {
  // 统一设置文件优先（dsh-plugin.json 的 sftp.hosts）；loadSettings 内部兼容旧的 sftp-hosts.json
  const loaded = await loadSettings(ctx, exec)
  return {
    hosts: sftpHosts(loaded.settings),
    ...(loaded.file === undefined ? {} : { file: loaded.file }),
    ...(loaded.error === undefined ? {} : { error: loaded.error })
  }
}

/**
 * 主机键校验参数：`strict_host_key !== false` 时用 `~/.ssh/known_hosts` 校验（默认，安全）；
 * 显式设 false 则不做校验（等价于 StrictHostKeyChecking=no）。
 * @param {object} host - 主机配置。
 * @param {'posix'|'windows'} style - python 的路径风格（MSYS2 python 只认 POSIX 形式）。
 * @returns {string[]} argv 片段。
 */
function knownHostsArgs(host, style) {
  if (host.strict_host_key === false) return []
  const configured = typeof host.known_hosts === 'string' && host.known_hosts !== '' ? host.known_hosts : '~/.ssh/known_hosts'
  return ['--known-hosts', pythonPathArg(expandHome(configured), style)]
}

/** 旧的逐文件读取（保留：需要在没有统一设置文件时按老路径找配置）。 */
async function loadHostsLegacy(ctx, exec) {
  for (const relative of HOST_FILES) {
    const target = await ctx.fs.resolve(relative, resolveOptions(exec))
    const info = await ctx.fs.stat(target, exec.signal)
    if (info === undefined || info.type !== 'file') continue
    const text = await ctx.fs.readText(target, exec.signal)
    try {
      const parsed = JSON.parse(text)
      const hosts = parsed?.hosts ?? parsed
      if (typeof hosts !== 'object' || hosts === null || Array.isArray(hosts)) {
        return { hosts: {}, file: target.displayPath, error: 'hosts 必须是一个对象' }
      }
      return { hosts, file: target.displayPath }
    } catch (error) {
      return { hosts: {}, file: target.displayPath, error: `JSON 解析失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }
  return { hosts: {} }
}

/**
 * 把模型给的路径解析成远程目标（代号必须在配置里）。
 * @param {object} ctx - 插件上下文。
 * @param {object} exec - 工具执行上下文。
 * @param {string} pathInput - 模型给的路径。
 * @returns {Promise<{code: string, host: object, remotePath: string, displayPath: string}|undefined>} 远程目标，或 undefined 表示按本地处理。
 */
export async function resolveRemote(ctx, exec, pathInput) {
  const split = splitHostCode(pathInput)
  if (split === undefined) return undefined
  const { hosts } = await loadHosts(ctx, exec)
  const host = hosts[split.code]
  if (host === undefined || typeof host !== 'object') return undefined
  const root = typeof host.root === 'string' ? host.root : ''
  const remotePath = split.remotePath === '' ? (root === '' ? '/' : root) : `/${split.remotePath.replace(/^\/+/u, '')}`
  return {
    code: split.code,
    host,
    remotePath,
    displayPath: `${split.code}:${remotePath}`
  }
}

/** 把一个待决请求登记进会话。 */
function dispatch(session, line) {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  const pending = session.pending.get(message.id)
  if (pending === undefined) return
  session.pending.delete(message.id)
  clearTimeout(pending.timer)
  if (message.ok === true) pending.resolve(message)
  else pending.reject(new Error(`${message.error ?? '远程操作失败'}${message.code === undefined ? '' : `（${message.code}）`}`))
}

/** 会话失效时清空所有待决请求。 */
function failAll(session, error) {
  for (const pending of session.pending.values()) {
    clearTimeout(pending.timer)
    pending.reject(error)
  }
  session.pending.clear()
}

/** 重置空闲计时器：到点断开连接并回收进程。 */
function scheduleIdle(session) {
  if (session.idleTimer !== undefined) clearTimeout(session.idleTimer)
  session.idleTimer = setTimeout(() => {
    void (async () => {
      try {
        await request(session, 'close', {})
      } catch {
        /* 忽略关闭失败 */
      }
      try {
        session.handle.terminate()
      } catch {
        /* 进程可能已退出 */
      }
      sessions.delete(session.key)
    })()
  }, session.idleMs)
  session.idleTimer.unref?.()
}

/** 建立一个代号的侧车会话。 */
async function ensureSession(ctx, exec, remote) {
  const key = remote.code
  const existing = sessions.get(key)
  if (existing !== undefined && existing.alive) return existing

  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined) throw new Error('SFTP 需要 subprocess 服务，但当前组合没有挂载它')
  // 侧车需要 asyncssh：**必须探针**，否则会选中 DSH 自带但没有 asyncssh 的那份
  // （<resourcesPath>/runtime/... 只有 PIL）。全都不通过时 resolvePython 退回第一个候选，
  // 由侧车自己的 --auto-install 兜底。
  const python = await resolvePython(ctx, exec, 'import asyncssh')

  const host = remote.host
  // MSYS2 python 不认 `D:\…` 形式的 argv 路径（会被当成相对路径），先探测再转写。
  // 侧车脚本、私钥、known_hosts 都是本机路径，都要转；`--root` 是远程路径，保持原样。
  const style = await pythonPathStyle(ctx, exec, python)
  const argv = [
    python, pythonPathArg(SIDECAR, style),
    // 自检直通：host.self_test=true 时用侧车的内存后端，便于在没有真实主机时验证整条 JS 管道
    ...(host.self_test === true ? ['--self-test'] : []),
    '--host', String(host.host ?? ''),
    '--port', String(host.port ?? 22),
    ...(host.user === undefined ? [] : ['--user', String(host.user)]),
    ...(host.key === undefined ? [] : ['--key', pythonPathArg(expandHome(String(host.key)), style)]),
    ...(host.password_env === undefined ? [] : ['--password-env', String(host.password_env)]),
    ...knownHostsArgs(host, style),
    ...(host.root === undefined ? [] : ['--root', String(host.root)]),
    '--idle-timeout', String(host.idle_seconds ?? DEFAULT_IDLE_SECONDS),
    // 依赖也封进工具里：asyncssh 缺失时侧车自己按镜像装（host.auto_install=false 可关掉）
    '--auto-install', host.auto_install === false ? '0' : '1',
    '--pip-index-url', PIP_INDEX_URL
  ]
  const handle = subprocess.spawn({
    argv,
    cwd: ctx.fs.processPath(await ctx.fs.resolve('.', resolveOptions(exec))),
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    graceMs: 5000,
    env: subprocessEnv()
  })
  const session = {
    key,
    code: remote.code,
    handle,
    alive: true,
    nextId: 0,
    pending: new Map(),
    buffer: '',
    stderr: [],
    idleMs: Math.max(30_000, Number(host.idle_seconds ?? DEFAULT_IDLE_SECONDS) * 1000),
    idleTimer: undefined,
    logins: 0
  }
  ;(async () => {
    try {
      for await (const chunk of handle.stdout) {
        session.buffer += chunk.toString('utf8')
        let index
        while ((index = session.buffer.indexOf('\n')) !== -1) {
          const line = session.buffer.slice(0, index)
          session.buffer = session.buffer.slice(index + 1)
          if (line.trim() !== '') dispatch(session, line)
        }
      }
    } catch {
      /* 流异常按退出处理 */
    }
  })()
  ;(async () => {
    try {
      for await (const chunk of handle.stderr) {
        session.stderr.push(chunk.toString('utf8'))
        if (session.stderr.length > 40) session.stderr.shift()
      }
    } catch {
      /* 忽略 */
    }
  })()
  handle.done.then(() => {
    session.alive = false
    failAll(session, new Error(`SFTP 侧车已退出：${session.stderr.join('').trim().slice(0, 300) || '(无 stderr)'}`))
    if (sessions.get(key) === session) sessions.delete(key)
  }).catch(() => {})
  sessions.set(key, session)
  scheduleIdle(session)
  return session
}

/** 发一个请求并等待响应。 */
function request(session, op, params) {
  return new Promise((resolve, reject) => {
    const id = (session.nextId += 1)
    const timer = setTimeout(() => {
      session.pending.delete(id)
      reject(new Error(`SFTP 请求超时（${op}，${REQUEST_TIMEOUT_MS}ms）`))
    }, REQUEST_TIMEOUT_MS)
    session.pending.set(id, { resolve, reject, timer })
    try {
      session.handle.stdin.write(`${JSON.stringify({ id, op, ...params })}\n`)
    } catch (error) {
      clearTimeout(timer)
      session.pending.delete(id)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

/** 统一入口：拿到会话后发请求。 */
async function call(ctx, exec, remote, op, params) {
  const session = await ensureSession(ctx, exec, remote)
  try {
    const response = await request(session, op, params)
    if (typeof response.logins === 'number') session.logins = response.logins
    scheduleIdle(session)
    return response
  } catch (error) {
    scheduleIdle(session)
    throw error
  }
}

/**
 * 远程 stat。
 * @returns {Promise<{type: string, size: number|undefined}|undefined>} 不存在时为 undefined。
 */
export async function remoteStat(ctx, exec, remote) {
  const response = await call(ctx, exec, remote, 'stat', { path: remote.remotePath })
  const info = response.info
  if (info === null || info === undefined) return undefined
  return { type: info.type === 'dir' ? 'directory' : info.type === 'file' ? 'file' : 'other', size: info.size ?? undefined, mtime: info.mtime }
}

/** 远程列目录。 */
export async function remoteList(ctx, exec, remote) {
  const response = await call(ctx, exec, remote, 'list', { path: remote.remotePath })
  return (response.entries ?? []).map((entry) => ({
    name: entry.name,
    type: entry.type === 'dir' ? 'directory' : entry.type === 'file' ? 'file' : 'other',
    size: entry.size ?? undefined
  }))
}

/**
 * 远程读字节。
 * @param {object} ctx - 插件上下文。
 * @param {object} exec - 工具执行上下文。
 * @param {object} remote - 远程目标。
 * @param {number} [maxBytes] - 整文件读的上限。
 * @param {{offset: number, length: number}} [range] - 给定则只读该字节窗口（不受上限约束）。
 * @returns {Promise<Uint8Array>} 字节。
 */
export async function remoteReadBytes(ctx, exec, remote, maxBytes = MAX_REMOTE_BYTES, range) {
  const params = range === undefined
    ? { path: remote.remotePath, max_bytes: maxBytes }
    : { path: remote.remotePath, offset: range.offset, length: range.length }
  const response = await call(ctx, exec, remote, 'read', params)
  return new Uint8Array(Buffer.from(response.data ?? '', 'base64'))
}

/** 远程写字节。 */
export async function remoteWriteBytes(ctx, exec, remote, bytes) {
  const response = await call(ctx, exec, remote, 'write', {
    path: remote.remotePath,
    data: Buffer.from(bytes).toString('base64')
  })
  return { bytes: response.bytes ?? 0 }
}

/** 远程 ping（会建立连接，可用于验证凭据）。 */
export async function remotePing(ctx, exec, remote) {
  const response = await call(ctx, exec, remote, 'ping', {})
  return { connected: response.connected === true, logins: response.logins ?? 0 }
}

/** 关闭某个代号的会话。 */
export async function closeSession(code) {
  const session = sessions.get(code)
  if (session === undefined) return false
  sessions.delete(code)
  if (session.idleTimer !== undefined) clearTimeout(session.idleTimer)
  try {
    await request(session, 'close', {})
  } catch {
    /* 忽略 */
  }
  try {
    session.handle.terminate()
  } catch {
    /* 忽略 */
  }
  return true
}

/** 关闭全部会话（插件卸载时调用）。 */
export function closeAllSessions() {
  for (const code of [...sessions.keys()]) void closeSession(code)
}

/** 当前活跃会话信息（供 sftp_hosts 工具展示）。 */
export function sessionInfo() {
  return [...sessions.values()].map((session) => ({
    code: session.code,
    alive: session.alive,
    logins: session.logins,
    pending: session.pending.size
  }))
}
