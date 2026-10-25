/**
 * Python 解释器发现：本包**唯一**的解析器（charset / remote / env / image-ops 都走这里）。
 *
 * 为什么不能只用 PATH 上的 `python`：Windows 上 PATH 里的 `python` 常常是 MSYS2/Cygwin 的
 * `C:\msys64\usr\bin\python.exe` —— 它**没有 pip、没有 Pillow、没有 asyncssh**，于是
 * 按原字符集写回、SFTP 侧车、图片三件套、pip_install 全部报"依赖不可用"。而 DSH 自己
 * 带着解释器，依赖是齐的：
 *   - `$DSH_HOME/dsh-runtimes/<runtime>/dependencies/python/python.exe`
 *     （实测：PIL 12.3.0 + asyncssh 2.24.1）
 *   - `<process.resourcesPath>/runtime/<runtime>/dependencies/python/python.exe`
 *     （实测：PIL 12.3.0，无 asyncssh —— 所以 asyncssh 的探针必须真的跑）
 *
 * 候选顺序（高 → 低）：
 *   1. 调用方显式给的 `extra`
 *   2. `$DSH_PYTHON` → `$DSH_AGENTKIT_PYTHON`（绝对路径直接用；裸名字交给 subprocess 解析）
 *   3. `$DSH_HOME/dsh-runtimes/<runtime>/dependencies/python/python.exe`（枚举目录，不写死 runtime 名）
 *   4. `<process.resourcesPath>/runtime/<runtime>/dependencies/python/python.exe`
 *   5. `dirname(process.execPath)/../../python/python.exe`
 *   6. PATH 上的 `python` / `python3` / `py`
 * 绝对路径候选**存在才保留**（第 5 条在 Desktop 上必然不存在：`process.execPath` 是
 * `D:\a\dsh\DeepSeek Harness.exe`，所以它会被静默丢掉，这正是 1.4.1 那个 bug 的根因）。
 *
 * `resolvePython(ctx, exec, probe)` 会真的跑 `<candidate> -c <probe>`，返回**第一个退出码为 0**
 * 的解释器（`probe === ''` 表示不探针，直接取第一个候选）；全都不通过时退回第一个候选并 warn，
 * 把"最后兜底"留给调用方（例如 SFTP 侧车自己的 `--auto-install`）。
 *
 * @module @local/dsh-agentkit/python
 */
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { execCapture, usableCwd } from './exec.js'

/** 基础候选（不含 `extra`）的进程内缓存：候选只取决于环境，进程内不会变。 */
let baseCandidates

/** 按 probe 字符串缓存**已成功**的解析结果（失败不缓存，便于环境修好后重试）。 */
const resolvedByProbe = new Map()

/**
 * `$DSH_HOME`，缺省退回 `~/.dsh`（与 harness 的默认 profile 根一致）。
 * @returns {string} 运行期根目录。
 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/**
 * 枚举 `<root>/<runtime>/dependencies/python/python.exe` 形式的解释器（目录名排序，保证顺序稳定）。
 * @param {string} root - 运行期根目录。
 * @param {string} runtimeDir - 装着各 runtime 的目录名（`dsh-runtimes` 或 `runtime`）。
 * @returns {string[]} 候选绝对路径（不保证存在）。
 */
function runtimeInterpreters(root, runtimeDir) {
  const base = join(root, runtimeDir)
  let names = []
  try {
    names = readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
  return names.map((name) => join(base, name, 'dependencies', 'python', 'python.exe'))
}

/**
 * 一个候选值 → 可用的绝对解释器路径（绝对路径要求存在；裸名字交给 subprocess 解析）。
 * @param {object|undefined} subprocess - subprocess 服务（可能没挂载）。
 * @param {unknown} value - 候选（路径或 PATH 名）。
 * @param {object} exec - 工具执行上下文（提供 signal）。
 * @returns {Promise<string|undefined>} 绝对路径，或 undefined 表示该候选不可用。
 */
async function resolveCandidate(subprocess, value, exec) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const candidate = value.trim()
  if (isAbsolute(candidate)) return existsSync(candidate) ? candidate : undefined
  if (subprocess === undefined) return undefined
  try {
    return await subprocess.resolveExecutable(candidate, undefined, exec?.signal)
  } catch {
    return undefined
  }
}

/** 进程工作目录；取不到就用 home（subprocess.spawn 要求 cwd 合法）。 */
function safeCwd() {
  try {
    return process.cwd()
  } catch {
    return homedir()
  }
}

/**
 * 探针的工作目录：**候选自己的目录**（候选都是绝对路径，其目录必然存在）。
 *
 * 不能用 `process.cwd()`：Desktop 宿主里工作目录可能已被删除，而它**不会抛错**，
 * 只会让每次 spawn 都 ENOENT —— 探针就静默失效（退回 `candidates[0]`），
 * `import asyncssh` / `import PIL` 便不再起筛选作用。这里用 `usableCwd()` 做最终校验，
 * 保证交给 spawn 的目录一定存在。
 * @param {string} candidate - 解释器路径。
 * @returns {string} 存在的目录。
 */
