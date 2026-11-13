/**
 * 工具可用性改造的自测：
 *   - read 默认不带行号（正文可直接进 edit 的 old_string）
 *   - edit-observation 只放行 FS_NOT_OBSERVED，其它拒绝原样抛
 *   - 能力清单上下文按启用项渲染，全关时为空
 * 运行：node test/tooling-ergonomics.test.mjs
 */
import assert from 'node:assert/strict'
import { applyEditObservation } from '../lib/edit-observation.js'
import { applyCapabilitiesContext, renderCapabilities } from '../lib/capabilities-context.js'

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
  assert.equal(renderCapabilities(undefined), '')
  // 注意：['guard'] 不再为空 —— guard 不注册工具，但纪律条款仍要出现，见下方专项用例。
})

check('传入注册报告时只列实际注册成功的工具', () => {
  // fs 能力声明 5 个工具，但 write 被让出（出货工具占用）、list_dir 重入跳过
  const report = { registered: ['read', 'read_many', 'edit'], takenOver: [], yielded: ['write'], reentrant: ['list_dir'] }
  const text = renderCapabilities(['fs'], report)
  assert.match(text, /- fs: read, read_many, edit/)
  assert.doesNotMatch(text, /write/, '被让出的工具不能出现在提示词里')
  assert.doesNotMatch(text, /list_dir/, '重入跳过的工具不能出现在提示词里')
})

check('能力被关闭时该能力整行消失', () => {
  const report = { registered: ['read', 'edit', 'sh'], takenOver: [], yielded: [], reentrant: [] }
  const text = renderCapabilities(['fs', 'sh'], report)
  assert.match(text, /- fs: read, edit/)
  assert.match(text, /- sh: sh/)
  assert.doesNotMatch(text, /- sftp:/)
  assert.doesNotMatch(text, /- tasks:/)
})

check('某能力的工具全被让出时整行不出现', () => {
  const report = { registered: [], takenOver: [], yielded: ['read', 'read_many', 'write', 'edit', 'list_dir'], reentrant: [] }
  const text = renderCapabilities(['fs'], report)
  assert.doesNotMatch(text, /- fs:/, '全被让出时不应列出 fs 行')
  assert.match(text, /发现工具出错，及时提出/, '但纪律条款仍要在')
})

check('接管（takenOver）的工具算作可用', () => {
  const report = { registered: [], takenOver: ['read'], yielded: [], reentrant: [] }
  assert.match(renderCapabilities(['fs'], report), /- fs: read/)
})

console.log('\napplyCapabilitiesContext 动态性')

check('注册的 text 是函数且每次按当前能力重算', () => {
  const registered = []
  const ctx = { systemPrompt: { context: (entry) => registered.push(entry) } }
  assert.equal(applyCapabilitiesContext(ctx, ['fs', 'sh']), true)
  const entry = registered[0]
  assert.equal(entry.name, 'agentkit:capabilities')
  assert.equal(typeof entry.text, 'function', '必须动态求值：静态字符串会把已关闭的能力留在旧会话提示词里')
  const first = entry.text({ scope: {} })
  assert.match(first, /- sh: sh/)
  // 模拟"能力被关掉"后重新渲染（旧会话下一轮）
  const narrower = renderCapabilities(['fs'])
  assert.doesNotMatch(narrower, /- sh:/)
})

check('能力全关时不注册上下文', () => {
  const registered = []
  const ctx = { systemPrompt: { context: (entry) => registered.push(entry) } }
  // guard 不注册任何工具，但纪律条款仍要挂上 → 返回 true
  assert.equal(applyCapabilitiesContext(ctx, ['guard']), true)
  assert.equal(registered.length, 1)
  assert.match(registered[0].text({ scope: {} }), /发现工具出错，及时提出/)
  // 真正的"全关"（空数组）才不注册
  assert.equal(applyCapabilitiesContext(ctx, []), false)
  assert.equal(registered.length, 1)
})

check('明确要求优先用工具而不是 shell', () => {
  const text = renderCapabilities(['fs'])
  assert.match(text, /不要用 cat\/head\/tail\/sed -n/)
  assert.match(text, /numbered: true/)
  assert.match(text, /不要用 sed -i/)
})

check('措辞限定作用域，不暗示"这是全部工具"', () => {
  const text = renderCapabilities(['fs', 'sh'])
  // 曾经写「其余能力未启用，不要尝试」，被模型读成"本会话工具全集"，
  // 据此误判 subagent / grep / glob / web_search 不可用而放弃委派。
  assert.doesNotMatch(text, /其余能力未启用/, '不能断言其它来源的工具不可用')
  assert.doesNotMatch(text, /不要尝试/, '不能阻止模型使用本清单之外的工具')
  assert.match(text, /仅描述本插件自己注册的工具/)
  assert.match(text, /其它来源的工具照常可用/)
  assert.match(text, /以你实际看到的工具列表为准/)
})

check('提示检索结果需用 path 限定范围', () => {
  const text = renderCapabilities(['fs'])
  assert.match(text, /glob \/ grep/)
  assert.match(text, /path 限定/)
  assert.match(text, /缓存目录|历史快照/, '要点明污染来源')
})

check('不为本插件不提供的工具写建议（如 grep）', () => {
  // grep/glob 由预设的 search-tools 行提供，不在本能力表里。
  // 早先写 has('grep') 恒为 false，那条建议永远不出现，还容易误导归属。
  const text = renderCapabilities(['fs', 'sh'])
  assert.doesNotMatch(text, /^- 搜内容用 grep/m, '不应声称 grep 是本插件的工具')
})

check('纪律条款：发现工具出错要及时提出', () => {
  const text = renderCapabilities(['fs'])
  assert.match(text, /发现工具出错，及时提出/)
  assert.match(text, /直接调用一次看结果，以调用结果为准/, '必须给出实测优先于描述的指令')
  assert.match(text, /按实测继续/, '发现不一致时不能被描述卡住')
  assert.match(text, /立刻在回复里指出来/, '必须主动上报，不能默默绕过')
})

check('纪律条款始终存在（本插件无工具时也出现）', () => {
  const report = { registered: [], takenOver: [], yielded: [], reentrant: [] }
  const text = renderCapabilities(['guard'], report)
  assert.match(text, /发现工具出错，及时提出/, 'guard 不注册工具，但纪律仍要出现')
})

check('空能力列表仍返回空串（不注册上下文）', () => {
  // 与"有 guard 但无工具"区分：完全没能力时不产生任何提示词
  assert.equal(renderCapabilities([]), '')
  assert.equal(renderCapabilities(undefined), '')
})

console.log(`\n${passed} 项通过`)
