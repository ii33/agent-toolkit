/**
 * 离线测试依赖解析。
 *
 * 背景：本包**不声明也不携带** npm 依赖 —— schemastery / cosmokit / react 由 DSH 安装提供，
 * 运行期取不到时优雅降级。但 test/ 下的测试需要真依赖（真 YAML 解析器、真 React）才算数，
 * 而这些包在 DSH 0.2.1-rc.2 里位于 `resources/app.asar` 内，**普通 node 读不进去**
 * （asar 对 node 是一个普通文件）。所以测试不再硬编码安装路径，而是按下面的顺序查找：
 *
 *   1. `$DSH_TEST_DEPS`  —— 一个存放依赖的目录（可以直接指向 node_modules，或它的父目录）；
 *   2. `<仓库>/test/vendor`  —— 想随包携带依赖时的位置；
 *   3. `<仓库>/node_modules`  —— 在仓库里跑过 `pnpm install` 的情况；
 *   4. `$DSH_APP_ROOT/node_modules`  —— 非 asar 布局（源码 checkout / electron 解包）时的安装目录。
 *
 * 找不到就**直接报错**并给出安装指引：绝不退化成"跳过"或"假实现"，
 * 否则测试会假装通过而失去意义。
 *
 * 用法：
 *   const yaml = loadDependency('js-yaml')
 *   const react = loadDependency('react')
 *
 * @module @local/dsh-agentkit/test/deps
 */
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 把候选目录规范化成"从这里开始 node 解析"的起点。 */
function asStartDirs(directory) {
  if (directory === undefined || directory === '' || !existsSync(directory)) return []
  // basename === node_modules 时，它本身就是起点，其父目录同样可以起解析。
  return basename(directory) === 'node_modules' ? [directory, dirname(directory)] : [directory]
}

/**
 * 依赖查找起点，按优先级排列。
 * @returns {string[]} 存在的目录。
 */
export function searchDirs() {
  const candidates = [
    process.env.DSH_TEST_DEPS,
    join(REPO_ROOT, 'test', 'vendor'),
    REPO_ROOT,
    process.env.DSH_APP_ROOT === undefined ? undefined : join(process.env.DSH_APP_ROOT, 'node_modules')
  ]
  const dirs = []
  for (const candidate of candidates) {
    for (const dir of asStartDirs(candidate)) {
      if (!dirs.includes(dir)) dirs.push(dir)
    }
  }
  return dirs
}

/**
 * 解析一个测试依赖的绝对路径。
 * @param {string} name - 包名（可以带子路径）。
 * @returns {string} 解析到的文件路径。
 * @throws {Error} 依赖不存在时，附带安装指引与已尝试的目录。
 */
export function resolveDependency(name) {
  const dirs = searchDirs()
  try {
    return require.resolve(name, { paths: dirs })
  } catch (problem) {
    throw new Error(
      `缺少离线测试依赖 "${name}"（${problem?.code ?? problem?.message}）。\n`
      + '安装方式（任选其一）：\n'
      + '  a) 运行工作区里的测试依赖箱：在 adapt-verify/harness 执行 pnpm install，'
      + '然后用 DSH_TEST_DEPS=<harness>/node_modules 运行测试；\n'
      + '  b) 在本仓库执行 pnpm install（会把依赖装进 <仓库>/node_modules）。\n'
      + `已尝试的解析起点：${dirs.length === 0 ? '(无)' : dirs.join(' | ')}`
    )
  }
}

/**
 * 出货 `cordis.patch.yml` 里 `generic` 预设的 toolkit 能力数组 —— **唯一真源**。
 *
 * 测试不再各自硬编码一份能力清单（曾出现 load 测试 9 项、measure 10 项、出货补丁 13 项三方打架）。
 * 需要 js-yaml，故走 `loadDependency`（与 preset-inject 测试同一套依赖解析）。
 *
 * @returns {string[]} 能力名（保持补丁里的顺序）。
 * @throws {Error} 补丁里找不到那行 toolkit 时。
 */
export function shippedGenericCapabilities() {
  const yaml = loadDependency('js-yaml')
  const file = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))
  const document = yaml.load(readFileSync(file, 'utf8'))
  const rows = Array.isArray(document)
    ? document.flatMap((entry) => (Array.isArray(entry?.insert) ? entry.insert : []))
    : []
  const preset = rows.find((row) => row?.id === 'preset-generic')
  const plugins = preset?.config?.plugins
  const toolkit = Array.isArray(plugins) ? plugins.find((row) => row?.id === 'toolkit') : undefined
  const tools = toolkit?.config?.tools
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new Error('cordis.patch.yml 里找不到 preset-generic → toolkit.config.tools')
  }
  return tools
}

/**
 * 加载一个测试依赖（CommonJS 导出）。
 * @param {string} name - 包名（可以带子路径）。
 * @returns {unknown} 模块导出。
 */
export function loadDependency(name) {
  return require(resolveDependency(name))
}

/**
 * 测试用 python 候选：显式覆盖 → DSH 自带解释器 → PATH 上的 `python`。
 *
 * 为什么不能直接用 PATH：本机 PATH 上的 `python` 是 MSYS2 的（既没有 pip 也没有 Pillow），
 * 而 DSH 装的解释器自带 Pillow；测试（尤其 image-ops）需要后者。
 * @returns {string[]} 候选（去重，按优先级）。
 */
