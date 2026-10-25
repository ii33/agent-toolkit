/**
 * 代理能力：探测外网可达性，必要时把子进程切到本地代理端口。
 *
 * 本地代理端口在插件设置 `dsh-plugin.json` 里填：
 *   { "proxy": { "port": 7890, "slow_ms": 3000, "probe_url": "https://pypi.org/simple/" } }
 *
 * 判定结果写进运行期环境缓存，于是 pip / git / npm / docling / curl 这些子进程
 * 自动带上 HTTP(S)_PROXY——模型与用户都不需要手动设置。挂载时会主动探一次；
 * `net_check` 工具可随时重探并把结论摊开给人看。
 *
 * @module @local/dsh-agent-toolkit/proxy-tool
 */
import { ensureRuntimeEnv, lastProbe } from '../lib/proxy.js'
import { loadSettings, mirrorConfig, proxyConfig } from '../lib/settings.js'
import { createToolRegistrar } from './registry.js'

/** 需要工具注册表与文件系统（读设置）。 */
export const inject = ['tools', 'fs']

/**
 * 定义 net_check。
 * @param {object} ctx - 插件上下文。
 * @returns {object} 工具定义。
 */
function netCheckDefinition(ctx) {
  return {
    name: 'net_check',
    description: '探测外网直连与本地代理的可达性/延迟，并决定子进程是否走代理。设置里改 proxy.port 后用它重探。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        refresh: { type: 'boolean', description: '忽略缓存强制重探。默认 false（5 分钟缓存）。' },
        probe_url: { type: 'string', description: '覆盖探测目标；默认用设置里的 proxy.probe_url。' },
        force_proxy: { type: 'boolean', description: '强制走代理（即使直连正常）。' }
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          use_proxy: { type: 'boolean' },
          proxy_url: { type: 'string' },
          detail: { type: 'string' },
          pip_index_url: { type: 'string' },
          npm_registry: { type: 'string' },
          settings_file: { type: 'string' },
          env_keys: { type: 'array', items: { type: 'string' } }
        },
        required: ['use_proxy', 'proxy_url', 'detail', 'pip_index_url', 'npm_registry', 'env_keys']
      },
      render: (_args, value) => [{
        type: 'text',
        text: `<net use-proxy="${value.use_proxy}" proxy="${value.proxy_url}"/>\n${value.detail}\n`
          + `镜像：pip=${value.pip_index_url} npm=${value.npm_registry}\n`
          + `已注入子进程环境：${value.env_keys.join(', ')}`
          + (value.settings_file === undefined ? '\n（未找到设置文件：可在工作区根创建 dsh-plugin.json）' : `\n设置文件：${value.settings_file}`)
      }]
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const result = await ensureRuntimeEnv(ctx, exec, {
        force: args?.refresh === true,
        forceProxy: args?.force_proxy === true,
        ...(typeof args?.probe_url === 'string' && args.probe_url !== '' ? { probeUrl: args.probe_url } : {})
      })
      const { settings, file } = await loadSettings(ctx, exec)
      const mirrors = mirrorConfig(settings)
      const proxy = proxyConfig(settings)
      return {
        use_proxy: result.useProxy,
        proxy_url: proxy.url,
        detail: result.detail,
        pip_index_url: mirrors.pipIndexUrl,
        npm_registry: mirrors.npmRegistry,
        ...(file === undefined ? {} : { settings_file: file }),
        env_keys: Object.keys(result.env).filter((key) => /PROXY|REGISTRY|PIP_INDEX/u.test(key)).sort()
      }
    },
    presentCall() {
      return { card: 'generic', title: '网络与代理探测', kind: 'other' }
    }
  }
}

/**
 * 挂载 net_check，并在挂载后主动探一次（失败不影响其他能力）。
 * @param {object} ctx - preset 作用域的插件上下文。
 */
export function apply(ctx) {
  const register = createToolRegistrar(ctx)
  register(netCheckDefinition(ctx))
  void (async () => {
    try {
      await ensureRuntimeEnv(ctx, { signal: undefined })
    } catch {
      /* 探测失败只是没有代理环境，不影响工具可用性 */
    }
  })()
  void lastProbe
}
