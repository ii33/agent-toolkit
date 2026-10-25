/**
 * run：以 argv 直接执行外部程序，不经过任何 shell。
 *
 * 效率优先（按用户要求）：
 *   - 默认**不要求审批**，任何程序都能跑；`REQUIRE_APPROVAL = true` 可恢复审批模式；
 *   - 参数逐项传入，不需要引号/转义，因此没有 Windows 上那类引号地狱；
 *   - 子进程环境注入 pip 镜像与 UTF-8 编码变量，python/pip 自动加速且不乱码。
 *
 * 需要 shell 语法（管道、重定向、通配）时用 `sh`（bash），不要用 PowerShell。
 *
 * @module @local/dsh-doc-pipeline/run
 */
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, execCapture } from '../lib/exec.js'
import { assertRemoteShellAllowed } from '../lib/shell-ban.js'
import { requireString } from '../lib/fs-common.js'
import { resolveCallCwd } from './cwd-arg.js'
import { createToolRegistrar } from './registry.js'

/** 只需要工具注册表；subprocess 在调用时按需获取。 */
export const inject = ['tools']

/** 是否对"未列入偏好名单"的程序要求审批。效率优先，默认关闭。 */
const REQUIRE_APPROVAL = false

/** 偏好名单：仅用于审批模式与文档说明（这些是流水线常用程序）。 */
const PREFERRED = [
  'git', 'node', 'npm', 'pnpm', 'python', 'python3', 'py', 'pip', 'pip3',
  'docling', 'pandoc', 'tar', '7z', 'qpdf', 'pdftoppm', 'magick', 'soffice',
  'ffmpeg', 'bash', 'wsl', 'curl', 'rg', 'fd', 'uv'
]

/**
 * 校验参数数组。
 * @param {unknown} value - 原始 args。
 * @returns {string[]} 校验后的参数数组。
 */
function requireArgs(value) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('args 必须是字符串数组')
  return value.map((item, index) => {
    if (typeof item !== 'string') throw new Error(`args[${index}] 必须是字符串`)
    if (item.includes('\u0000')) throw new Error(`args[${index}] 含 NUL 字节，拒绝执行`)
    return item
  })
}

/**
 * 定义 run。
 * @param {object} ctx - 插件上下文。
 * @returns {object} 工具定义。
 */
function runDefinition(ctx) {
  return {
    name: 'run',
    description: '以 argv 直接运行外部程序（不经过任何 shell），返回退出码与合并输出。'
      + '探测程序与版本（`which` / `--version`）、列已装包（`npm ls -g` / `pip list`）也用它；'
      + '需要管道/重定向/通配时才用 sh。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        program: { type: 'string', description: '程序名或绝对路径，如 `python`、`docling`、`tar`、`pandoc`。' },
        args: { type: 'array', items: { type: 'string' }, description: '参数数组，逐项传入，不需要任何引号或转义。' },
        cwd: { type: 'string', description: '工作目录；相对路径按当前会话工作目录解析（Windows 上也接受 `/c/...` 形式），必须存在且是目录；省略则用当前会话工作目录。' },
        timeout_ms: { type: 'number', description: `超时毫秒数，默认 ${DEFAULT_TIMEOUT_MS}，上限 ${MAX_TIMEOUT_MS}。` }
      },
      required: ['program']
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          program: { type: 'string' },
          exit_code: { type: 'integer' },
          signal: { type: 'string' },
          duration_ms: { type: 'integer' },
          timed_out: { type: 'boolean' },
          truncated: { type: 'boolean' },
          output: { type: 'string' }
        },
        required: ['program', 'exit_code', 'duration_ms', 'timed_out', 'truncated', 'output']
      },
      render: (_args, value) => [{
        type: 'text',
        text: `<run program="${value.program}" exit="${value.exit_code}"${value.signal === undefined ? '' : ` signal="${value.signal}"`}${value.timed_out ? ' timed-out="true"' : ''} ms="${value.duration_ms}"/>\n${value.output === '' ? '(无输出)' : value.output}`
      }]
    },
    async execute(args, exec) {
      const program = requireString(args?.program, 'program')
      const argv = requireArgs(args?.args)
      const cwd = resolveCallCwd(ctx, exec, args?.cwd)
      const timeoutMs = args?.timeout_ms === undefined ? DEFAULT_TIMEOUT_MS : Number(args.timeout_ms)
      // 远程主机同样禁 powershell 5.1 / cmd：拦 ssh/plink 这类远程执行器调用被禁 shell
      assertRemoteShellAllowed([program, ...argv], 'run')

      if (REQUIRE_APPROVAL && !PREFERRED.includes(program.toLowerCase().replace(/\.exe$/u, ''))) {
        const approval = ctx.get('approval')
        if (exec.agent === undefined || approval === undefined) {
          throw new Error(`"${program}" 不在偏好名单内，且当前没有可用的审批通道`)
        }
        const command = `${program} ${argv.join(' ')}`.slice(0, 200)
        const outcome = await approval.request({
          agent: exec.agent,
          toolName: 'run',
          ...(exec.callId === undefined ? {} : { callId: exec.callId }),
          reason: `执行外部程序：${command}`,
          displayReason: { en: `Run external program: ${command}`, zh: `执行外部程序：${command}` },
          signal: exec.signal
        })
        if (outcome !== 'allowed-once') throw new Error(`未获批准执行 ${program}（${outcome}）`)
      }

      const subprocess = ctx.get('subprocess')
      if (subprocess === undefined) throw new Error('run 需要 subprocess 服务，但当前组合没有挂载它')
      const executable = await subprocess.resolveExecutable(program, undefined, exec.signal)
      const result = await execCapture(ctx, exec, { argv: [executable, ...argv], cwd, timeoutMs })
      return {
        program,
        exit_code: result.exitCode,
        ...(result.signal === undefined ? {} : { signal: result.signal }),
        duration_ms: result.durationMs,
        timed_out: result.timedOut,
        truncated: result.truncated,
        output: result.output
      }
    },
    presentCall(args) {
      return {
        card: 'terminal',
        title: `${args.program} ${(args.args ?? []).join(' ')}`.slice(0, 120),
        description: 'argv 直连，无 shell'
      }
    }
  }
}

/**
 * 挂载 run。
 * @param {object} ctx - preset 作用域的插件上下文。
 */
export function apply(ctx) {
  const register = createToolRegistrar(ctx)
  register(runDefinition(ctx))
}
