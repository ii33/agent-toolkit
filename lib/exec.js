/**
 * 子进程执行核心：run / sh / env_setup / ocr_doc / pack 共用。
 *
 * 负责四件容易出错的事，让每个工具不必重复：
 *   1. 一律 argv 直连（不经过任何 shell）；
 *   2. 排空 stdout/stderr 并按上限保留，避免子进程被管道阻塞；
 *   3. 输出自行解码（UTF-8 → GBK/Big5 回退），中文程序不再乱码；
 *   4. 超时 + 取消联动，超时终止进程树。
 *
 * 环境变量里注入编码与 pip 镜像，因此任何 python/pip 调用都自动加速。
 *
 * @module @local/dsh-doc-pipeline/exec
 */
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute } from 'node:path'
import { decodeText } from './encoding.js'
import { DEFAULT_PIP_INDEX_URL } from './argv.js'
import { runtimeEnvVars } from './settings.js'

/**
 * 一个**保证存在**的工作目录：按顺序取第一个真实存在的目录，最后落到 home。
 *
 * 为什么不能直接用 `process.cwd()`：Desktop 宿主里进程工作目录可能指向一个已被删除的目录，
 * 这时 `process.cwd()` **不会抛错**，只是每次 spawn 都以 ENOENT 失败 —— 探针会**静默失效**：
 * `pythonPathStyle` 探不出 posix 世界（argv 路径不再转换，`can't open file '/c/…/D:\…'` 回归），
 * `resolvePython` 退回 `candidates[0]`（"必须有 asyncssh/PIL"的保证消失）。
 * 所以每个探针的 cwd 都要**验证过存在**再交给 spawn。
 * @param {...(string|undefined)} candidates - 候选目录（调用方负责传目录，不是文件）。
 * @returns {string} 存在的目录路径。
 */
export function usableCwd(...candidates) {
  const isDirectory = (value) => {
    try {
      return existsSync(value) && statSync(value).isDirectory()
    } catch {
      return false
    }
  }
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '' && isDirectory(candidate)) return candidate
  }
  try {
    const cwd = process.cwd()
    if (isDirectory(cwd)) return cwd
  } catch {
    /* 取不到就落到 home */
  }
  return homedir()
}

/** pip 镜像地址，可用环境变量覆盖。 */
export const PIP_INDEX_URL = process.env.DSH_PIP_INDEX_URL ?? DEFAULT_PIP_INDEX_URL

/** 每个流最多缓冲的原始字节（超出后继续排空但丢弃）。 */
const MAX_STREAM_BYTES = 2 * 1024 * 1024

/** 回给模型的输出上限。 */
const MODEL_HEAD_CHARS = 4000
const MODEL_TAIL_CHARS = 1000

/** 默认与最长执行时间。 */
export const DEFAULT_TIMEOUT_MS = 120_000
export const MAX_TIMEOUT_MS = 600_000

/**
 * 子进程环境：编码统一 + 镜像加速（pip/npm）+ 关掉颜色噪声 + 运行期探测出的代理。
 *
 * 运行期环境由 `lib/proxy.js` 的 `ensureRuntimeEnv()` 写入（含 HTTP(S)_PROXY 与镜像），
 * 放在最后合并，因此设置文件里的值优先于这里的默认值。
 * @param {Record<string, string>} [extra] - 额外覆盖项。
 * @returns {Record<string, string|undefined>} 完整环境。
 */
export function subprocessEnv(extra = {}) {
  const host = (() => {
    try {
      return new URL(PIP_INDEX_URL).host
    } catch {
      return undefined
    }
  })()
  return {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    PYTHONLEGACYWINDOWSSTDIO: '0',
    NO_COLOR: '1',
    TERM: 'dumb',
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    PIP_INDEX_URL,
    ...(host === undefined ? {} : { PIP_TRUSTED_HOST: host }),
    ...runtimeEnvVars(),
    ...extra
  }
}

/**
 * 每个 python 可执行文件对应的路径风格缓存（可执行文件路径 → 'posix' | 'windows'）。
 *
 * 为什么需要：Windows 上 PATH 里的 `python` 常常是 MSYS2/Cygwin 的
 * `C:\msys64\usr\bin\python.exe`。这种 python **不做 argv 的 Windows 路径转换**，
 * 收到 `D:\x\y.py` 会当成相对路径（拼在当前工作目录后面），于是报
 * `python: can't open file '/c/.../D:\x\y.py'` —— 按原字符集写回（GBK/UTF-16）
 * 和 SFTP 侧车都会因此失效。给它的脚本路径必须是 POSIX 形式 `/d/x/y.py`
 * （实测 MSYS2 python 3.12 接受；原生 Windows python 不接受，只认 Windows 形式），
 * 所以先探测一次 python 属于哪种世界，再决定路径写法。
 */
const pythonPathStyles = new Map()

/**
 * 探测一个 python 可执行文件属于哪种路径风格（成功探测后按可执行文件缓存）。
 * @param {object} ctx - 插件上下文（需要 subprocess 服务）。
 * @param {object} exec - 工具执行上下文（提供 signal）。
 * @param {string} python - 已解析的 python 可执行文件路径。
 * @returns {Promise<'posix'|'windows'>} 路径风格；探测失败按 'windows'（原生 python 的默认）。
 */
