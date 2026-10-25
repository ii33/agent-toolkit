/**
 * pwsh：用 **PowerShell 7（pwsh）** 执行脚本——Windows 上的原生 shell，
 * 但严格避开被禁用的 Windows PowerShell 5.1（`powershell.exe`）。
 *
 * 与 `sh`（bash）的分工：
 *   - 纯 POSIX 风格、管道/通配/文本处理 → `sh`（模型语料最多，最不容易出错）；
 *   - 需要 Windows 原生能力（注册表、WMI/CIM、Windows 服务、COM、路径与 ACL）→ `pwsh`。
 *
 * 关键处理（让"编码问题不上升到模型"）：
 *   - 强制 UTF-8 控制台输出（`[Console]::OutputEncoding` + `$OutputEncoding`）；
 *   - `-NoProfile -NonInteractive`：不读用户 profile、不等待交互；
 *   - 关掉进度条与遥测噪声；输出仍由本工具自行解码（UTF-8 → GBK 回退）。
 *
 * @module @local/dsh-agent-toolkit/pwsh
 */
import { accessSync, constants } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, execCapture } from '../lib/exec.js'
import { assertRemoteShellAllowed } from '../lib/shell-ban.js'
import { cwdFor, requireString } from '../lib/fs-common.js'
import { resolveCallCwd } from './cwd-arg.js'
import { createToolRegistrar } from './registry.js'

/** 只需要工具注册表。 */
export const inject = ['tools']

/** 脚本前缀：统一输出编码、压掉进度条噪声。 */
const PREAMBLE = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;'
  + '$OutputEncoding=[System.Text.Encoding]::UTF8;'
  + '$ProgressPreference="SilentlyContinue";'

/** 已确认可运行的 pwsh（进程级缓存）。 */
let resolvedPwsh

/**
 * PATH 扫描 + 常见安装位置的候选。
 *
 * 为什么不能只用 `stat(候选).isFile()`：Windows Store 版 pwsh 只装了 **app-execution 别名**
 * （`…\WindowsApps\Microsoft.PowerShellPreview_*\pwsh.exe`），它是指向受 ACL 保护的包目录的
 * reparse point：实测 `stat()` → `EACCES`、`realpath()` → `EACCES`，而 `lstat()` 是 symlink、
 * `access(X_OK)` 是 ok。用 stat 判定就会把"装了且能跑"误判成"没装"。
 * 这里只列 pwsh；被禁的 `powershell.exe`（5.1）永远不在候选里。
 * @returns {string[]} 候选路径。
 */
function pwshPathCandidates() {
  const candidates = []
  const directories = (process.env.PATH ?? '').split(delimiter).filter((entry) => entry.trim() !== '')
  for (const directory of directories) candidates.push(join(directory, 'pwsh.exe'))
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
  candidates.push(join(programFiles, 'PowerShell', '7', 'pwsh.exe'))
  if (typeof process.env.LOCALAPPDATA === 'string' && process.env.LOCALAPPDATA !== '') {
    candidates.push(join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'pwsh.exe'))
  }
  return [...new Set(candidates)]
}

