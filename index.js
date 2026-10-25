/**
 * 通用 agent 工具集：一个入口，按 config 选择挂载哪些能力。
 *
 * 这是**通用第三方包**：本地/远程文件读写、shell（bash + pwsh）、镜像加速装依赖、
 * 外网代理探测、任务面板、结构化 shell 禁令——都与"翻译"无关，任何 agent 预设都能用。
 * 文档专用能力（docling 包装、分块、打包）也在同一个包里，但默认不挂，按需开启。
 *
 * 为什么用「一个入口 + config 选能力」而不是多个子路径：
 *   - Node 在进程内缓存 package.json 的 exports 表，新增子路径必须重启才可见；
 *   - 而「改一行 YAML 里的 tools 数组」只需重新加载配置即可生效，开关成本最低。
 *
 * 隔离性：所有能力都注册在**调用它的 preset 作用域**里，因此
 *   - 只有选用该 preset 的会话能看到这些工具；
 *   - 不会注册到宿主全局，也就不影响其他 preset / 会话的默认行为。
 *
 * 用法（preset 的 plugins 行）：
 *   - id: toolkit
 *     name: '@local/dsh-agentkit'
 *     config:
 *       tools: [fs, sftp, run, sh, pwsh, env, proxy, doc, split, img, tasks, guard, preset]
 *
 * 可用能力：
 *   fs     编码 / 换行 / 字符集安全的 read / read_many / write / edit / list_dir（支持 `代号:/远程/路径`）
 *   sftp   sftp_hosts：远程主机代号的发现 / 写入 / 删除 / 验证 / 断开；search_remote：远程内容检索
 *   run    无 shell 的 argv 运行器（效率优先，默认不审批）
 *   sh     bash（POSIX shell）
 *   pwsh   PowerShell 7（pwsh，UTF-8）；Windows PowerShell 5.1 被 guard 禁用
 *   env    env_setup（探测 + 镜像装依赖 + 写 ENV.md）与 pip_install
 *   proxy  net_check：外网/本地代理探测，自动把代理注入子进程环境
 *   doc    ocr_doc（docling 包装）/ merge_files（按 manifest 合并）/ pack（tar 打包）
 *   split  split_file：大文件拆块 + manifest
 *   img    read_image：把图片直接交给模型看（本地或远程）；image_info / crop_image / resize_image
 *   tasks  文件账本任务面板（plan_init / task_update / task_show / stage_set + 面板注入）
 *   guard  结构化 shell 禁令（禁 powershell / powershell_ise / cmd / cmd.exe / shell / bash / terminal*，放行 pwsh / sh）
 *   preset preset_create / preset_list / preset_delete / preset_inject / preset_eject
 *
 * @module @local/dsh-agentkit
 */
import { apply as applyDoc } from './tools/doc.js'
import { apply as applyEnv } from './tools/env.js'
import { apply as applyFs } from './tools/fs.js'
import { apply as applyGuard } from './tools/guard.js'
import { apply as applyImage } from './tools/image.js'
import { apply as applyImageOps } from './tools/image-ops.js'
import { apply as applyProxy } from './tools/proxy.js'
import { apply as applyPwsh } from './tools/pwsh.js'
import { apply as applyRun } from './tools/run.js'
import { apply as applySftp } from './tools/sftp.js'
import { apply as applyRemoteSearch } from './tools/remote-search.js'
import { apply as applySh } from './tools/sh.js'
import { apply as applySplit } from './tools/split.js'
import { apply as applyTasks } from './tools/tasks.js'
import { apply as applyPreset, syncFromSettings } from './tools/preset.js'
import { Config, SETTINGS_NAMESPACE } from './lib/config-schema.js'

/** 设置页的 Config：harness 据它自动生成「插件」页里的表单。 */
export { Config }

/** 只声明必需服务；subprocess / attachments / llm 由各能力在调用时按需获取。 */
export const inject = ['tools', 'fs', 'systemPrompt']

