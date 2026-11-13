/**
 * 后台作业托管自测。
 * 运行：node test/job-adopt.test.mjs
 *
 * 覆盖两件在实机上出过问题的事：
 *   1. cancel 必须真的终止进程，不能只往输出里记一笔（实测过：只 append 时心跳继续）；
 *   2. 没挂 tool-jobs（无 controller）时要安静降级，不能抛 JOB_CONTROLLER_UNAVAILABLE。
 */
import assert from 'node:assert/strict'
import { adoptAsJob, jobControllerAvailable, startAsJob } from '../lib/job-adopt.js'

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`  ok  ${name}`)
}

const logger = { info() {}, warn() {}, error() {} }

/** 假 jobs 服务：记录 spec 并暴露 cancel。 */
function fakeJobs() {
  const state = { specs: [], appended: [], cancel: undefined, calls: 0 }
  return {
    state,
    service: {
      start(spec) {
        state.calls += 1
        state.specs.push(spec)
        const hooks = spec.run({ append: (t) => state.appended.push(t), updateProgress() {} })
        state.cancel = hooks.cancel
        state.done = hooks.done
        return `job-${state.calls}`
      }
    }
  }
}

const exec = { agent: { id: 'a1' } }

console.log('jobControllerAvailable')

check('没有 jobs 服务 → false', () => {
  assert.equal(jobControllerAvailable({ get: () => undefined }, undefined), false)
})

check('有 start 但没有 servesOwner → 乐观放行', () => {
  const svc = { start() {} }
  assert.equal(jobControllerAvailable({ get: () => svc }, svc), true)
})

check('servesOwner 明确返回 false → 不可用', () => {
  const svc = { start() {}, servesOwner: () => false }
  assert.equal(jobControllerAvailable({ get: () => svc }, svc), false)
})

check('servesOwner 抛错 → 乐观放行（由调用处兜底）', () => {
  const svc = { start() {}, servesOwner: () => { throw new Error('boom') } }
  assert.equal(jobControllerAvailable({ get: () => svc }, svc), true)
})

console.log('\nadoptAsJob')

check('托管成功返回作业 id', () => {
  const { service, state } = fakeJobs()
  const job = adoptAsJob({ get: () => service, logger }, exec, {
    label: 'sleep 600',
    cancelProcess: () => {},
    done: Promise.resolve({ exitCode: 0 })
  })
  assert.equal(job.id, 'job-1')
  assert.equal(state.specs[0].label, 'sleep 600')
})

check('cancel 会调用 cancelProcess（真正终止进程）', async () => {
  const { service, state } = fakeJobs()
  let killed = false
  adoptAsJob({ get: () => service, logger }, exec, {
    label: 'long',
    cancelProcess: () => { killed = true },
    done: new Promise(() => {})
  })
  await state.cancel()
  assert.equal(killed, true, 'cancel 必须终止进程，不能只记一笔')
})

check('子进程正常退出 → 作业状态 succeeded', async () => {
  const { service, state } = fakeJobs()
  adoptAsJob({ get: () => service, logger }, exec, {
    label: 'ok',
    cancelProcess: () => {},
    done: Promise.resolve({ exitCode: 0 })
  })
  assert.deepEqual(await state.done, { status: 'succeeded' })
})

check('取消导致退出 → 作业状态 killed', async () => {
  const { service, state } = fakeJobs()
  adoptAsJob({ get: () => service, logger }, exec, {
    label: 'killed',
    cancelProcess: () => {},
    done: Promise.resolve({ exitCode: 1, cancelled: true })
  })
  assert.deepEqual(await state.done, { status: 'killed' })
})

check('没有 controller 时返回 undefined（安静降级）', () => {
  const svc = { start() {}, servesOwner: () => false }
  const job = adoptAsJob({ get: () => svc, logger }, exec, {
    label: 'x', cancelProcess: () => {}, done: Promise.resolve({ exitCode: 0 })
  })
  assert.equal(job, undefined)
})

console.log('\nstartAsJob')

check('后台启动返回作业 id，不等待进程结束', () => {
  const { service, state } = fakeJobs()
  const job = startAsJob({ get: () => service, logger }, exec, {
    label: 'train',
    run: () => new Promise(() => {})   // 永不结束
  })
  assert.equal(job.id, 'job-1')
  assert.equal(state.specs[0].kind, 'process')
})

check('run 的输出通过 append 转给作业', async () => {
  const { service, state } = fakeJobs()
  startAsJob({ get: () => service, logger }, exec, {
    label: 'emit',
    run: async (emit) => { emit('epoch 1\n'); emit('epoch 2\n'); return { exitCode: 0 } }
  })
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(state.appended, ['epoch 1\n', 'epoch 2\n'])
})

check('job_kill 会调用 cancel', async () => {
  const { service, state } = fakeJobs()
  let cancelled = false
  startAsJob({ get: () => service, logger }, exec, {
    label: 'cancellable',
    cancel: () => { cancelled = true },
    run: () => new Promise(() => {})
  })
  await state.cancel()
  assert.equal(cancelled, true)
})

check('没有 jobs 服务时返回 undefined（调用方退回同步执行）', () => {
  const job = startAsJob({ get: () => undefined, logger }, exec, { label: 'x', run: async () => ({ exitCode: 0 }) })
  assert.equal(job, undefined)
})

console.log('\n候选工具都暴露 run_in_background')

check('sh / pwsh / run 的参数表里都有 run_in_background', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  process.env.DSH_AGENTKIT_STATE_DIR = mkdtempSync(join(tmpdir(), 'agentkit-jbg-'))

  const { apply } = await import('../index.js')
  for (const capability of ['sh', 'pwsh', 'run']) {
    const tools = []
    apply({
      logger,
      tools: { get: () => undefined, register: (d) => { tools.push(d); return () => {} } },
      systemPrompt: { context() {}, section() {} },
      on: () => () => {},
      effect: (fn) => { fn(); return () => {} },
      get: () => undefined,
      waterfall: async () => undefined,
      emit() {}
    }, { tools: [capability] })
    const tool = tools.find((t) => t.name === capability)
    assert.ok(tool, `${capability} 应注册`)
    assert.ok(tool.parameters.properties.run_in_background !== undefined,
      `${capability} 必须有 run_in_background 参数（与宿主约定同名）`)
  }
})

check('后台模式下退出码不是必填（进程还在跑）', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  process.env.DSH_AGENTKIT_STATE_DIR = mkdtempSync(join(tmpdir(), 'agentkit-jbg2-'))
  const { apply } = await import('../index.js')
  const tools = []
  apply({
    logger,
    tools: { get: () => undefined, register: (d) => { tools.push(d); return () => {} } },
    systemPrompt: { context() {}, section() {} },
    on: () => () => {},
    effect: (fn) => { fn(); return () => {} },
    get: () => undefined,
    waterfall: async () => undefined,
    emit() {}
  }, { tools: ['sh'] })
  const sh = tools.find((t) => t.name === 'sh')
  assert.ok(!sh.output.schema.required.includes('exit_code'), '后台模式没有 exit_code，不能列为必填')
  assert.ok(sh.output.schema.properties.job_id !== undefined, '要能返回 job_id')
})

console.log(`\n${passed} 项通过`)