export async function pythonPathStyle(ctx, exec, python) {
  const cached = pythonPathStyles.get(python)
  if (cached !== undefined) return cached
  let style = 'windows'
  try {
    const probe = await execCapture(ctx, exec, {
      argv: [python, '-c', 'import sys;print(sys.platform)'],
      // cwd 必须**保证存在**：process.cwd() 指向已删除目录时不会抛错，只会让 spawn ENOENT，
      // 于是这里探不出 posix 世界 → argv 路径不转换 → `can't open file '/c/…/D:\…'` 回归。
      // 解释器自己的目录必然存在（候选都是绝对路径），再兜到经过验证的 process.cwd() / home。
      cwd: usableCwd(typeof python === 'string' && isAbsolute(python) ? dirname(python) : undefined),
      timeoutMs: 20_000
    })
    if (probe.exitCode === 0) {
      style = /cygwin|msys|mingw/iu.test(probe.stdout) ? 'posix' : 'windows'
      pythonPathStyles.set(python, style)
    }
  } catch {
    /* 探测不了就按 Windows 形式走（原生 python 的默认，也是本插件历史的写法） */
  }
  return style
}

/**
 * 把 Windows 绝对路径转成该风格 python 能打开的 argv 形式。
 * 非 Windows 绝对路径（含远程 POSIX 路径）原样返回，因此对 `--root /volume1` 这类值是安全的。
 * @param {string} path - 绝对路径。
 * @param {'posix'|'windows'} style - pythonPathStyle 的结果。
 * @returns {string} 可直接放进 argv 的路径。
 */
export function pythonPathArg(path, style) {
  if (style !== 'posix') return path
  const drive = /^([A-Za-z]):[\\/](.*)$/su.exec(path)
  if (drive !== null) return `/${drive[1].toLowerCase()}/${drive[2].replace(/\\/gu, '/')}`
  if (path.startsWith('\\\\')) return `//${path.slice(2).replace(/\\/gu, '/')}`
  return path
}

/**
 * 排空一个流并保留前 cap 字节。
 * @param {import('node:stream').Readable|undefined} stream - 子进程流。
 * @param {number} cap - 保留上限。
 * @returns {Promise<{bytes: Buffer, overflow: boolean}>} 原始字节与是否溢出。
 */
async function drain(stream, cap) {
  if (stream === undefined) return { bytes: Buffer.alloc(0), overflow: false }
  const chunks = []
  let total = 0
  let overflow = false
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (total >= cap) {
      overflow = true
      continue
    }
    chunks.push(buffer)
    total += buffer.length
  }
  return { bytes: Buffer.concat(chunks), overflow }
}

/**
 * 解码并按 head/tail 截断。
 * @param {{bytes: Buffer, overflow: boolean}} collected - 排空结果。
 * @returns {{text: string, truncated: boolean}} 模型可见文本。
 */
function render(collected) {
  if (collected.bytes.length === 0) return { text: '', truncated: false }
  const decoded = decodeText(new Uint8Array(collected.bytes))
  const text = decoded.text.replace(/\r\n/g, '\n').trimEnd()
  const tooLong = collected.overflow || text.length > MODEL_HEAD_CHARS + MODEL_TAIL_CHARS
  if (!tooLong) return { text, truncated: false }
  const head = text.slice(0, MODEL_HEAD_CHARS)
  const tail = text.slice(-MODEL_TAIL_CHARS)
  const omitted = Math.max(0, text.length - head.length - tail.length)
  return {
    text: `${head}\n\n…[省略 ${omitted} 字符]…\n\n${tail}`,
    truncated: true
  }
}

/**
 * 执行一个 argv 并收集输出。
 * @param {object} ctx - 插件上下文。
 * @param {object} exec - 工具执行上下文（提供 signal）。
 * @param {object} spec - 执行参数。
 * @param {readonly string[]} spec.argv - 完整 argv（含可执行文件）。
 * @param {string} spec.cwd - 工作目录（宿主路径）。
 * @param {number} [spec.timeoutMs] - 超时毫秒。
 * @param {Record<string, string>} [spec.env] - 额外环境变量。
 * @returns {Promise<{exitCode: number, signal?: string, timedOut: boolean, durationMs: number, stdout: string, stderr: string, output: string, truncated: boolean}>} 执行结果。
 */
export async function execCapture(ctx, exec, spec) {
  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined) throw new Error('需要 subprocess 服务，但当前组合没有挂载它')
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`timeoutMs 必须在 1..${MAX_TIMEOUT_MS} 之间`)
  }

  const controller = new AbortController()
  const onAbort = () => controller.abort()
  exec.signal?.addEventListener('abort', onAbort, { once: true })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const startedAt = Date.now()
  try {
    const handle = subprocess.spawn({
      argv: spec.argv,
      cwd: spec.cwd,
      stdio: {
        stdin: spec.stdin === undefined ? 'ignore' : { data: spec.stdin },
        stdout: 'pipe',
        stderr: 'pipe'
      },
      graceMs: 5000,
      signal: controller.signal,
      env: subprocessEnv(spec.env)
    })
    const [outcome, stdout, stderr] = await Promise.all([
      handle.done,
      drain(handle.stdout, MAX_STREAM_BYTES),
      drain(handle.stderr, MAX_STREAM_BYTES)
    ])
    const out = render(stdout)
    const err = render(stderr)
    const parts = []
    if (out.text !== '') parts.push(out.text)
    if (err.text !== '') parts.push(`[stderr]\n${err.text}`)
    return {
      exitCode: outcome.exitCode ?? -1,
      ...(outcome.signal === null ? {} : { signal: String(outcome.signal) }),
      timedOut,
      durationMs: Date.now() - startedAt,
      stdout: out.text,
      stderr: err.text,
      output: parts.join('\n'),
      truncated: out.truncated || err.truncated
    }
  } finally {
    clearTimeout(timer)
    exec.signal?.removeEventListener('abort', onAbort)
  }
}
