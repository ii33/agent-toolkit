/**
 * 沙箱提权与围栏自检测试（用假 ctx）。
 *
 * 运行：node test/sandbox.test.mjs
 */
import assert from 'node:assert/strict'
import {
  ESCALATION_TARGETS,
  assertPathAllowed,
  escalationSchemaFields,
  resolveWritePolicy,
  validateEscalationArgs,
  withSandboxHint
} from '../lib/sandbox.js'

let passed = 0
async function check(name, fn) {
  await fn()
  passed += 1
  console.log(`  ok  ${name}`)
}

/** 造一个假 ctx：可控制围栏事实、当前模式、审批结果。 */
function harness({ sandboxMode = 'workspace-write', mode = 'workspace-write', outcome = 'allowed-once', approval = true } = {}) {
  const requests = []
  const ctx = {
    fs: {
      sandboxMode,
      resolve: async (path) => ({ targetKey: 'k', displayPath: path }),
      contains: (parent, child) => child.displayPath.startsWith(parent.displayPath)
    },
    get: (name) => {
      if (name === 'sandboxPolicy') return { resolve: () => ({ mode, workspaceRoot: 'C:/ws' }) }
      if (name === 'approval') {
        return approval ? { request: async (request) => { requests.push(request); return outcome } } : undefined
      }
      return undefined
    }
  }
  const exec = { signal: undefined, agent: { id: 'a' }, callId: 'c1' }
  return { ctx, exec, requests }
}

console.log('sandbox')

await check('提权参数只在有围栏后端时广告', () => {
  assert.deepEqual(Object.keys(escalationSchemaFields({ fs: {} })), [])
  const fields = escalationSchemaFields({ fs: { sandboxMode: 'workspace-write' } })
  assert.deepEqual(Object.keys(fields).sort(), ['justification', 'sandbox_permissions'])
  assert.deepEqual(fields.sandbox_permissions.enum, ESCALATION_TARGETS)
})

await check('参数必须成对、模式合法、理由非空', () => {
  assert.doesNotThrow(() => validateEscalationArgs(undefined, undefined))
  assert.throws(() => validateEscalationArgs('workspace-write', undefined), /必须同时提供/)
  assert.throws(() => validateEscalationArgs(undefined, '因为要写工作区外'), /必须同时提供/)
  assert.throws(() => validateEscalationArgs('read-only', '理由'), /只能是/)
  assert.throws(() => validateEscalationArgs('workspace-write', '   '), /不能是空字符串/)
})

await check('不带提权参数时直接返回当前策略', async () => {
  const { ctx, exec, requests } = harness()
  const policy = await resolveWritePolicy(ctx, exec, {}, 'write')
  assert.equal(policy.mode, 'workspace-write')
  assert.equal(requests.length, 0)
})

await check('带提权参数且获批准 → 策略模式放宽', async () => {
  const { ctx, exec, requests } = harness({ mode: 'read-only' })
  const policy = await resolveWritePolicy(ctx, exec, { sandbox_permissions: 'workspace-write', justification: '目标在工作区外' }, 'write')
  assert.equal(policy.mode, 'workspace-write')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].toolName, 'write')
  assert.match(requests[0].reason, /read-only → workspace-write/)
})

await check('未获批准 → 拒绝执行并给出可执行提示', async () => {
  const { ctx, exec } = harness({ mode: 'read-only', outcome: 'rejected' })
  await assert.rejects(
    () => resolveWritePolicy(ctx, exec, { sandbox_permissions: 'workspace-write', justification: 'x' }, 'write'),
    /提权未获批准（rejected）/
  )
})

await check('只能申请更宽的模式', async () => {
  const { ctx, exec } = harness({ mode: 'danger-full-access' })
  await assert.rejects(
    () => resolveWritePolicy(ctx, exec, { sandbox_permissions: 'workspace-write', justification: 'x' }, 'write'),
    /只能申请比当前模式/
  )
})

await check('没有审批通道时明确报错', async () => {
  const { ctx, exec } = harness({ mode: 'read-only', approval: false })
  await assert.rejects(
    () => resolveWritePolicy(ctx, exec, { sandbox_permissions: 'workspace-write', justification: 'x' }, 'write'),
    /需要审批通道/
  )
})

await check('围栏自检：read-only 一律拒绝写入', async () => {
  const { ctx } = harness({ mode: 'read-only' })
  await assert.rejects(
    () => assertPathAllowed(ctx, { mode: 'read-only', workspaceRoot: 'C:/ws' }, { displayPath: 'C:/ws/a.txt' }),
    /沙箱拒绝：read-only/
  )
})

await check('围栏自检：workspace-write 要求在工作区内', async () => {
  const { ctx } = harness()
  const policy = { mode: 'workspace-write', workspaceRoot: 'C:/ws' }
  await assertPathAllowed(ctx, policy, { displayPath: 'C:/ws/a.txt' })
  await assert.rejects(() => assertPathAllowed(ctx, policy, { displayPath: 'C:/outside/a.txt' }), /不在工作区/)
})

await check('围栏自检：danger-full-access 不限制', async () => {
  const { ctx } = harness()
  await assertPathAllowed(ctx, { mode: 'danger-full-access', workspaceRoot: 'C:/ws' }, { displayPath: 'C:/anywhere/a.txt' })
})

await check('沙箱拒绝被翻译成可重试一次的提示', () => {
  const denied = Object.assign(new Error('cannot write'), { code: 'FS_SANDBOX_DENIED' })
  const mapped = withSandboxHint(denied, { mode: 'workspace-write' })
  assert.match(mapped.message, /沙箱拒绝：当前模式 workspace-write/)
  assert.match(mapped.message, /sandbox_permissions/)
  const other = new Error('磁盘满了')
  assert.equal(withSandboxHint(other, { mode: 'workspace-write' }), other)
})

console.log(`\n${passed} 项通过`)
