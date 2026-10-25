/**
 * 环境能力：pip_install（镜像加速）与 env_setup（探测 + 安装 + 写环境清单）。
 *
 * 「通用 agent 负责环境搭建」的落地：env_setup 一次调用就完成
 *   探测现有程序 → 按需 pip 安装（走清华镜像）→ 重新探测 → 写 ENV.md，
 * 让接手下一阶段的人（或模型）不必再问"装了什么"。
 *
 * @module @local/dsh-doc-pipeline/env
 */
import { pipInstallArgv, pipShowArgv } from '../lib/argv.js'
import { MAX_TIMEOUT_MS, PIP_INDEX_URL, execCapture } from '../lib/exec.js'
import { currentPolicy, cwdFor, normalizePathInput, resolveOptions } from '../lib/fs-common.js'
import { resolvePython } from '../lib/python.js'
import { createToolRegistrar } from './registry.js'

/** 需要工具注册表与文件系统。 */
export const inject = ['tools', 'fs']

/** 默认探测的程序与它们的版本参数。 */
const PROBE_ARGS = {
  python: ['--version'],
  pip: ['--version'],
  git: ['--version'],
  tar: ['--version'],
  pandoc: ['--version'],
  docling: ['--version'],
  bash: ['--version'],
  node: ['--version']
}

/** 探测单个程序。 */
async function probeOne(ctx, exec, name, cwd) {
  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined) throw new Error('env_setup 需要 subprocess 服务')
  let executable
  try {
    executable = await subprocess.resolveExecutable(name, undefined, exec.signal)
  } catch {
    return { name, found: false, version: '', path: '' }
  }
  const result = await execCapture(ctx, exec, {
    argv: [executable, ...(PROBE_ARGS[name] ?? ['--version'])],
    cwd,
    timeoutMs: 30_000
  })
  const first = result.output.split('\n').map((line) => line.trim()).find((line) => line !== '') ?? ''
  return { name, found: true, version: first.slice(0, 140), path: executable }
}

/** pip 解释器解析的探针：必须真的能 `import pip`（PATH 上的 MSYS2 python 既没有 pip 也没有 Pillow）。 */
const PIP_PROBE = 'import pip'

/**
 * 跑一次 `--version` 取首行：用于报告**实际会用的**解释器版本（PATH 探测的那份可能不是同一只）。
 * @param {object} ctx - 插件上下文。
 * @param {object} exec - 工具执行上下文。
 * @param {string} executable - 已解析的可执行文件。
 * @param {string} cwd - 工作目录。
 * @returns {Promise<string>} 首行文本；取不到时为空串。
 */
async function probeVersion(ctx, exec, executable, cwd) {
  try {
    const result = await execCapture(ctx, exec, { argv: [executable, '--version'], cwd, timeoutMs: 30_000 })
    return (result.output.split('\n').map((line) => line.trim()).find((line) => line !== '') ?? '').slice(0, 140)
  } catch {
    return ''
  }
}

/**
 * 定义 pip_install。
 * @param {object} ctx - 插件上下文。
 * @returns {object} 工具定义。
 */