function pythonCandidatesForTest() {
  const candidates = []
  for (const name of ['DSH_TEST_PYTHON', 'DSH_PYTHON']) {
    const value = process.env[name]
    if (typeof value === 'string' && value.trim() !== '') candidates.push(value.trim())
  }
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  try {
    for (const runtime of readdirSync(join(dshHome, 'dsh-runtimes'))) {
      candidates.push(join(dshHome, 'dsh-runtimes', runtime, 'dependencies', 'python', 'python.exe'))
    }
  } catch {
    /* 没装 runtime 就跳过 */
  }
  if (typeof process.resourcesPath === 'string') {
    try {
      for (const runtime of readdirSync(join(process.resourcesPath, 'runtime'))) {
        candidates.push(join(process.resourcesPath, 'runtime', runtime, 'dependencies', 'python', 'python.exe'))
      }
    } catch {
      /* Desktop 之外的运行方式没有这个目录 */
    }
  }
  candidates.push('python')
  return [...new Set(candidates)]
}

/** 能跑通就留下。 */
function pythonRuns(candidate, expression) {
  try {
    return spawnSync(candidate, ['-c', expression], { encoding: 'utf8', timeout: 15_000 }).status === 0
  } catch {
    return false
  }
}

/**
 * 挑一个测试用的解释器：优先能 `import PIL` 的（image 能力要），否则能跑起来的，
 * 最后才退回裸名 `python`。可用 `DSH_TEST_PYTHON` 强制指定。
 * @returns {string} 解释器路径或名字。
 */
function pickPython() {
  const candidates = pythonCandidatesForTest()
  for (const candidate of candidates) if (pythonRuns(candidate, 'import PIL')) return candidate
  for (const candidate of candidates) if (pythonRuns(candidate, 'pass')) return candidate
  return 'python'
}

const PYTHON = pickPython()

/** 探测解释器属于 posix 世界（MSYS2 / Cygwin）还是 Windows 原生。 */
function detectPythonStyle() {
  try {
    const probe = spawnSync(PYTHON, ['-c', 'import sys; print(sys.platform)'], { encoding: 'utf8', timeout: 15_000 })
    const platform = (probe.stdout ?? '').trim()
    return platform.startsWith('cygwin') || platform.startsWith('msys') ? 'posix' : 'windows'
  } catch {
    return 'windows'
  }
}

const PYTHON_STYLE = detectPythonStyle()

/** 本进程用来跑 python 辅助脚本的解释器与其路径风格。 */
export const pythonRuntime = { command: PYTHON, style: PYTHON_STYLE }

/**
 * 把 Windows 绝对路径转成解释器认得的 argv 形式。
 *
 * MSYS2 / Cygwin 的 python 用 posixpath：`D:\a\b.py` 没有 `/`，会被当成相对路径，
 * 报 `can't open file '/c/.../D:\a\b.py'`。所以 posix 世界要转成 `/d/a/b.py`。
 * 插件自身走 lib/exec.js 的 pythonPathArg()，这里是它的测试侧对应实现。
 *
 * @param {string} path - Windows 形式路径。
 * @returns {string} argv 可用的路径。
 */
export function pythonArg(path) {
  if (PYTHON_STYLE !== 'posix') return path
  const drive = /^([A-Za-z]):[\\/](.*)$/u.exec(path)
  if (drive === null) return path.replaceAll('\\', '/')
  return `/${drive[1].toLowerCase()}/${drive[2].replaceAll('\\', '/')}`
}

/**
 * 调一个 Python 脚本的 spawn 参数。
 * @param {string} scriptPath - 脚本的绝对路径（Windows 形式）。
 * @returns {{ command: string, script: string, cwd: string, style: string }} spawn 参数。
 */
export function pythonScript(scriptPath) {
  return { command: PYTHON, script: pythonArg(scriptPath), cwd: dirname(scriptPath), style: PYTHON_STYLE }
}

/**
 * 取一份"出货文件"（例如装机包里的预设补丁）用于测试。
 *
 * 优先读真实安装（非 asar 布局），否则回落到 test/fixtures/ 里的同名快照 ——
 * 因为 DSH Desktop 把装机包放在 `resources/app.asar` 内，普通 node 读不进去。
 * 回落时会把来源打在测试输出里，避免"以为在测真出货文件"。
 *
 * @param {string} relative - 相对装机包 node_modules 的路径，例如
 *   `@deepseek-ai/dsh-web-app/presets/standard.patch.yml`。
 * @returns {{ path: string, source: 'installation' | 'fixture' }} 文件路径与来源。
 * @throws {Error} 两处都找不到时。
 */
export function resolveShippedFile(relative) {
  const roots = []
  if (process.env.DSH_SHIPPED_MODULES !== undefined && process.env.DSH_SHIPPED_MODULES !== '') {
    roots.push(process.env.DSH_SHIPPED_MODULES)
  }
  if (process.env.DSH_APP_ROOT !== undefined && process.env.DSH_APP_ROOT !== '') {
    roots.push(join(process.env.DSH_APP_ROOT, 'node_modules'))
  }
  for (const root of roots) {
    const candidate = join(root, relative)
    if (existsSync(candidate)) return { path: candidate, source: 'installation' }
  }
  const fixture = fileURLToPath(new URL(`./fixtures/${basename(relative)}`, import.meta.url))
  if (existsSync(fixture)) return { path: fixture, source: 'fixture' }
  throw new Error(
    `找不到出货文件 "${relative}"：安装目录（$DSH_APP_ROOT / $DSH_SHIPPED_MODULES）与 `
    + `test/fixtures/${basename(relative)} 都没有。`
  )
}