/** 能力表。 */
const CAPABILITIES = {
  fs: applyFs,
  sftp: (ctx) => {
    applySftp(ctx)
    applyRemoteSearch(ctx)
  },
  run: applyRun,
  sh: applySh,
  pwsh: applyPwsh,
  env: applyEnv,
  proxy: applyProxy,
  doc: applyDoc,
  split: applySplit,
  img: (ctx) => {
    applyImage(ctx)
    applyImageOps(ctx)
  },
  tasks: applyTasks,
  guard: applyGuard,
  preset: applyPreset
}

/** 未配置 tools 时挂载全部能力。 */
const DEFAULT_TOOLS = Object.keys(CAPABILITIES)

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
 * 读宿主行（settingsOnly）那份配置里的全局能力闸门。
 * 宿主行与 preset 行是同一个包的两行：宿主行只承载设置页，preset 行才注册工具。
 * @param {object} ctx - 插件上下文。
 * @returns {string[]|undefined} 被打开的能力名；读不到就返回 undefined（表示不设闸门）。
 */
function settingsGate(ctx) {
  const settings = ctx.get('settings')
  if (settings === undefined) return undefined
  try {
    const descriptor = settings.describe().find((entry) => entry.ns === SETTINGS_NAMESPACE)
    // capabilities 是 volatile 字段：解析后可能是 cosmokit 引用，必须解引用
    const capabilities = plain(descriptor?.value?.capabilities)
    if (capabilities === undefined || capabilities === null || typeof capabilities !== 'object') return undefined
    const enabled = Object.entries(capabilities)
      .filter(([, on]) => on === true)
      .map(([name]) => name)
    // 一个都没勾 = 没配置过（而不是"全关"），此时不设闸门
    return enabled.length === 0 ? undefined : enabled
  } catch {
    return undefined
  }
}

/**
 * 挂载被选中的能力。
 * @param {object} ctx - preset 作用域的插件上下文。
 * @param {{tools?: string[], settingsOnly?: boolean}} [config] - 该行的配置。
 */