function pipInstallDefinition(ctx) {
  return {
    name: 'pip_install',
    description: `用 python -m pip 安装 Python 包，自动走镜像（${PIP_INDEX_URL}）并校验安装结果。`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        packages: { type: 'array', items: { type: 'string' }, description: '包名列表，可带版本约束，如 ["docling"]。' },
        upgrade: { type: 'boolean', description: '是否加 --upgrade。默认 false。' },
        user: { type: 'boolean', description: '是否加 --user（无管理员权限时有用）。默认 false。' },
        timeout_ms: { type: 'number', description: `超时毫秒数，默认 300000，上限 ${MAX_TIMEOUT_MS}。` }
      },
      required: ['packages']
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          exit_code: { type: 'integer' },
          index_url: { type: 'string' },
          verified: { type: 'array', items: { type: 'string' } },
          missing: { type: 'array', items: { type: 'string' } },
          output: { type: 'string' }
        },
        required: ['exit_code', 'index_url', 'verified', 'missing', 'output']
      },
      render: (_args, value) => [{
        type: 'text',
        text: `<pip exit="${value.exit_code}" index="${value.index_url}"/>\n已就绪: ${value.verified.join(', ') || '(无)'}\n未就绪: ${value.missing.join(', ') || '(无)'}\n${value.output}`
      }]
    },
    async execute(args, exec) {
      if (!Array.isArray(args?.packages) || args.packages.length === 0) throw new Error('packages 必须是非空字符串数组')
      const packages = args.packages.map((item, index) => {
        if (typeof item !== 'string' || item.trim() === '') throw new Error(`packages[${index}] 必须是非空字符串`)
        return item.trim()
      })
      const cwd = cwdFor(ctx, exec)
      const python = await resolvePython(ctx, exec, PIP_PROBE)
      const timeoutMs = args?.timeout_ms === undefined ? 300_000 : Number(args.timeout_ms)
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
        throw new Error(`timeout_ms 必须在 1..${MAX_TIMEOUT_MS} 之间`)
      }
      const install = await execCapture(ctx, exec, {
        argv: [python, ...pipInstallArgv({
          packages,
          indexUrl: PIP_INDEX_URL,
          upgrade: args?.upgrade === true,
          user: args?.user === true
        })],
        cwd,
        timeoutMs
      })
      const show = await execCapture(ctx, exec, {
        argv: [python, ...pipShowArgv(packages.map((name) => name.replace(/[<>=!~].*$/u, '')))],
        cwd,
        timeoutMs: 60_000
      })
      const verified = show.output.split('\n')
        .filter((line) => line.startsWith('Name:'))
        .map((line) => line.slice('Name:'.length).trim())
      const requested = packages.map((name) => name.replace(/[<>=!~].*$/u, ''))
      return {
        exit_code: install.exitCode,
        index_url: PIP_INDEX_URL,
        verified,
        missing: requested.filter((name) => !verified.includes(name)),
        output: install.output
      }
    },
    presentCall(args) {
      return { card: 'terminal', title: `pip install ${(args.packages ?? []).join(' ')}`, description: '镜像加速' }
    }
  }
}

/**
 * 定义 env_setup。
 * @param {object} ctx - 插件上下文。
 * @returns {object} 工具定义。
 */
