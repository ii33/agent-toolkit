/**
 * shell 禁令：**本地与远程主机都禁 Windows PowerShell 5.1 与 cmd**（放行 pwsh / sh / bash）。
 *
 * 两道检查：
 *   1. `localShellBanReason`：**命令位置**检查 —— 把命令行按 `; & | 换行` 切开，看每段的
 *      首个词（可跳过 `FOO=bar` 赋值、`sudo`/`env` 之类前缀，以及路径前缀）是不是被禁 shell。
 *      于是 `powershell -c …`、`cmd /c dir`、`C:\Windows\…\powershell.exe` 都会被拒，
 *      而 `grep -i powershell log.txt`、`echo powershell` 不会误伤。
 *   2. `remoteShellBanReason`：**远程执行器**检查 —— `ssh` / `plink` / `psexec` / `winrs` /
 *      `wmic` 等把命令送到远程主机时，命令里出现被禁 shell 也拒。
 *      （SFTP 侧车只读写文件、不执行命令 ✓，所以远程侧没有第二条执行路径。）
 *
 * 这是**文本级**检查，宁可误伤也不放过；拒绝信息里写清了替代做法，模型可直接改写。
 *
 * @module @local/dsh-agentkit/shell-ban
 */

/** 被禁的 shell（与本地 guard 的名单一致；.exe 后缀在比较时会被去掉）。 */
export const BANNED_SHELL_TOKENS = ['powershell', 'cmd']

/** 能"在远程主机上执行命令"的执行器。 */
export const REMOTE_EXECUTORS = ['ssh', 'plink', 'sshpass', 'psexec', 'winrs', 'wmic']

/** 可以出现在命令位置但会"再执行下一个词"的前缀，检查时跳过。 */
const LAUNCHERS = ['sudo', 'env', 'time', 'nohup', 'nice', 'setsid', 'xargs', 'command', 'exec', 'start', 'call']

/** 词边界（前后都不允许是标识符字符）。 */
const LEFT = '(^|[\\s;&|"\'(`/\\\\])'
const RIGHT = '([\\s;&|"\')]|$)'

/**
 * 拒绝话术，按场景分开写。
 *
 * 早先本地与远程共用一段，里面带着"跨主机传文件用 SFTP"——本地命令位置写了个 `cmd`
 * 时这句完全不搭界，是无用的噪声，只会淹没真正的修复指引。
 */
const BAN_CORE = '禁用 Windows PowerShell 5.1 与 cmd。'
/** 本地场景：只说要换成什么，不提跨主机。 */
const LOCAL_REASON = `${BAN_CORE}请改用 pwsh（PowerShell 7）或 sh（bash）。`
/** 远程场景：跨主机执行时才提 SFTP。 */
const REMOTE_REASON = `${BAN_CORE}远程主机同样适用，请改用 pwsh（PowerShell 7）或 sh（bash）。`

/**
 * 取一个词的可执行名（去掉引号、目录前缀、.exe 后缀，转小写）。
 * @param {string} token - 词。
 * @returns {string} 可执行名。
 */
