/**
 * 真实集成验证：真 Cordis + 真 LocalJobRegistry + 真 LocalSubprocessRuntime +
 * 真 agentkit 工具，逐个验证 sh / pwsh / run 的 run_in_background。
 *
 * 为什么必须有这个脚本：单元测试用假服务，测不出"真服务要什么"。
 * 前几轮修复都过了单测，问题全在真契约上（owner 类型、exec.signal 生命周期）。
 *
 * 运行：
 *   $env:ELECTRON_RUN_AS_NODE='1'
 *   & "<DSH>\DeepSeek Harness.exe" scripts/verify-background.mjs
 */
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const work = mkdtempSync(join(tmpdir(), 'agentkit-int-'))
process.env.DSH_AGENTKIT_STATE_DIR = work

const r = createRequire('C:\\Users\\youai\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar\\dsh\\package.json')
const Cordis = r('@deepseek-ai/cordis')
const jobsMod = await import(`file:///${r.resolve('@deepseek-ai/dsh-jobs-local').replace(/\\/g, '/')}`)
const spMod = await import(`file:///${r.resolve('@deepseek-ai/dsh-subprocess-local').replace(/\\/g, '/')}`)

const requireProfile = createRequire('C:\\Users\\youai\\.dsh\\profiles\\desktop\\package.json')
const agentkitPath = requireProfile.resolve('@local/dsh-agentkit').replace(/\\/g, '/')
const { apply } = await import(`file:///${agentkitPath}`)

const app = new Cordis.Context()
const SESSION_ID = 'session-integration-test'
const AGENT = { id: SESSION_ID, session: { id: SESSION_ID, ctx: app }, ctx: app }

app.plugin({
  name: 'fake-agents',
  apply(ctx) { ctx.provide('agents', { get: (id) => (id === SESSION_ID ? AGENT : undefined) }) }
})
app.plugin(jobsMod.default)
app.plugin(spMod.default)
await new Promise((ok) => setTimeout(ok, 500))

const jobs = app.get('jobs')
if (jobs === undefined) { console.log('❌ jobs 服务未就绪'); process.exit(2) }
jobs.attachController('tool-jobs')   // 等价于挂载 @deepseek-ai/dsh-tool-jobs 时做的事

/** 在独立 ctx 里挂指定能力，返回该能力对应的工具。 */
function loadTool(capability) {
  const tools = []
  const warnings = []
  apply({
    logger: { info() {}, warn: (m) => warnings.push(m), error() {} },
    tools: { get: () => undefined, register: (d) => { tools.push(d); return () => {} } },
    systemPrompt: { context() {}, section() {} },
    on: () => () => {},
    effect: (fn) => { fn(); return () => {} },
    get: (name) => app.get(name),
    waterfall: async () => undefined,
    emit() {}
  }, { tools: [capability] })
  return { tool: tools.find((t) => t.name === capability), warnings }
}

const exec = { agent: AGENT, signal: new AbortController().signal }

/** 各工具的"睡一会儿再输出"写法。睡眠时长要够长，才能区分"后台返回"与"等它跑完"。 */
const SLEEP_SECONDS = 12
const CASES = [
  { cap: 'sh', args: { command: `sleep ${SLEEP_SECONDS} && echo SH_DONE` } },
  { cap: 'pwsh', args: { script: `Start-Sleep -Seconds ${SLEEP_SECONDS}; Write-Output PWSH_DONE` } },
  { cap: 'run', args: { program: 'sleep', args: [String(SLEEP_SECONDS)] } }
]

// 判定阈值取命令时长的一半：真后台化会在远小于睡眠时长的时间内返回。
// 不要用固定的 3000ms —— pwsh 首次调用要先探测/启动 pwsh（约 3.5s），会误判成"仍阻塞"。
const THRESHOLD_MS = (SLEEP_SECONDS * 1000) / 2

let failures = 0
for (const { cap, args } of CASES) {
  const { tool, warnings } = loadTool(cap)
  console.log(`\n=== ${cap}：run_in_background: true ===`)
  if (tool === undefined) { console.log(`  ❌ ${cap} 工具未注册`); failures += 1; continue }

  const started = Date.now()
  let value
  try {
    value = await tool.execute({ ...args, run_in_background: true, cwd: work }, exec)
  } catch (error) {
    console.log(`  ❌ 执行抛错: ${String(error.message).slice(0, 130)}`)
    failures += 1
    continue
  }
  const elapsed = Date.now() - started

  const immediate = elapsed < THRESHOLD_MS
  const hasJob = typeof value.job_id === 'string' && value.job_id !== ''
  console.log(`  耗时: ${elapsed}ms  ${immediate ? '✅ 立刻返回' : '❌ 仍阻塞'}`)
  console.log(`  background=${value.background}  job_id=${value.job_id ?? '(无)'}`)
  if (!hasJob) {
    console.log(`  ❌ 没有 job_id → 退回了同步执行`)
    if (warnings.length > 0) console.log(`  warn: ${warnings[0]}`)
    failures += 1
    continue
  }

  // 校验作业真的在后台跑
  await new Promise((ok) => setTimeout(ok, 1200))
  const mine = jobs.list(SESSION_ID).find((j) => j.id === value.job_id)
  console.log(`  状态（1.2s 后）: ${mine?.status ?? '(查不到)'}  ${mine?.status === 'running' ? '✅ 在后台运行' : '⚠️'}`)
  if (mine?.status !== 'running') failures += 1

  // 终止并确认
  try { await jobs.kill(value.job_id, SESSION_ID, 'verify cleanup') } catch {}
  await new Promise((ok) => setTimeout(ok, 800))
  const after = jobs.list(SESSION_ID).find((j) => j.id === value.job_id)
  console.log(`  终止后状态: ${after?.status ?? '(查不到)'}  ${after?.status !== 'running' ? '✅ 已停止' : '❌ 仍在跑'}`)
  if (after?.status === 'running') failures += 1
}

console.log(`\n${failures === 0 ? '✅ 三个工具全部通过' : `❌ ${failures} 项失败`}`)
try { rmSync(work, { recursive: true, force: true }) } catch {}
process.exit(failures === 0 ? 0 : 1)
