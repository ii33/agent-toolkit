/**
 * 工具可用性改造的自测：
 *   - read 默认不带行号（正文可直接进 edit 的 old_string）
 *   - edit-observation 只放行 FS_NOT_OBSERVED，其它拒绝原样抛
 *   - 能力清单上下文按启用项渲染，全关时为空
 * 运行：node test/tooling-ergonomics.test.mjs
 */
import assert from 'node:assert/strict'
import { applyEditObservation } from '../lib/edit-observation.js'
import { renderCapabilities } from '../lib/capabilities-context.js'

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`  ok  ${name}`)
}

async function acheck(name, fn) {
  await fn()
  passed += 1
  console.log(`  ok  ${name}`)
}

/** 最小 ctx：只提供 on/effect，用来观察瀑布包装行为。 */
function miniCtx() {
  const listeners = []
  const ctx = {
    on(event, listener) {
      listeners.push([event, listener])
      return () => {}
    },
    effect(fn) { fn() }
  }
  return { ctx, listeners }
}

console.log('edit-observation')

await acheck('FS_NOT_OBSERVED 被放行成 undefined（不加版本前提）', async () => {
  const { ctx, listeners } = miniCtx()
  assert.equal(applyEditObservation(ctx), true)
  const [, listener] = listeners.find(([e]) => e === 'fs/edit-intent')
  const gate = async () => {
    const error = new Error('edit requires reading "a.txt" first')
    error.code = 'FS_NOT_OBSERVED'
    throw error
  }
  assert.equal(await listener({ displayPath: 'a.txt' }, {}, gate), undefined)
})

await acheck('观测到的版本原样透传', async () => {
  const { ctx, listeners } = miniCtx()
  applyEditObservation(ctx)
  const [, listener] = listeners.find(([e]) => e === 'fs/edit-intent')
  assert.deepEqual(await listener({}, {}, async () => ({ version: 42 })), { version: 42 })
})

await acheck('FS_NOT_FOUND 继续抛出（不能靠放宽绕过存在性检查）', async () => {
  const { ctx, listeners } = miniCtx()
  applyEditObservation(ctx)
  const [, listener] = listeners.find(([e]) => e === 'fs/edit-intent')
  const gate = async () => { const e = new Error('not found'); e.code = 'FS_NOT_FOUND'; throw e }
  await assert.rejects(() => listener({}, {}, gate), /not found/)
})

await acheck('沙箱拒绝继续抛出', async () => {
  const { ctx, listeners } = miniCtx()
  applyEditObservation(ctx)
  const [, listener] = listeners.find(([e]) => e === 'fs/edit-intent')
  const gate = async () => { const e = new Error('sandbox denied'); e.code = 'FS_SANDBOX_DENIED'; throw e }
  await assert.rejects(() => listener({}, {}, gate), /sandbox denied/)
})

await acheck('没有 on() 的上下文安全降级', () => {
  assert.equal(applyEditObservation({}), false)
})

console.log('\ncapabilities-context')

check('列出已启用能力的工具名', () => {
  const text = renderCapabilities(['fs', 'sh', 'tasks'])
  assert.match(text, /- fs: read, read_many, write, edit, list_dir/)
  assert.match(text, /- sh: sh/)
  assert.match(text, /- tasks: plan_init/)
  assert.doesNotMatch(text, /- sftp:/)
})

check('全关时为空串（不产生提示词）', () => {
  assert.equal(renderCapabilities([]), '')
  assert.equal(renderCapabilities(['guard']), '')
  assert.equal(renderCapabilities(undefined), '')
})

check('明确要求优先用工具而不是 shell', () => {
  const text = renderCapabilities(['fs'])
  assert.match(text, /不要用 cat\/head\/tail\/sed -n/)
  assert.match(text, /numbered: true/)
  assert.match(text, /不要用 sed -i/)
})

console.log(`\n${passed} 项通过`)
