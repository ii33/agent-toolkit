/**
 * 真实集成测试：真 Cordis + 真 LocalJobRegistry + 真 LocalSubprocessRuntime + 真 agentkit 工具。
 *
 * 验证 sh({ run_in_background: true }) 立刻返回 job_id，而不是阻塞。
 * 这是用户实测出问题的那条路径，必须端到端跑。
 */
import { createRequire } from 'node:module'
import { mkdtempSync } from 'node:fs'
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

app.plugin({ name: 'fake-agents', apply(ctx) { ctx.provide('agents', { get: (id) => (id === SESSION_ID ? AGENT : undefined) }) } })
app.plugin(jobsMod.default)
app.plugin(spMod.default)
await new Promise((ok) => setTimeout(ok, 400))

const jobs = app.get('jobs')
const subprocess = app.get('subprocess')
if (jobs === undefined || subprocess === undefined) { console.log('服务未就绪'); process.exit(2) }
jobs.attachController('tool-jobs')   // 等价于 @deepseek-ai/dsh-tool-jobs 挂载时做的事

// 在子作用域里挂 agentkit 的 sh 工具
const tools = []
const toolCtx = app.isolate ? app.isolate({}) : app
const ctxLike = {
  logger: { info() {}, warn: (m) => console.log('  [warn] ' + m), error() {} },
  tools: { get: () => undefined, register: (d) => { tools.push(d); return () => {} } },
  systemPrompt: { context() {}, section() {} },
  on: () => () => {},
  effect: (fn) => { fn(); return () => {} },
  get: (name) => app.get(name),
  waterfall: async () => undefined,
  emit() {}
}
apply(ctxLike, { tools: ['sh'] })
const sh = tools.find((t) => t.name === 'sh')
if (sh === undefined) { console.log('sh 工具未注册'); process.exit(2) }

const exec = { agent: AGENT, signal: new AbortController().signal }

console.log('=== 真实链路：sh({ run_in_background: true }) ===')
const started = Date.now()
const value = await sh.execute({ command: 'sleep 15 && echo DONE', run_in_background: true, cwd: work }, exec)
const elapsed = Date.now() - started

console.log(`  耗时: ${elapsed}ms`)
console.log(`  background: ${value.background}`)
console.log(`  job_id: ${value.job_id ?? '(无)'}`)
console.log(`  exit_code: ${value.exit_code ?? '(无)'}`)

const immediate = elapsed < 3000
const hasJob = typeof value.job_id === 'string' && value.job_id !== ''
const ok = immediate && hasJob && value.background === true

console.log(immediate ? '  ✅ 立刻返回' : `  ❌ 仍阻塞 ${elapsed}ms`)
console.log(hasJob ? '  ✅ 拿到 job_id' : '  ❌ 没有 job_id（退回了同步执行）')

if (hasJob) {
  // 等一下再看进程是否真的在跑
  await new Promise((ok2) => setTimeout(ok2, 1500))
  const list = jobs.list(SESSION_ID)
  const mine = list.find((j) => j.id === value.job_id)
  console.log(`  作业状态（1.5s 后）: ${mine?.status ?? '(查不到)'}`)
  console.log(mine?.status === 'running' ? '  ✅ 作业确实在后台运行' : '  ⚠️ 状态不是 running')
  // 终止，避免留下进程
  try { await jobs.kill(value.job_id, SESSION_ID, 'test cleanup') } catch {}
  console.log('  已请求终止')
}

process.exit(ok ? 0 : 1)
