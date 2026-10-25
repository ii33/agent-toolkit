/**
 * 插件设置页的 Config schema。
 *
 * **为什么字段要 volatile**：设置平面（`settings.describe()` / 客户端的 `configForms`）
 * 服务的是**易变配置** —— 写入由 Loader 就地提交进运行中的插件、不触发重载。
 * 实测对照：同一台机器上唯一出现在 `describe()` 里的第三方命名空间
 * （`@local/dsh-compaction-policy`）用的就是 `.volatile()` 字段。
 *
 * **0.2.1-rc.2 实测**（`@deepseek-ai/schemastery` 3.18.5，见其 package.json 与 lib/index.mjs）：
 *   1. `.volatile()` **已有原生实现**（lib/index.mjs:235-238，语义就是 `extra('volatile', true)`，
 *      重名包裹时抛 `volatile schema is already wrapped`）→ 下面的原型垫片在 3.18.5 上是惰性的，
 *      只为 peer 范围下界（`>=3.18.4`）里可能没有该方法的版本保留；
 *   2. volatile 路径的值**原生就被包成 cosmokit 引用**（lib/index.mjs:265-277 调 `createVolatile`）
 *      → 本模块的 `~standard` 包装是幂等的兼容网（`isVolatile` 命中就原样返回）；
 *   3. `cosmokit@1.8.6` 导出 `createVolatile` / `isVolatile`（lib/index.js 导出表），
 *      `createVolatile(value)` 返回 `{ get(), [write] }`，所以读配置要解引用（见 index.js 的 `plain()`）。
 *
 * schemastery / cosmokit 是 harness 装机包；离线测试（普通 node）解析不到，
 * 所以这里**动态取用并降级**：取不到就让 Config 为 undefined（harness 里才有设置页，
 * 功能照常）。绝不在包内放 node_modules 假实现——那会遮蔽 harness 的真 schemastery。
 *
 * @module @local/dsh-agentkit/config-schema
 */

/** 本插件在 settings 里的命名空间 = 宿主行的 Loader 行 id。 */
export const SETTINGS_NAMESPACE = 'agentkit'

let z
let createVolatile
let isVolatile
try {
  z = (await import('@deepseek-ai/schemastery')).default
} catch {
  z = undefined
}
try {
  const cosmokit = await import('@deepseek-ai/cosmokit')
  createVolatile = cosmokit.createVolatile
  isVolatile = cosmokit.isVolatile
} catch {
  createVolatile = undefined
  isVolatile = undefined
}

/** schemastery 3.18.5 已有原生 `.volatile()`；这里只为更早的 3.18.x 兜底（存在时整段惰性）。 */
if (z !== undefined) {
  const SchemaPrototype = Object.getPrototypeOf(z.object({}))
  if (typeof SchemaPrototype.volatile !== 'function') {
    Object.defineProperty(SchemaPrototype, 'volatile', {
      value: function volatile() {
        if (this.meta !== undefined && this.meta.volatile) {
          throw new TypeError('volatile schema is already wrapped')
        }
        return this.extra('volatile', true)
      },
      writable: true,
      configurable: true
    })
  }
}

/** 一个远程主机的配置（与 dsh-plugin.json 的 sftp.hosts 同形）。 */
const hostSchema = z === undefined
  ? undefined
  : z.object({
      host: z.string().default(''),
      user: z.string().default(''),
      port: z.number().step(1).min(1).max(65535).default(22),
      key: z.string().default(''),
      password_env: z.string().default(''),
      root: z.string().default(''),
      description: z.string().default(''),
      strict_host_key: z.boolean().default(true),
      idle_seconds: z.number().step(1).min(30).max(86400).default(900)
    })