function executableName(token) {
  const bare = String(token ?? '').replace(/^["']|["']$/gu, '').split(/[\\/]/u).pop() ?? ''
  return bare.toLowerCase().replace(/\.exe$/u, '')
}

/**
 * 去掉成对的引号内容（单引号 / 双引号 / PowerShell 反引号）。
 *
 * 为什么必须先去掉：检查原本是纯文本扫描，按 `; & | 换行` 切段再取每段首个词。
 * 它**不理解引号**，于是字符串或正则里的分隔符会被当成命令边界：
 *
 *   Write-Output "a; cmd /c b"    → 切成 `cmd /c b"` → 误判"命令位置出现 cmd"
 *   $re = 'cmd|powershell'        → 切成 `powershell'` → 误判
 *
 * 实测：这会把注释、字符串常量、正则里的字样全部拒掉，用户只能靠拼字符串绕开。
 * 引号里的是数据，不是要执行的命令，应当剔除后再判断命令位置。
 *
 * @param {string} text - 原始文本。
 * @returns {string} 引号内容被替换成空格后的文本（保持分隔符位置不变）。
 */
function stripQuoted(text) {
  return String(text ?? '')
    .replace(/'(?:[^']|'')*'/gu, ' ')
    .replace(/"(?:[^"]|"")*"/gu, ' ')
    .replace(/`[^`]*`/gu, ' ')
}

/**
 * 命令位置检查：每段的首个词是不是被禁 shell。
 *
 * 只用于**真正的命令行**（`sh` 的 command、`run` 的 program）。
 * PowerShell 脚本不是命令行，不该走这里 —— 见 {@link assertRemoteShellAllowed}。
 *
 * @param {string|string[]} text - 命令行文本或 argv 数组。
 * @returns {string|undefined} 拒绝理由；undefined 表示放行。
 */
export function localShellBanReason(text) {
  const raw = Array.isArray(text) ? text.join(' ') : String(text ?? '')
  if (raw.trim() === '') return undefined
  const value = stripQuoted(raw)
  for (const segment of value.split(/[;&|\n]+/u)) {
    const tokens = segment.trim().replace(/^[("']+/u, '').split(/\s+/u).filter((item) => item !== '')
    let index = 0
    while (index < tokens.length && index < 3) {
      const token = tokens[index]
      if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(token) || LAUNCHERS.includes(executableName(token))) {
        index += 1
        continue
      }
      break
    }
    const name = executableName(tokens[index] ?? '')
    if (BANNED_SHELL_TOKENS.includes(name)) {
      return `命令位置出现被禁 shell "${tokens[index]}"：本地${LOCAL_REASON}`
    }
  }
  return undefined
}

/**
 * 远程执行器检查：`ssh` 等把命令送到远程主机时，命令里出现被禁 shell。
 * @param {string|string[]} text - 命令行文本或 argv 数组。
 * @returns {string|undefined} 拒绝理由；undefined 表示放行。
 */
export function remoteShellBanReason(text) {
  const value = Array.isArray(text) ? text.join(' ') : String(text ?? '')
  if (value.trim() === '') return undefined
  const lower = value.toLowerCase()
  const executor = REMOTE_EXECUTORS.find((name) => new RegExp(`${LEFT}${name}${RIGHT}`, 'u').test(lower))
  if (executor === undefined) return undefined
  const banned = BANNED_SHELL_TOKENS.find((token) => new RegExp(`${LEFT}${token}(\\.exe)?${RIGHT}`, 'u').test(lower))
  if (banned === undefined) return undefined
  return `检测到用 ${executor} 在远程主机上调用 ${banned}：${REMOTE_REASON}`
}

/**
 * 本地 + 远程两道检查。
 * @param {string|string[]} text - 命令行文本或 argv 数组。
 * @returns {string|undefined} 拒绝理由；undefined 表示放行。
 */
export function shellBanReason(text) {
  return localShellBanReason(text) ?? remoteShellBanReason(text)
}

/**
 * 需要时直接抛错（工具在执行前调用）。
 * @param {string|string[]} text - 命令行文本或 argv 数组。
 * @param {string} toolName - 工具名（进错误信息）。
 */
export function assertShellAllowed(text, toolName) {
  const reason = shellBanReason(text)
  if (reason !== undefined) throw new Error(`${toolName}: ${reason}`)
}

/**
 * 只做远程检查：拦 `ssh host cmd ...` 这类"把被禁 shell 送到远程主机"的写法。
 *
 * **不要在这里做本地命令位置检查。** 早先它是 `assertShellAllowed` 的别名
 * （本地+远程都查），而 `pwsh` 把整段脚本传了进来 —— 脚本不是命令行，
 * 于是字符串与正则里的 `; cmd` / `| powershell` 被当成命令边界，
 * 注释、常量、正则全被判违规（实测：用户只能拼字符串、把脚本落盘再用 -File 绕开）。
 *
 * @param {string|string[]} text - 命令行文本或 argv 数组。
 * @param {string} toolName - 工具名。
 */
export function assertRemoteShellAllowed(text, toolName) {
  const value = Array.isArray(text) ? text.join(' ') : String(text ?? '')
  const reason = remoteShellBanReason(value)
  if (reason !== undefined) throw new Error(`${toolName}: ${reason}`)
}