export function apply(ctx, config) {
  // 宿主行：只承载设置页，不注册任何工具 → 不污染其他 preset。
  // **必须调用 settings.configure()**：设置平面只为"注册过页面策略"的条目列出命名空间
  // （实测 describe() 里出现的那些命名空间全部注册过），否则客户端组件取不到本行的值。
  if (config?.settingsOnly === true) {
    const settings = ctx.get('settings')
    if (settings === undefined) {
      ctx.logger?.info('agent-toolkit: settings-only row（settings 服务不可用，设置页将不可用）')
      return
    }
    try {
      // configure 返回 disposer，按规范登记到 effect 里。
      ctx.effect(() => settings.configure({ auto: true }), 'agent-toolkit: settings page policy')
      ctx.logger?.info(`agent-toolkit: settings-only row（已注册设置页策略，命名空间 ${SETTINGS_NAMESPACE}）`)
    } catch (error) {
      ctx.logger?.info(`agent-toolkit: settings.configure 失败：${error instanceof Error ? error.message : String(error)}`)
    }
    // 设置页里的 inject_into：把工具集注入这些预设（能力取同一份开关里打开的那些）。
    // 保存是 volatile 就地提交，所以除了 apply 还要在设置文档更新时重同步。
    const syncInjectionsFromSettings = () => {
      try {
        const descriptor = settings.describe().find((entry) => entry.ns === SETTINGS_NAMESPACE)
        const value = descriptor?.value ?? {}
        const ids = plain(value.inject_into)
        const capabilities = plain(value.capabilities)
        const enabled = capabilities !== undefined && capabilities !== null && typeof capabilities === 'object'
          ? Object.entries(capabilities).filter(([, on]) => on === true).map(([name]) => name)
          : []
        const edits = plain(value.preset_edits)
        const newPreset = plain(value.preset_new)
        void syncFromSettings(ctx, {
          capabilities: enabled,
          injectInto: Array.isArray(ids) ? ids : [],
          edits: edits !== null && typeof edits === 'object' && !Array.isArray(edits) ? edits : {},
          newPreset: newPreset !== null && typeof newPreset === 'object' ? newPreset : {}
        })
          .then((result) => {
            if (result.changed) {
              ctx.logger?.info('agent-toolkit: 设置页同步完成 —— '
                + `注入 ${result.injected.join(', ') || '（无）'}；`
                + `编辑 ${result.edited.join(', ') || '（无）'}；`
                + `新建 ${result.created.join(', ') || '（无）'}`)
            }
          })
          .catch((error) => {
            ctx.logger?.info(`agent-toolkit: 注入同步失败：${error instanceof Error ? error.message : String(error)}`)
          })
      } catch (error) {
        ctx.logger?.info(`agent-toolkit: 注入同步异常：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    syncInjectionsFromSettings()
    // 兜底：设置文档可能在 apply 之后才加载完，而且用户编辑发生在重启之前时不会再有 volatile 事件。
    // 所以除监听事件外，再做几次延迟重试 + 低频轮询（同步是幂等的：无变化不写文件、不触发重载）。
    try {
      ctx.effect(() => {
        const retries = [
          setTimeout(syncInjectionsFromSettings, 800),
          setTimeout(syncInjectionsFromSettings, 3000)
        ]
        const poll = setInterval(syncInjectionsFromSettings, 10000)
        return () => {
          for (const timer of retries) clearTimeout(timer)
          clearInterval(poll)
        }
      }, 'agent-toolkit: settings sync retry')
    } catch {
      /* 定时器不可用也不影响：至少挂载时同步过一次 */
    }
    try {
      // 0.2.1-rc.2 的事件名是 `settings/document-updated(ns, revision)`：
      // settings 服务在 describe() 里发现该条目的原始配置变化时发出（dsh-settings/lib/index.js:435）。
      // 旧的 `loader/volatile-update` 已不在事件目录里，监听它等于永不触发。
      ctx.on('settings/document-updated', (ns) => {
        if (ns === SETTINGS_NAMESPACE) syncInjectionsFromSettings()
      })
    } catch {
      /* 没有这个事件也不影响：还有延迟重试与轮询兜底 */
    }
    return
  }

  const requested = config?.tools
  const names = requested === undefined ? DEFAULT_TOOLS : requested
  if (!Array.isArray(names) || names.length === 0) {
    throw new Error(`dsh-agent-toolkit: config.tools 必须是非空数组；可用能力：${DEFAULT_TOOLS.join(', ')}`)
  }
  const unknown = names.filter((name) => !Object.hasOwn(CAPABILITIES, name))
  if (unknown.length > 0) {
    throw new Error(`dsh-agent-toolkit: 未知能力 ${unknown.join(', ')}；可用能力：${DEFAULT_TOOLS.join(', ')}`)
  }
  // 宿主行设置页里的总开关与本行的 tools 取交集（设置页勾掉的能力在这里就不注册）
  const gate = settingsGate(ctx)
  const enabled = gate === undefined ? names : names.filter((name) => gate.includes(name))
  if (enabled.length === 0) {
    ctx.logger?.info('agent-toolkit: 设置页把本 preset 的能力全部关掉了，不注册任何工具')
    return
  }
  // 一行审计日志：排查"这个 preset 到底挂了哪些能力"时先看宿主日志。
  ctx.logger?.info(`agent-toolkit: tools = ${enabled.join(', ')}${gate === undefined ? '' : '（已按设置页闸门过滤）'}`)
  // 工具名与出货工具撞车时的结论由**注册层**（tools/registry.js）显式决定，这里不再兜底：
  //   - 0.2.1-rc.2 实测契约：`register()` 把定义插进调用者 ctx 所属的 scope 层，**跨层重名不抛错**
  //     —— 本 scope 的同名注册只是**静默遮蔽**全局定义（dsh-tools 文件头："Scoped tools shadow globals"；
  //     `view()` 先铺全局层再按 scope 链覆盖）。所以旧版这里"吞掉重名错误"的 monkey-patch
  //     对出货撞名是**死代码**：真正发生的是 agentkit 静默覆盖了出货的 read/write/edit/read_image/pwsh。
  //   - 同一层内重名才会抛错（`tool "x" is already registered in this scope`），那是真 bug，
  //     应当原样抛出，不该被吞掉。
  // 覆盖/让出的判定与日志都在 tools/registry.js（DESIGNED_TAKEOVERS / YIELDED_NAMES），
  // 它每次撞名都会自己打日志，所以这里不再额外打一行摘要（test/load.test.mjs 断言恰好一行挂载日志）。
  for (const name of enabled) CAPABILITIES[name](ctx)
}
