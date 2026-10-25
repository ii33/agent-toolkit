/**
 * 插件设置：一个文件管全部可调项（镜像、代理、远程主机、fs 行为）。
 *
 * 位置（工作区根目录，按顺序取第一个存在的）:
 *   dsh-plugin.json
 *   .dsh/dsh-plugin.json
 * 兼容旧配置：只有 sftp-hosts.json 时会被当作 `sftp.hosts` 读取。
 *
 * 形如:
 *   {
 *     "mirrors": { "pip_index_url": "https://pypi.tuna.tsinghua.edu.cn/simple",
 *                  "npm_registry": "https://registry.npmmirror.com" },
 *     "proxy":   { "enabled": true, "host": "127.0.0.1", "port": 7890, "scheme": "http",
 *                  "slow_ms": 3000, "probe_url": "https://pypi.org/simple/",
 *                  "no_proxy": ["localhost", "127.0.0.1", "remote1"] },
 *     "sftp":    { "hosts": { "remote1": { "host": "remote1", "user": "sakuya",
 *                                          "strict_host_key": true, "root": "/",
 *                                          "description": "公钥已配置的测试主机" } } }
 *   }
 *
 * @module @local/dsh-agent-toolkit/settings
 */
import { homedir } from 'node:os'
import { SETTINGS_NAMESPACE } from './config-schema.js'
import { currentPolicy, resolveOptions } from './fs-common.js'

/** 设置文件候选路径。 */
export const SETTINGS_FILES = ['dsh-plugin.json', '.dsh/dsh-plugin.json']

/** 旧的远程主机配置路径（兼容）。 */
export const LEGACY_HOST_FILES = ['sftp-hosts.json', '.dsh/sftp-hosts.json']

/** 默认 pip 镜像（清华 TUNA，本机实测最快）。 */
export const DEFAULT_PIP_INDEX_URL = 'https://pypi.tuna.tsinghua.edu.cn/simple'

/** 默认 npm 镜像。 */
export const DEFAULT_NPM_REGISTRY = 'https://registry.npmmirror.com'

/** 默认模型源镜像（docling / huggingface 下载走它）。 */
export const DEFAULT_HF_ENDPOINT = 'https://hf-mirror.com'

/** 默认本地代理端口（Clash / v2ray 一类客户端的常见端口）。 */
export const DEFAULT_PROXY_PORT = 7890

/** 默认探测目标（多个取最差延迟）：模型下载、raw 文件、包索引各一个典型。 */
export const DEFAULT_PROBE_URLS = [
  'https://raw.githubusercontent.com/',
  'https://pypi.org/simple/',
  'https://huggingface.co/'
]

/** 运行期环境缓存（供同步的 subprocessEnv 读取）。 */
let runtimeEnv = {}

/**
 * 读取当前运行期环境（同步，供子进程环境拼装）。
 * @returns {Record<string, string>} 环境变量。
 */
export function runtimeEnvVars() {
  return { ...runtimeEnv }
}

/**
 * 覆盖运行期环境缓存。
 * @param {Record<string, string|undefined>} next - 新的环境变量集合。
 */
export function setRuntimeEnv(next) {
  runtimeEnv = { ...next }
}

/**
 * 展开 `~` 为 home 目录（Windows 上也要能认）。
 * @param {string} path - 可能以 `~` 开头的路径。
 * @returns {string} 展开后的路径。
 */
export function expandHome(path) {
  if (typeof path !== 'string' || !path.startsWith('~')) return path
  return path.replace(/^~(?=[\\/]|$)/u, homedir())
}

/** 读一个可能是 volatile 引用（cosmokit）或普通值的字段。 */
function plain(value) {
  if (value === undefined || value === null) return value
  if (typeof value === 'object' && typeof value.get === 'function') {
    try {
      return value.get()
    } catch {
      return undefined
    }
  }
  return value
}

