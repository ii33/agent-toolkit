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
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, execCapture, execStreaming } from '../lib/exec.js'
import { startAsJob } from '../lib/job-adopt.js'
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
        timeout_ms: { type: 'number', description: `超时毫秒数。默认 ${DEFAULT_TIMEOUT_MS / 1000} 秒，**最大 ${MAX_TIMEOUT_MS / 1000} 秒（${MAX_TIMEOUT_MS / 60000} 分钟）**，超过会被拒绝。要跑更久请用 run_in_background: true。` },
        run_in_background: {
          type: 'boolean',
          description: '不阻塞会话：程序转成后台作业立即返回作业 id（不用等它跑完）。'
            + '拿到 id 后用 job_output 增量读输出、job_list 看状态、job_kill 终止。'
            + '适合训练、全量转码、大批量处理等明知很慢的操作。默认 false（同步等结果）。'
        }
      },
      required: ['program']
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          program: { type: 'string' },
          // run_in_background: true 时进程还在跑，没有退出码
          exit_code: { type: 'integer' },
          signal: { type: 'string' },
          duration_ms: { type: 'integer' },
          timed_out: { type: 'boolean' },
          truncated: { type: 'boolean' },
          job_id: { type: 'string', description: '仅后台模式：用 job_output / job_kill 操作这个作业' },
          background: { type: 'boolean' },
          output: { type: 'string' }
        },
        required: ['program', 'duration_ms', 'timed_out', 'truncated', 'output']
      },
      render: (_args, value) => {
        if (value.background === true) {
          return [{
            type: 'text',
            text: `<run program="${value.program}" background job="${value.job_id}"/>\n已在后台运行：${value.output}\n用 job_output（传 job_id: "${value.job_id}"）增量读输出。`
          }]
        }
        return [{
          type: 'text',
          text: `<run program="${value.program}" exit="${value.exit_code}"${value.signal === undefined ? '' : ` signal="${value.signal}"`}${value.timed_out ? ' timed-out="true"' : ''} ms="${value.duration_ms}"/>\n${value.output === '' ? '(无输出)' : value.output}`
        }]
      }
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

      // 后台模式：启动后立刻返回，不阻塞会话（审批已在上面完成）
      if (args?.run_in_background === true) {
        const label = `${program} ${argv.join(' ')}`.slice(0, 120)
        const job = startAsJob(ctx, exec, {
          label,
          run: (emit) => execStreaming(ctx, exec, { argv: [executable, ...argv], cwd, onOutput: emit })
        })
        if (job !== undefined) {
          return {
            program,
            background: true,
            job_id: job.id,
            duration_ms: 0,
            timed_out: false,
            truncated: false,
            output: label
          }
        }
        // 没有 jobs 服务就退回同步执行，功能不缺失
      }

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