function probeCwd(candidate) {
  return usableCwd(isAbsolute(candidate) ? dirname(candidate) : undefined, safeCwd())
}

/**
 * 基础候选（`extra` 之外的全部来源）。
 * @param {object} ctx - 插件上下文。
 * @param {object} exec - 工具执行上下文。
 * @returns {Promise<string[]>} 去重后的候选绝对路径。
 */
async function basePythonCandidates(ctx, exec) {
  const subprocess = ctx?.get?.('subprocess')
  const out = []
  const push = (value) => {
    if (typeof value !== 'string' || value === '' || out.includes(value)) return
    out.push(value)
  }
  const pushIfFile = (value) => {
    if (typeof value === 'string' && value !== '' && existsSync(value)) push(value)
  }

  for (const name of ['DSH_PYTHON', 'DSH_AGENTKIT_PYTHON']) {
    push(await resolveCandidate(subprocess, process.env[name], exec))
  }
  for (const candidate of runtimeInterpreters(dshHome(), 'dsh-runtimes')) pushIfFile(candidate)
  const resourcesPath = process.resourcesPath
  if (typeof resourcesPath === 'string' && resourcesPath !== '') {
    for (const candidate of runtimeInterpreters(resourcesPath, 'runtime')) pushIfFile(candidate)
  }
  if (typeof process.execPath === 'string' && process.execPath !== '') {
    pushIfFile(join(dirname(process.execPath), '..', '..', 'python', 'python.exe'))
  }
  for (const name of ['python', 'python3', 'py']) {
    push(await resolveCandidate(subprocess, name, exec))
  }
  return out
}

/**
 * 解释器候选列表（去重、优先级从高到低、只保留存在的绝对路径）。
 * @param {object} ctx - 插件上下文。
 * @param {object} exec - 工具执行上下文。
 * @param {string[]} [extra] - 调用方追加的最高优先级候选。
 * @returns {Promise<string[]>} 候选绝对路径。
 */
export async function pythonCandidates(ctx, exec, extra = []) {
  baseCandidates ??= basePythonCandidates(ctx, exec)
  const base = await baseCandidates
  const head = []
  const subprocess = ctx?.get?.('subprocess')
  for (const item of Array.isArray(extra) ? extra : [extra]) {
    const candidate = await resolveCandidate(subprocess, item, exec)
    if (candidate !== undefined && !head.includes(candidate)) head.push(candidate)
  }
  // `extra` 是最高优先级：即使某个路径也在基础列表里，也要提到最前（并去重）。
  return [...head, ...base.filter((candidate) => !head.includes(candidate))]
}

/**
 * 解析一个**能通过探针**的 Python 解释器。
 * @param {object} ctx - 插件上下文（需要 subprocess 服务来跑探针）。
 * @param {object} exec - 工具执行上下文（提供 signal）。
 * @param {string} [probe] - 传给 `-c` 的探针代码；空字符串表示不探针、直接取第一个候选。
 * @param {string[]} [extra] - 调用方追加的最高优先级候选。
 * @returns {Promise<string>} 解释器绝对路径。
 * @throws 候选列表为空（一个解释器都找不到）时抛出。
 */
export async function resolvePython(ctx, exec, probe = '', extra = []) {
  const key = typeof probe === 'string' ? probe : String(probe)
  const cached = resolvedByProbe.get(key)
  if (cached !== undefined) return cached
  if (ctx?.get?.('subprocess') === undefined) {
    throw new Error('agentkit: 解析 Python 需要 subprocess 服务，但当前组合没有挂载它')
  }
  const candidates = await pythonCandidates(ctx, exec, extra)
  if (candidates.length === 0) {
    throw new Error('agentkit: 找不到任何 Python 解释器'
      + '（$DSH_PYTHON / $DSH_AGENTKIT_PYTHON / $DSH_HOME/dsh-runtimes / <resourcesPath>/runtime / PATH 都没有）')
  }
  if (key === '') {
    resolvedByProbe.set(key, candidates[0])
    return candidates[0]
  }
  for (const candidate of candidates) {
    try {
      const result = await execCapture(ctx, exec, {
        argv: [candidate, '-c', key],
        cwd: probeCwd(candidate),
        timeoutMs: 30_000
      })
      if (result.exitCode === 0) {
        resolvedByProbe.set(key, candidate)
        return candidate
      }
    } catch {
      /* 该候选跑不起来，试下一个 */
    }
  }
  ctx?.logger?.warn?.(`agentkit: 没有解释器能通过探针 ${JSON.stringify(key)}；`
    + `退回第一个候选 ${candidates[0]}（调用方自己的兜底逻辑仍会生效）`)
  return candidates[0]
}
