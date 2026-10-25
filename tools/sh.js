/**
 * sh：用 bash 执行命令串——"模型最擅长、最不容易出错"的 shell，用来彻底替代 PowerShell。
 *
 * 为什么是 bash：模型对 POSIX shell 的语料远多于 PowerShell；管道、重定向、通配、
 * `&&`/`||` 这些写法几乎不会出错。本机 git 来自 MSYS2，`C:\msys64\usr\bin\bash.exe`
 * 可用，且 bash 内可直接调用 Windows 的 python / pip / git / tar / pandoc。
 *
 * 路径注意（写进工具描述，避免模型踩坑）：bash 里 Windows 路径是 `/c/a/...` 风格，
 * `C:\a\...` 中的反斜杠会被 bash 当转义处理。
 *
 * @module @local/dsh-doc-pipeline/sh
 */
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, execCapture } from '../lib/exec.js'
import { assertRemoteShellAllowed } from '../lib/shell-ban.js'
import { requireString } from '../lib/fs-common.js'
import { resolveCallCwd } from './cwd-arg.js'
import { createToolRegistrar } from './registry.js'

/** 只需要工具注册表。 */
export const inject = ['tools']

/** bash 候选路径，按顺序探测；`DSH_BASH` 可覆盖。 */
const BASH_CANDIDATES = [
  process.env.DSH_BASH,
  'C:\\msys64\\usr\\bin\\bash.exe',
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe'
].filter((candidate) => typeof candidate === 'string' && candidate.trim() !== '')

/**
 * 找到可用的 bash。
 * @param {object} ctx - 插件上下文。
 * @param {object} exec - 工具执行上下文。
 * @returns {Promise<string>} bash 可执行文件路径。
 */
async function resolveBash(ctx, exec) {
  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined) throw new Error('sh 需要 subprocess 服务，但当前组合没有挂载它')
  for (const candidate of [...BASH_CANDIDATES, 'bash', 'sh']) {
    try {
      return await subprocess.resolveExecutable(candidate, undefined, exec.signal)
    } catch {
      /* 试下一个候选 */
    }
  }
  throw new Error('找不到 bash。本工具用 bash 代替 PowerShell；请安装 Git for Windows 或 MSYS2，'
    + '或用环境变量 DSH_BASH 指定 bash.exe 的绝对路径。')
}

/**
 * 定义 sh。
 * @param {object} ctx - 插件上下文。
 * @returns {object} 工具定义。
 */
function shDefinition(ctx) {
  return {
    name: 'sh',
    description: '用 bash 执行一条命令（POSIX shell，非 PowerShell）。支持管道、重定向、通配、&&/||；'
      + 'bash 里 Windows 路径写作 /c/a/... 形式，python / pip / git / tar / pandoc 可直接调用。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        command: {
          type: 'string',
          description: '要执行的 bash 命令串，例如 `ls -la out | head -20`。'
            + '读写**文件内容**请用 read / write（编码与换行有兜底）；**检索**用 grep / glob；'
            + '这里留给管道串联、通配与调用程序。'
        },
        cwd: { type: 'string', description: '工作目录（宿主路径）；相对路径按当前会话工作目录解析（Windows 上也接受 `/c/...` 形式），必须存在且是目录；省略则用当前会话工作目录。' },
        timeout_ms: { type: 'number', description: `超时毫秒数，默认 ${DEFAULT_TIMEOUT_MS}，上限 ${MAX_TIMEOUT_MS}。` }
      },
      required: ['command']
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: { type: 'string' },
          exit_code: { type: 'integer' },
          signal: { type: 'string' },
          duration_ms: { type: 'integer' },
          timed_out: { type: 'boolean' },
          truncated: { type: 'boolean' },
          output: { type: 'string' }
        },
        required: ['command', 'exit_code', 'duration_ms', 'timed_out', 'truncated', 'output']
      },
      render: (_args, value) => [{
        type: 'text',
        text: `<bash exit="${value.exit_code}"${value.signal === undefined ? '' : ` signal="${value.signal}"`}${value.timed_out ? ' timed-out="true"' : ''} ms="${value.duration_ms}"/>\n${value.output === '' ? '(无输出)' : value.output}`
      }]
    },
    async execute(args, exec) {
      const command = requireString(args?.command, 'command')
      // 远程主机同样禁 powershell 5.1 / cmd：拦 ssh/plink 这类远程执行器调用被禁 shell
      assertRemoteShellAllowed(command, 'sh')
      const cwd = resolveCallCwd(ctx, exec, args?.cwd)
      const timeoutMs = args?.timeout_ms === undefined ? DEFAULT_TIMEOUT_MS : Number(args.timeout_ms)
      const bash = await resolveBash(ctx, exec)
      const result = await execCapture(ctx, exec, { argv: [bash, '-c', command], cwd, timeoutMs })
      return {
        command: command.length > 200 ? `${command.slice(0, 200)}…` : command,
        exit_code: result.exitCode,
        ...(result.signal === undefined ? {} : { signal: result.signal }),
        duration_ms: result.durationMs,
        timed_out: result.timedOut,
        truncated: result.truncated,
        output: result.output
      }
    },
    presentCall(args) {
      return { card: 'terminal', title: String(args.command).slice(0, 120), description: 'bash（非 PowerShell）' }
    }
  }
}

/**
 * 挂载 sh。
 * @param {object} ctx - preset 作用域的插件上下文。
 */
export function apply(ctx) {
  const register = createToolRegistrar(ctx)
  register(shDefinition(ctx))
}
