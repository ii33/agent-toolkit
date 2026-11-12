/**
 * 闸门对账自测：设置页关掉的能力，必须从预设能力表里同步移除。
 * 运行：node test/gate-reconcile.test.mjs
 *
 * 背景：此前只有注册时的 `settingsGate()` 生效，预设补丁里的 `tools: [...]`
 * 原样不动 —— 关掉能力后配置仍宣传它，只能人工去 YAML 里删。
 */
import assert from 'node:assert/strict'
import { reconcileCapabilities, reconcileEdits } from '../lib/gate-reconcile.js'

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`  ok  ${name}`)
}

const ALL = ['fs', 'sftp', 'doc', 'split', 'img', 'tasks', 'preset']

console.log('reconcileCapabilities')

check('闸门关掉的能力被移除，顺序保持', () => {
  const r = reconcileCapabilities(ALL, ['fs', 'tasks', 'preset'])
  assert.deepEqual(r.capabilities, ['fs', 'tasks', 'preset'])
  assert.deepEqual(r.removed, ['sftp', 'doc', 'split', 'img'])
  assert.equal(r.changed, true)
})

check('闸门不设（undefined）时原样保留，绝不裁剪', () => {
  const r = reconcileCapabilities(ALL, undefined)
  assert.deepEqual(r.capabilities, ALL)
  assert.deepEqual(r.removed, [])
  assert.equal(r.changed, false)
})

check('只裁剪、不新增：闸门开着但预设没声明的不会被加进来', () => {
  const r = reconcileCapabilities(['fs'], ['fs', 'sftp', 'doc'])
  assert.deepEqual(r.capabilities, ['fs'])
  assert.equal(r.changed, false)
})

check('闸门全关（空数组）时清空', () => {
  const r = reconcileCapabilities(ALL, [])
  assert.deepEqual(r.capabilities, [])
  assert.deepEqual(r.removed, ALL)
  assert.equal(r.changed, true)
})

check('本来就一致时不产生变更（幂等）', () => {
  const r = reconcileCapabilities(['fs', 'sh'], ['fs', 'sh', 'tasks'])
  assert.equal(r.changed, false)
  assert.deepEqual(r.removed, [])
})

check('非数组输入安全降级', () => {
  assert.deepEqual(reconcileCapabilities(undefined, ['fs']).capabilities, [])
  assert.deepEqual(reconcileCapabilities(null, undefined).capabilities, [])
})

console.log('\nreconcileEdits')

check('只对受管预设动手，未列出的不碰', () => {
  const edits = {
    generic: { capabilities: ['fs', 'sftp', 'doc'], persona: 'x' },
    other: { capabilities: ['sftp'] }
  }
  const { edits: next, fixed } = reconcileEdits(edits, ['fs'], ['generic'])
  assert.deepEqual(next.generic.capabilities, ['fs'])
  assert.equal(next.generic.persona, 'x', '其它字段必须保留')
  assert.deepEqual(next.other.capabilities, ['sftp'], '非受管预设保持不变')
  assert.deepEqual(fixed, [{ preset: 'generic', removed: ['sftp', 'doc'] }])
})

check('闸门为 undefined 时完全不动', () => {
  const edits = { generic: { capabilities: ['sftp'] } }
  const { edits: next, fixed } = reconcileEdits(edits, undefined, ['generic'])
  assert.deepEqual(next.generic.capabilities, ['sftp'])
  assert.deepEqual(fixed, [])
})

check('预设不存在时跳过', () => {
  const { edits: next, fixed } = reconcileEdits({}, ['fs'], ['generic'])
  assert.deepEqual(next, {})
  assert.deepEqual(fixed, [])
})

check('没有 capabilities 字段（只改了 persona）时不报变更', () => {
  const { fixed } = reconcileEdits({ generic: { persona: 'only persona' } }, ['fs'], ['generic'])
  assert.deepEqual(fixed, [])
})

console.log(`\n${passed} 项通过`)