/** 候选是否"存在且可直接执行"（用 access 而不是 stat，见 {@link pwshPathCandidates}）。 */
function acceptsRun(candidate) {
  try {
    accessSync(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** 探针的工作目录：没有会话上下文时退回可执行文件所在目录（**不用 process.cwd()**：宿主进程 cwd 可能不可用）。 */
function probeCwd(ctx, exec, candidate) {
  try {
    return cwdFor(ctx, exec)
  } catch {
    return dirname(candidate)
  }
}

/**
 * 真的跑一次并确认是 PowerShell 7（只放行 7.x 以上）。
 * @param {object} ctx - 插件上下文。
 * @param {object} exec - 工具执行上下文。
 * @param {string} candidate - 候选可执行文件。
 * @returns {Promise<string|undefined>} 主版本号文本；不能跑或不是 7.x 时 undefined。
 */
async function probePwsh(ctx, exec, candidate) {
  try {
    const probe = await execCapture(ctx, exec, {
      argv: [candidate, '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'],
      cwd: probeCwd(ctx, exec, candidate),
      timeoutMs: 30_000
    })
    if (probe.exitCode !== 0) return undefined
    const major = (probe.output.trim().split('\n').pop() ?? '').trim()
    return /^[7-9]\d*$/u.test(major) ? major : undefined
  } catch {
    return undefined
  }
}

/**
 * 找 pwsh（PowerShell 7）：环境变量与服务解析优先，失败后做一次 PATH/常见位置扫描
 * 并用真实探针确认（缓存）。
 * @param {object} ctx - 插件上下文。
 * @param {object} exec - 工具执行上下文。
 * @returns {Promise<string>} pwsh 可执行文件路径。
 */
async function resolvePwsh(ctx, exec) {
  if (resolvedPwsh !== undefined) return resolvedPwsh
  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined) throw new Error('pwsh 需要 subprocess 服务，但当前组合没有挂载它')
  for (const candidate of [process.env.DSH_PWSH, process.env.DSH_AGENTKIT_PWSH, 'pwsh', 'pwsh.exe']
    .filter((entry) => typeof entry === 'string' && entry !== '')) {
    try {
      const resolved = await subprocess.resolveExecutable(candidate, undefined, exec.signal)
      if (typeof resolved === 'string') {
        resolvedPwsh = resolved
        return resolved
      }
    } catch {
      /* 试下一个候选 */
    }
  }
  // 服务解析会在这类别名上失败（stat → EACCES），这里换成 access + 真实探针。
  for (const candidate of pwshPathCandidates()) {
    if (!acceptsRun(candidate)) continue
    const major = await probePwsh(ctx, exec, candidate)
    if (major === undefined) continue
    resolvedPwsh = candidate
    ctx.logger?.info(`agentkit: pwsh 用 ${candidate}（PowerShell ${major}）`)
    return candidate
  }
  throw new Error('找不到可用的 pwsh（PowerShell 7）。本 agent 禁用 Windows PowerShell 5.1（powershell.exe）；'
    + '请安装 PowerShell 7，或用环境变量 DSH_PWSH 指定 pwsh 的绝对路径，或改用 sh（bash）。')
}

/**
 * 定义 pwsh。
 * @param {object} ctx - 插件上下文。
 * @returns {object} 工具定义。
 */
function pwshDefinition(ctx) {
  return {
    name: 'pwsh',
    description: '用 PowerShell 7（pwsh）执行脚本，输出强制 UTF-8。适合 Windows 原生操作（注册表、服务、CIM、ACL）；'
      + '纯文本/管道处理优先用 sh（bash）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        script: { type: 'string', description: '要执行的 PowerShell 脚本（不需要外层引号转义）。' },
        cwd: { type: 'string', description: '工作目录（宿主路径）；相对路径按当前会话工作目录解析（Windows 上也接受 `/c/...` 形式），必须存在且是目录；省略则用当前会话工作目录。' },
        timeout_ms: { type: 'number', description: `超时毫秒数，默认 ${DEFAULT_TIMEOUT_MS}，上限 ${MAX_TIMEOUT_MS}。` }
      },
      required: ['script']
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          script: { type: 'string' },
          exit_code: { type: 'integer' },
          duration_ms: { type: 'integer' },
          timed_out: { type: 'boolean' },
          truncated: { type: 'boolean' },
          output: { type: 'string' }
        },
        required: ['script', 'exit_code', 'duration_ms', 'timed_out', 'truncated', 'output']
      },
      render: (_args, value) => [{
        type: 'text',
        text: `<pwsh exit="${value.exit_code}"${value.timed_out ? ' timed-out="true"' : ''} ms="${value.duration_ms}"/>\n${value.output === '' ? '(无输出)' : value.output}`
      }]
    },
    async execute(args, exec) {
      const script = requireString(args?.script, 'script')
      const cwd = resolveCallCwd(ctx, exec, args?.cwd)
      const timeoutMs = args?.timeout_ms === undefined ? DEFAULT_TIMEOUT_MS : Number(args.timeout_ms)
      // 远程主机同样禁 powershell 5.1 / cmd（本工具是 pwsh 7，但脚本里可能去调 ssh + cmd）
      assertRemoteShellAllowed(script, 'pwsh')
      const pwsh = await resolvePwsh(ctx, exec)
      const result = await execCapture(ctx, exec, {
        argv: [pwsh, '-NoProfile', '-NonInteractive', '-Command', `${PREAMBLE}${script}`],
        cwd,
        timeoutMs,
        env: { POWERSHELL_TELEMETRY_OPTOUT: '1', POWERSHELL_UPDATECHECK: 'Off' }
      })
      return {
        script: script.length > 200 ? `${script.slice(0, 200)}…` : script,
        exit_code: result.exitCode,
        duration_ms: result.durationMs,
        timed_out: result.timedOut,
        truncated: result.truncated,
        output: result.output
      }
    },
    presentCall(args) {
      return { card: 'terminal', title: String(args.script).slice(0, 120), description: 'pwsh (PowerShell 7)' }
    }
  }
}

/**
 * 挂载 pwsh。
 * @param {object} ctx - preset 作用域的插件上下文。
 */
export function apply(ctx) {
  const register = createToolRegistrar(ctx)
  register(pwshDefinition(ctx))
}