function envSetupDefinition(ctx) {
  return {
    name: 'env_setup',
    description: '环境搭建：探测常用程序、按需 pip 安装（走镜像）、重新探测，并把结果写成 ENV.md 供后续阶段接手。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        pip_packages: { type: 'array', items: { type: 'string' }, description: '需要安装的 Python 包（如 ["docling"]）；已安装时 pip 会跳过。' },
        probe: { type: 'array', items: { type: 'string' }, description: '额外要探测的程序名，如 ["magick","qpdf"]。' },
        out: { type: 'string', description: '环境清单路径，默认 out/ENV.md（目录会自动创建）。' },
        timeout_ms: { type: 'number', description: `安装超时毫秒数，默认 300000，上限 ${MAX_TIMEOUT_MS}。` }
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          out: { type: 'string' },
          index_url: { type: 'string' },
          programs: { type: 'array', items: { type: 'string' } },
          missing: { type: 'array', items: { type: 'string' } },
          installed: { type: 'array', items: { type: 'string' } },
          install_output: { type: 'string' }
        },
        required: ['out', 'index_url', 'programs', 'missing', 'installed', 'install_output']
      },
      render: (_args, value) => [{
        type: 'text',
        text: `<env out="${value.out}" index="${value.index_url}"/>\n${value.programs.join('\n')}\n缺失: ${value.missing.join(', ') || '(无)'}\n本次安装: ${value.installed.join(', ') || '(未请求)'}`
      }]
    },
    async execute(args, exec) {
      const cwd = cwdFor(ctx, exec)
      const outRel = typeof args?.out === 'string' && args.out.trim() !== '' ? normalizePathInput(args.out, 'out') : 'out/ENV.md'
      const extraProbes = Array.isArray(args?.probe)
        ? args.probe.filter((name) => typeof name === 'string' && name.trim() !== '').map((name) => name.trim())
        : []
      const names = [...new Set([...Object.keys(PROBE_ARGS), ...extraProbes])]

      // 解析 pip 真正会用的解释器（与 pip_install 同一套）：PATH 上的 `python`/`pip` 可能是
      // 没有 pip 的另一份（MSYS2）或另一份 3.x，只照 PATH 报 OK/MISS 会让人装错解释器。
      let python
      let pythonVersion = ''
      let pythonError = ''
      try {
        python = await resolvePython(ctx, exec, PIP_PROBE)
        pythonVersion = await probeVersion(ctx, exec, python, cwd)
      } catch (error) {
        python = undefined
        pythonError = error instanceof Error ? error.message : String(error)
      }

      let installOutput = ''
      let installed = []
      const packages = Array.isArray(args?.pip_packages)
        ? args.pip_packages.filter((name) => typeof name === 'string' && name.trim() !== '').map((name) => name.trim())
        : []
      if (packages.length > 0) {
        if (python === undefined) {
          throw new Error(`没有可用的 Python 解释器（pip 需要能 \`import pip\` 的解释器）：${pythonError || '未找到候选'}`)
        }
        const timeoutMs = args?.timeout_ms === undefined ? 300_000 : Number(args.timeout_ms)
        const install = await execCapture(ctx, exec, {
          argv: [python, ...pipInstallArgv({ packages, indexUrl: PIP_INDEX_URL })],
          cwd,
          timeoutMs
        })
        installOutput = install.output
        const show = await execCapture(ctx, exec, {
          argv: [python, ...pipShowArgv(packages.map((name) => name.replace(/[<>=!~].*$/u, '')))],
          cwd,
          timeoutMs: 60_000
        })
        installed = show.output.split('\n')
          .filter((line) => line.startsWith('Name:'))
          .map((line) => line.slice('Name:'.length).trim())
      }

      const programs = []
      for (const name of names) programs.push(await probeOne(ctx, exec, name, cwd))
      const missing = programs.filter((entry) => !entry.found).map((entry) => entry.name)

      const pythonLine = python === undefined
        ? `- pip 解释器（env_setup / pip_install 实际使用）: 未找到可用解释器${pythonError === '' ? '' : `（${pythonError}）`}`
        : `- pip 解释器（env_setup / pip_install 实际使用）: ${python}${pythonVersion === '' ? '' : ` —— ${pythonVersion}`}`
      const lines = [
        '# 环境清单（env_setup 生成）',
        '',
        `- 生成时间: ${new Date().toISOString()}`,
        `- 工作目录: ${cwd}`,
        `- pip 镜像: ${PIP_INDEX_URL}`,
        pythonLine,
        '',
        '> 说明：下面的表是 **PATH 探测**（"命令行里能不能跑"）。`node` / `pwsh` / `python` 这些行',
        '> 可能指向另一份实现（pwsh 可能是 WindowsApps 别名、python 可能是 MSYS2 或另一份 3.x），',
        '> **不代表 harness 的工具真正使用什么**；装 Python 包请用上面那行给出的解释器。',
        '',
        '| 程序 | 状态 | 版本 |',
        '|---|---|---|',
        ...programs.map((entry) => `| ${entry.name} | ${entry.found ? 'OK' : '缺失'} | ${entry.version.replace(/\|/gu, '/') || '-'} |`),
        '',
        '## 本次安装',
        installed.length > 0 ? `- 已就绪: ${installed.join(', ')}` : '- 未请求安装',
        packages.length > 0 && installed.length === 0 ? `- 请求但未确认: ${packages.join(', ')}` : '',
        '',
        '## 给接手者的说明',
        '- 命令一律走 run（argv，无 shell）或 sh（bash，非 PowerShell）。',
        `- pip 已配置镜像；装包请用上面的解释器：\`${python ?? '<python>'} -m pip install <包>\`（PATH 上的 pip 可能属于另一份 python）。`,
        '- 读写文件用 read_text / write_text / edit_text（自动处理编码与换行）。'
      ].filter((line) => line !== undefined)
      const text = `${lines.join('\n')}\n`

      const policy = currentPolicy(ctx, exec)
      const options = resolveOptions(exec, policy?.workspaceRoot, ctx)
      const target = await ctx.fs.resolve(outRel, options)
      const intent = await ctx.waterfall('fs/write-intent', target, exec, () => undefined)
      const outcome = await ctx.fs.writeText(target, text, intent, exec.signal, policy)
      ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)

      // 输出 schema 不能加字段（additionalProperties:false），所以"实际使用的解释器"放在
      // programs 数组的第一行；missing 仍然只反映 PATH 探测，语义不变。
      const authoritative = python === undefined
        ? ['MISS python(实际使用) 未找到能 import pip 的解释器']
        : [`OK   python(实际使用) ${pythonVersion || '(版本未取到)'} @ ${python}`]
      return {
        out: target.displayPath,
        index_url: PIP_INDEX_URL,
        programs: [...authoritative, ...programs.map((entry) => `${entry.found ? 'OK  ' : 'MISS'} ${entry.name} ${entry.version}`.trim())],
        missing,
        installed,
        install_output: installOutput
      }
    },
    presentCall(args) {
      return { card: 'terminal', title: '环境搭建与探测', description: 'env_setup' }
    }
  }
}

/**
 * 挂载 pip_install 与 env_setup。
 * @param {object} ctx - preset 作用域的插件上下文。
 */
export function apply(ctx) {
  const register = createToolRegistrar(ctx)
  register(pipInstallDefinition(ctx))
  register(envSetupDefinition(ctx))
}
