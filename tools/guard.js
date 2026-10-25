/**
 * 结构化 shell 禁令。
 *
 * 禁的是 **Windows PowerShell 5.1（`powershell.exe`）、cmd 与终端控制类工具**：
 * 它们的引号解析、编码（GBK 控制台）与错误处理不可控。
 * 放行的是 **`pwsh`（PowerShell 7）** 与 **`sh`（bash）**——这两个是本工具集自己的工具。
 *
 * 关于"接管内置读写"：本工具集的写工具**直接使用内置的工具名** `read` / `write` / `edit`
 * （参数也用 `file_path`），所以接管是**按名字天然完成**的：
 *   - 同一层里再挂出货的 `@deepseek-ai/dsh-tool-fs` → 同名注册直接失败（fail loud，不会出现两条写路径）；
 *   - 若出货的 `read`/`write`/`edit` 挂在更外层的全局层 → 本插件的同名声明显蔽它（scoped shadows global）。
 * 因此这里**不再需要**用 guard 去拒绝 write/edit —— 那反而会把自家的工具拦掉
 * （load 测试里有专门的断言防这个回归）。
 *
 * guard 是单调的：注册之后任何调用都会在 pre-execute 之后被拒绝，别的插件放开不了。
 * 注册在**每个 agent 自己的 `agent.ctx`** 上，因此只作用于本 preset 的会话，
 * 不会把 cordis / standard 等模式一起禁掉。
 *
 * @module @local/dsh-agent-toolkit/guard
 */

/** 只依赖工具注册表。 */
export const inject = ['tools']

/**
 * 一律拒绝的**工具名**。
 * 注意：这里绝不能出现本工具集自己的工具名（`sh` / `pwsh` / `read` / `write` / `edit` / …），
 * 否则 guard 会把自己家的工具也拦掉——load 测试里有专门的断言防这个回归。
 */
export const BANNED_TOOL_NAMES = [
  'powershell',
  'powershell_ise',
  'cmd',
  'cmd.exe',
  'shell',
  'bash',
  'terminal',
  'terminal_open',
  'terminal_write',
  'terminal_signal'
]

/** 拒绝时给模型的可执行建议。 */
const REASON = '本 agent 禁用 Windows PowerShell 5.1 与 cmd（引号、编码与错误处理不可控）。'
  + '请改用 sh（bash，POSIX）、pwsh（PowerShell 7，UTF-8）或 run（argv 直连，不需要引号转义）。'

/**
 * 判断一个工具名是否应被拒绝（纯函数，便于自测）。
 * @param {string} name - 工具名。
 * @returns {string|undefined} 拒绝理由；undefined 表示放行。
 */
export function denyReasonFor(name) {
  return BANNED_TOOL_NAMES.includes(name) ? REASON : undefined
}

/**
 * 挂载 shell 禁令。
 * @param {object} ctx - preset 作用域的插件上下文。
 */
export function apply(ctx) {
  const disposers = new Map()

  // 插件卸载时清掉所有按 agent 注册的 guard。
  ctx.effect(() => () => {
    for (const dispose of disposers.values()) dispose()
    disposers.clear()
  }, 'agent-toolkit:ban-shell:cleanup')

  ctx.on('agent/created', ({ agent }) => {
    // `agent/created` 监听器抛错会让会话创建失败，所以这里任何意外都必须吞掉：
    // 禁令是加固手段，不是创建会话的前提条件。
    try {
      const agentCtx = agent?.ctx
      if (agentCtx?.tools === undefined) return
      const dispose = agentCtx.effect(
        () => agentCtx.tools.guard((exec) => denyReasonFor(exec.name)),
        'agent-toolkit:ban-shell'
      )
      disposers.set(agent, dispose)
    } catch {
      /* 注册失败时退化为"只靠不挂载这些工具" */
    }
  })
}
