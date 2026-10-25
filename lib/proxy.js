/**
 * 外网可达性探测与本地代理选择。
 *
 * 场景：外网直连不通或很慢时，走本机代理端口（Clash / v2ray 之类）。端口在
 * `dsh-plugin.json` 的 `proxy.port` 里填。探测结果会写进运行期环境缓存，
 * 于是 pip / git / npm / docling / curl 这些子进程**自动**带上 HTTP(S)_PROXY，
 * 不需要模型或用户手动设置。
 *
 * 判定：先直连探一次（HTTPS HEAD，测延迟），再测代理端口是否可连；
 * 直连失败或慢于 `slow_ms` 且代理可用 → 走代理。
 *
 * @module @local/dsh-agent-toolkit/proxy
 */
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createConnection } from 'node:net'
import { loadSettings, baseEnv, mirrorHosts, proxyConfig, setRuntimeEnv } from './settings.js'

/** 探测结果缓存时长。 */
const TTL_MS = 5 * 60 * 1000

/** 缓存。 */
let cached = { at: 0, env: {}, detail: '', useProxy: false, direct: undefined, proxy: undefined }

/**
 * TCP 连通性探测（用于判断本地代理端口是否在听）。
 * @param {string} host - 主机。
 * @param {number} port - 端口。
 * @param {number} timeoutMs - 超时。
 * @returns {Promise<{ok: boolean, ms: number, error?: string}>} 结果。
 */
export function tcpProbe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const socket = createConnection({ host, port })
    const finish = (ok, error) => {
      socket.destroy()
      resolve({ ok, ms: Date.now() - startedAt, ...(error === undefined ? {} : { error }) })
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false, 'timeout'))
    socket.once('error', (error) => finish(false, error.code ?? error.message))
  })
}

/**
 * HTTP(S) 探测一次（HEAD，测直连延迟）。
 * @param {string} url - 目标 URL。
 * @param {number} timeoutMs - 超时。
 * @returns {Promise<{ok: boolean, ms: number, status?: number, error?: string}>} 结果。
 */
export function httpProbe(url, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    let parsed
    try {
      parsed = new URL(url)
    } catch (error) {
      resolve({ ok: false, ms: 0, error: `非法 URL：${error instanceof Error ? error.message : String(error)}` })
      return
    }
    const send = parsed.protocol === 'https:' ? httpsRequest : httpRequest
    const request = send(
      { method: 'HEAD', host: parsed.hostname, port: parsed.port === '' ? undefined : Number(parsed.port), path: parsed.pathname + parsed.search, timeout: timeoutMs },
      (response) => {
        response.resume()
        resolve({ ok: (response.statusCode ?? 0) < 500, ms: Date.now() - startedAt, status: response.statusCode })
      }
    )
    request.once('timeout', () => {
      request.destroy()
      resolve({ ok: false, ms: Date.now() - startedAt, error: 'timeout' })
    })
    request.once('error', (error) => resolve({ ok: false, ms: Date.now() - startedAt, error: error.code ?? error.message }))
    request.end()
  })
}

/**
 * 探测并决定是否走代理。
 * @param {object} settings - 设置对象。
 * @param {{forceProxy?: boolean, probeUrl?: string}} [options] - 覆盖项。
 * @returns {Promise<{useProxy: boolean, detail: string, direct: object, proxy: object, env: object}>} 决定结果。
 */
export async function decideProxy(settings, options = {}) {
  const config = proxyConfig(settings)
  const env = baseEnv(settings)
  if (!config.enabled) {
    return { useProxy: false, detail: '代理已在设置里关闭（proxy.enabled=false）', direct: {}, proxy: {}, env }
  }
  // 多个探测目标取"最差直连"：任一个不通或慢，就说明该走代理
  const targets = Array.isArray(options.probeUrls) && options.probeUrls.length > 0
    ? options.probeUrls
    : (typeof options.probeUrl === 'string' && options.probeUrl !== '' ? [options.probeUrl] : config.probeUrls)
  const [directList, proxy] = await Promise.all([
    Promise.all(targets.map(async (url) => ({ url, ...(await httpProbe(url, config.timeoutMs)) }))),
    tcpProbe(config.host, config.port, Math.min(config.timeoutMs, 3000))
  ])
  const failed = directList.filter((entry) => !entry.ok)
  const worstMs = directList.reduce((max, entry) => (entry.ok ? Math.max(max, entry.ms) : max), 0)
  const directBad = failed.length > 0 || worstMs > config.slowMs
  const useProxy = options.forceProxy === true || (proxy.ok && directBad)
  const directDetail = directList
    .map((entry) => `${entry.url.replace(/^https?:\/\//u, '')} ${entry.ok ? `${entry.ms}ms` : `失败(${entry.error})`}`)
    .join('、')
  const detail = [
    `直连最差 ${worstMs}ms${failed.length > 0 ? `（${failed.length} 个不通）` : ''}：${directDetail}`,
    `本地代理 ${config.url}：${proxy.ok ? `${proxy.ms}ms` : `不可用(${proxy.error})`}`,
    useProxy ? `→ 使用代理（阈值 ${config.slowMs}ms）` : '→ 直连'
  ].join('；')
  // 软件源走镜像、不走代理：把镜像主机也加进 NO_PROXY，避免 pip/npm/HF 绕远
  const noProxy = [...new Set([...config.noProxy, ...mirrorHosts(settings)])].join(',')
  if (useProxy) {
    env.HTTP_PROXY = config.url
    env.HTTPS_PROXY = config.url
    env.ALL_PROXY = config.url
    env.http_proxy = config.url
    env.https_proxy = config.url
    env.all_proxy = config.url
  }
  env.NO_PROXY = noProxy
  env.no_proxy = noProxy
  return { useProxy, detail, direct: { targets: directList, worstMs, failed: failed.length }, proxy, env }
}

/**
 * 确保运行期环境已就绪（带 TTL 缓存），供子进程使用。
 * @param {object} ctx - 插件上下文。
 * @param {object} exec - 工具执行上下文。
 * @param {{force?: boolean, forceProxy?: boolean, probeUrl?: string}} [options] - 覆盖项。
 * @returns {Promise<{env: object, detail: string, useProxy: boolean}>} 环境与说明。
 */
export async function ensureRuntimeEnv(ctx, exec, options = {}) {
  if (options.force !== true && Date.now() - cached.at < TTL_MS && Object.keys(cached.env).length > 0) {
    return { env: cached.env, detail: cached.detail, useProxy: cached.useProxy }
  }
  const { settings, error } = await loadSettings(ctx, exec)
  const decision = await decideProxy(settings, options)
  const detail = error === undefined ? decision.detail : `${decision.detail}（设置文件有问题：${error}）`
  cached = { at: Date.now(), env: decision.env, detail, useProxy: decision.useProxy, direct: decision.direct, proxy: decision.proxy }
  setRuntimeEnv(decision.env)
  return { env: decision.env, detail, useProxy: decision.useProxy }
}

/**
 * 最近一次探测结果（供工具展示）。
 * @returns {object} 缓存内容。
 */
export function lastProbe() {
  return { at: cached.at, detail: cached.detail, useProxy: cached.useProxy, direct: cached.direct, proxy: cached.proxy }
}