/**
 * 读「插件」设置页里的那份配置（宿主行命名空间）。
 * 页面写入的是 profile 行的 config；这里把它当作**默认值**，
 * 工作区的 dsh-plugin.json 仍然可以覆盖（后者按项目走）。
 * @param {object} ctx - 插件上下文。
 * @returns {object} 与设置文件同形的部分设置。
 */
export function namespaceSettings(ctx) {
  const settings = ctx?.get?.('settings')
  if (settings === undefined) return {}
  try {
    const descriptor = settings.describe().find((entry) => entry.ns === SETTINGS_NAMESPACE)
    const value = descriptor?.value
    if (value === undefined || value === null || typeof value !== 'object') return {}
    const merged = {}
    // volatile 字段解析后可能是 cosmokit 引用 → 解引用后再用
    const mirrors = plain(value.mirrors)
    const proxy = plain(value.proxy)
    const hosts = plain(value.sftp_hosts)
    if (mirrors !== undefined) merged.mirrors = mirrors
    if (proxy !== undefined) merged.proxy = proxy
    if (hosts !== undefined && hosts !== null && typeof hosts === 'object' && Object.keys(hosts).length > 0) {
      merged.sftp = { hosts }
    }
    return merged
  } catch {
    return {}
  }
}

/**
 * 设置页（默认值）与工作区文件（覆盖）合并；sftp.hosts 按代号逐项合并。
 * @param {object} ctx - 插件上下文。
 * @param {object} fileSettings - 工作区文件里的设置。
 * @returns {object} 合并后的设置。
 */
function mergeSettings(ctx, fileSettings) {
  const base = namespaceSettings(ctx)
  const merged = { ...base, ...fileSettings }
  if (base.sftp !== undefined || fileSettings.sftp !== undefined) {
    merged.sftp = {
      ...(base.sftp ?? {}),
      ...(fileSettings.sftp ?? {}),
      hosts: { ...(base.sftp?.hosts ?? {}), ...(fileSettings.sftp?.hosts ?? {}) }
    }
  }
  return merged
}

/**
 * 读取设置文件。
 * @param {object} ctx - 插件上下文。
 * @param {object} exec - 工具执行上下文。
 * @returns {Promise<{settings: object, file?: string, error?: string}>} 设置内容。
 */