/** 基础 schema：可编辑字段全部 volatile。 */
const baseConfig = z === undefined
  ? undefined
  : z.object({
      /** 宿主行置 true：只承载设置页，不注册任何工具（避免全局污染其他 preset）。 */
      settingsOnly: z.boolean().default(false),
      /** 能力总开关；宿主行这一份是所有 preset 的全局闸门。 */
      capabilities: z.dict(z.boolean()).default({}).volatile(),
      /** 软件源镜像（留空即用内置默认：清华 pip / npmmirror / hf-mirror）。 */
      mirrors: z.object({
        pip_index_url: z.string().default(''),
        npm_registry: z.string().default(''),
        hf_endpoint: z.string().default('')
      }).default({}).volatile(),
      /** 外网代理：直连慢或不通时，子进程自动带上 HTTP(S)_PROXY。 */
      proxy: z.object({
        enabled: z.boolean().default(true),
        host: z.string().default('127.0.0.1'),
        port: z.number().step(1).min(1).max(65535).default(10808),
        slow_ms: z.number().step(1).min(200).max(60000).default(3000),
        probe_url: z.array(z.string()).default([]),
        no_proxy: z.array(z.string()).default([])
      }).default({}).volatile(),
      /** 远程 SFTP 主机表（代号 → 主机）。 */
      sftp_hosts: z.dict(hostSchema).default({}).volatile(),
      /**
       * 把工具集注入到这些预设（id 列表）。宿主行读到它就自动改写生成补丁 ——
       * 能力取上面那份 capabilities 里打开的那些。留空 = 不注入。
       */
      inject_into: z.array(z.string()).default([]).volatile(),
      /** 按预设的精确编辑：id → { capabilities, persona, suffix, complete }；空字段表示不动那一项。 */
      preset_edits: z.dict(z.object({
        capabilities: z.array(z.string()).default([]),
        persona: z.string().default(''),
        /** persona 的 suffix（如 standard 的 `Your working directory is {{cwd}}.`）。 */
        suffix: z.string().default(''),
        /** 'true' 打开 complete、'false' 关掉、''（默认）不动 —— 三态，避免误删原有的 complete: true。 */
        complete: z.string().default('')
      })).default({}).volatile(),
      /** 从设置页新建一个预设（id 留空即不建）。 */
      preset_new: z.object({
        id: z.string().default(''),
        name: z.string().default(''),
        description: z.string().default(''),
        capabilities: z.array(z.string()).default([]),
        persona: z.string().default('')
      }).default({}).volatile()
    })

/** volatile 路径（标准面里要包成 cosmokit 引用）。 */
const VOLATILE_PATHS = ['capabilities', 'mirrors', 'proxy', 'sftp_hosts', 'inject_into', 'preset_edits', 'preset_new']

/** 包成引用（已是引用则原样返回）。 */
const asVolatile = (value) => {
  if (createVolatile === undefined || isVolatile === undefined) return value
  try {
    return isVolatile(value) ? value : createVolatile(value)
  } catch {
    return value
  }
}

if (baseConfig !== undefined) {
  // `baseConfig['~standard']` 是 Schema.prototype 上的 getter（schemastery lib/index.mjs:52-68），
  // 每次读都返回 `{ version: 1, vendor: 'schemastery', validate }`，validate 走 Schema.resolve，
  // 成功给 `{ value }`、失败给 `{ issues }` —— 下面按同一形状转写。
  const baseStandard = baseConfig['~standard']
  /**
   * 标准面：在 volatile 路径上返回 cosmokit 引用，其余照常。
   * 3.18.5 的原生 resolve 已经会 `createVolatile`（lib/index.mjs:265-277），所以这里通常是幂等的；
   * 保留它是因为 peer 范围下界（>=3.18.4）里若某版本不返回引用，设置页保存就会"保存成功但运行中的
   * 插件收不到"——这是本插件踩过的坑。
   */
  const configStandard = {
    version: 1,
    vendor: '@local/dsh-agentkit',
    validate: (input) => {
      const result = baseStandard.validate(input)
      if (result.issues !== undefined) return result
      const value = result.value ?? {}
      const wrapped = { ...value }
      for (const key of VOLATILE_PATHS) wrapped[key] = asVolatile(value[key])
      return { value: wrapped }
    }
  }
  Object.defineProperty(baseConfig, '~standard', { value: configStandard, configurable: true })
}

/** 插件设置；取不到 schemastery 时为 undefined（无设置页，功能照常）。 */
export const Config = baseConfig