export async function loadSettings(ctx, exec) {
  for (const relative of SETTINGS_FILES) {
    const target = await ctx.fs.resolve(relative, resolveOptions(exec))
    const info = await ctx.fs.stat(target, exec.signal)
    if (info === undefined || info.type !== 'file') continue
    const text = await ctx.fs.readText(target, exec.signal)
    try {
      const parsed = JSON.parse(text)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { settings: {}, file: target.displayPath, error: '设置文件必须是一个 JSON 对象' }
      }
      return { settings: mergeSettings(ctx, parsed), file: target.displayPath }
    } catch (error) {
      return { settings: {}, file: target.displayPath, error: `JSON 解析失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }
  // 兼容：只有 sftp-hosts.json 的旧配置
  for (const relative of LEGACY_HOST_FILES) {
    const target = await ctx.fs.resolve(relative, resolveOptions(exec))
    const info = await ctx.fs.stat(target, exec.signal)
    if (info === undefined || info.type !== 'file') continue
    const text = await ctx.fs.readText(target, exec.signal)
    try {
      const parsed = JSON.parse(text)
      const hosts = parsed?.hosts ?? parsed
      return { settings: { sftp: { hosts } }, file: target.displayPath }
    } catch (error) {
      return { settings: {}, file: target.displayPath, error: `JSON 解析失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }
  return { settings: mergeSettings(ctx, {}) }
}

/**
 * 镜像配置。
 * @param {object} settings - 设置对象。
 * @returns {{pipIndexUrl: string, npmRegistry: string}} 镜像地址。
 */
export function mirrorConfig(settings) {
  const mirrors = settings?.mirrors ?? {}
  return {
    pipIndexUrl: typeof mirrors.pip_index_url === 'string' && mirrors.pip_index_url !== ''
      ? mirrors.pip_index_url
      : (process.env.DSH_PIP_INDEX_URL ?? DEFAULT_PIP_INDEX_URL),
    npmRegistry: typeof mirrors.npm_registry === 'string' && mirrors.npm_registry !== ''
      ? mirrors.npm_registry
      : (process.env.DSH_NPM_REGISTRY ?? DEFAULT_NPM_REGISTRY),
    hfEndpoint: typeof mirrors.hf_endpoint === 'string' && mirrors.hf_endpoint !== ''
      ? mirrors.hf_endpoint
      : (process.env.DSH_HF_ENDPOINT ?? DEFAULT_HF_ENDPOINT)
  }
}

/**
 * 所有镜像站的主机名——**软件源走镜像、不走代理**：这些域名要进 NO_PROXY。
 * @param {object} settings - 设置对象。
 * @returns {string[]} 主机名列表。
 */
export function mirrorHosts(settings) {
  const { pipIndexUrl, npmRegistry, hfEndpoint } = mirrorConfig(settings)
  return [pipIndexUrl, npmRegistry, hfEndpoint]
    .map((url) => {
      try {
        return new URL(url).host
      } catch {
        return undefined
      }
    })
    .filter((host) => typeof host === 'string' && host !== '')
}

/**
 * 代理配置（本地代理端口在这里填）。
 * @param {object} settings - 设置对象。
 * @returns {object} 代理配置。
 */
export function proxyConfig(settings) {
  const proxy = settings?.proxy ?? {}
  const host = typeof proxy.host === 'string' && proxy.host !== '' ? proxy.host : '127.0.0.1'
  const port = Number.isInteger(proxy.port) ? proxy.port : Number(proxy.port ?? DEFAULT_PROXY_PORT)
  const scheme = typeof proxy.scheme === 'string' && proxy.scheme !== '' ? proxy.scheme : 'http'
  return {
    enabled: proxy.enabled !== false,
    host,
    port: Number.isFinite(port) ? port : DEFAULT_PROXY_PORT,
    scheme,
    url: `${scheme}://${host}:${Number.isFinite(port) ? port : DEFAULT_PROXY_PORT}`,
    slowMs: Number.isFinite(Number(proxy.slow_ms)) ? Number(proxy.slow_ms) : 3000,
    probeUrls: Array.isArray(proxy.probe_url)
      ? proxy.probe_url.filter((entry) => typeof entry === 'string' && entry !== '')
      : (typeof proxy.probe_url === 'string' && proxy.probe_url !== '' ? [proxy.probe_url] : DEFAULT_PROBE_URLS),
    timeoutMs: Number.isFinite(Number(proxy.timeout_ms)) ? Number(proxy.timeout_ms) : 8000,
    noProxy: Array.isArray(proxy.no_proxy) ? proxy.no_proxy.filter((entry) => typeof entry === 'string') : ['localhost', '127.0.0.1', '::1']
  }
}

/**
 * 远程主机表。
 * @param {object} settings - 设置对象。
 * @returns {Record<string, object>} 代号 → 主机配置。
 */
export function sftpHosts(settings) {
  const hosts = settings?.sftp?.hosts
  if (typeof hosts !== 'object' || hosts === null || Array.isArray(hosts)) return {}
  return hosts
}

/**
 * 写入/更新一台远程主机到统一设置文件（保留其他设置项）。
 * 只接受 `password_env`（环境变量名）或 `key`（私钥路径）——**不接受明文密码**。
 * @param {object} ctx - 插件上下文。
 * @param {object} exec - 工具执行上下文。
 * @param {string} code - 主机代号。
 * @param {object} config - 主机配置。
 * @returns {Promise<{file: string, hosts: number}>} 写入结果。
 */
export async function saveHost(ctx, exec, code, config) {
  if (typeof config.password === 'string') {
    throw new Error('不要把明文密码写进设置文件：请改用 password_env（环境变量名），密码只留在环境里')
  }
  const { settings, file } = await loadSettings(ctx, exec)
  const hosts = { ...sftpHosts(settings), [code]: config }
  const next = { ...settings, sftp: { ...(settings.sftp ?? {}), hosts } }
  const target = await ctx.fs.resolve(file ?? SETTINGS_FILES[0], resolveOptions(exec))
  const intent = await ctx.waterfall('fs/write-intent', target, exec, () => undefined)
  // **必须显式带上本次调用的沙箱策略**（第 5 个参数）。省略它时 fs-sandbox 会退回
  // `ctx.sandboxPolicy.resolve()`（**不带 session**）——见 dsh-fs-sandbox/lib/index.js:153-165
  // `const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()`；不带 session 的
  // workspaceRoot 是"部署兜底根"，而不是本会话的工作区根，于是本插件自己的设置文件被拒
  // （`file access denied under workspace-write mode`）。出货 write/edit 与本包其它写路径
  // 都传 currentPolicy(ctx, exec)：tools/fs.js:407、tools/env.js:243、tools/doc.js:320、
  // tools/tasks.js:152、tools/split.js:131/155。
  const policy = currentPolicy(ctx, exec)
  const outcome = await ctx.fs.writeText(target, `${JSON.stringify(next, null, 2)}\n`, intent, exec.signal, policy)
  ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
  return { file: target.displayPath, hosts: Object.keys(hosts).length }
}

/**
 * 从统一设置文件里删除一台远程主机。
 * @param {object} ctx - 插件上下文。
 * @param {object} exec - 工具执行上下文。
 * @param {string} code - 主机代号。
 * @returns {Promise<{file: string, removed: boolean, hosts: number}>} 删除结果。
 */
export async function removeHost(ctx, exec, code) {
  const { settings, file } = await loadSettings(ctx, exec)
  const hosts = { ...sftpHosts(settings) }
  const removed = Object.hasOwn(hosts, code)
  delete hosts[code]
  const next = { ...settings, sftp: { ...(settings.sftp ?? {}), hosts } }
  const target = await ctx.fs.resolve(file ?? SETTINGS_FILES[0], resolveOptions(exec))
  const intent = await ctx.waterfall('fs/write-intent', target, exec, () => undefined)
  // 与 saveHost 同理：显式传本次调用的沙箱策略，否则 fs-sandbox 会用不带 session 的兜底根。
  const policy = currentPolicy(ctx, exec)
  const outcome = await ctx.fs.writeText(target, `${JSON.stringify(next, null, 2)}\n`, intent, exec.signal, policy)
  ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
  return { file: target.displayPath, removed, hosts: Object.keys(hosts).length }
}

/**
 * 与网络无关的基础环境变量（镜像、编码、颜色）。
 * @param {object} settings - 设置对象。
 * @returns {Record<string, string>} 环境变量。
 */
export function baseEnv(settings) {
  const { pipIndexUrl, npmRegistry, hfEndpoint } = mirrorConfig(settings)
  let pipHost
  try {
    pipHost = new URL(pipIndexUrl).host
  } catch {
    pipHost = undefined
  }
  return {
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    PYTHONLEGACYWINDOWSSTDIO: '0',
    NO_COLOR: '1',
    TERM: 'dumb',
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    PIP_INDEX_URL: pipIndexUrl,
    ...(pipHost === undefined ? {} : { PIP_TRUSTED_HOST: pipHost }),
    NPM_CONFIG_REGISTRY: npmRegistry,
    npm_config_registry: npmRegistry,
    YARN_REGISTRY: npmRegistry,
    PNPM_REGISTRY: npmRegistry,
    // 模型源镜像：docling / huggingface_hub 会自动读它
    HF_ENDPOINT: hfEndpoint,
    HF_HUB_DISABLE_TELEMETRY: '1'
  }
}
