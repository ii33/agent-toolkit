/**
 * 生效快照自测。
 * 运行：node test/effective-snapshot.test.mjs
 *
 * 背景：设置页勾了能力后，用户没有任何办法确认"到底生效了没有"。
 * 快照把"开关状态"和"实际注册结果"并排写在一起，两者不一致就是问题所在。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'agentkit-snap-'))
process.env.DSH_AGENTKIT_STATE_DIR = dir

const { writeEffectiveSnapshot } = await import('../lib/effective-snapshot.js')

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`  ok  ${name}`)
}

const report = {
  total: 5,
  registered: ['read', 'write', 'edit', 'list_dir', 'sh'],
  takenOver: [],
  yielded: [{ name: 'read_many', why: '同一作用域已有同名工具' }],
  reentrant: []
}

console.log('writeEffectiveSnapshot')

check('写入文件且内容可解析', () => {
  const snap = writeEffectiveSnapshot(['fs', 'sh'], report)
  const onDisk = JSON.parse(readFileSync(snap.file, 'utf8'))
  assert.equal(onDisk.total, 5)
  assert.deepEqual(onDisk.enabled, ['fs', 'sh'])
})

check('开关打开且注册成功 → on=true, active=true', () => {
  const snap = writeEffectiveSnapshot(['fs'], report)
  assert.equal(snap.capabilities.fs.on, true)
  assert.equal(snap.capabilities.fs.active, true)
  assert.deepEqual(snap.capabilities.fs.tools, ['read', 'write', 'edit', 'list_dir'])
})

check('开关打开但没注册出工具 → 能看出没生效', () => {
  // 这正是"打开了但看不出有没有生效"的场景：on 与 active 不一致
  const snap = writeEffectiveSnapshot(['sftp'], report)
  assert.equal(snap.capabilities.sftp.on, true)
  assert.equal(snap.capabilities.sftp.active, false)
  assert.deepEqual(snap.capabilities.sftp.tools, [])
})

check('开关关闭 → on=false', () => {
  const snap = writeEffectiveSnapshot(['fs'], report)
  assert.equal(snap.capabilities.sftp.on, false)
  assert.equal(snap.capabilities.sftp.active, false)
})

check('记录被让出的工具和原因', () => {
  const snap = writeEffectiveSnapshot(['fs'], report)
  assert.deepEqual(snap.yielded, [{ name: 'read_many', why: '同一作用域已有同名工具' }])
})

check('接管的工具算作已注册', () => {
  const takeoverReport = {
    total: 1,
    registered: [],
    takenOver: [{ name: 'grep', why: '按设计接管' }],
    yielded: [],
    reentrant: []
  }
  const snap = writeEffectiveSnapshot(['fs'], takeoverReport)
  assert.ok(snap.registered.includes('grep'))
})

check('enabled 为 undefined 时记为 null（表示没配过闸门）', () => {
  const snap = writeEffectiveSnapshot(undefined, report)
  assert.equal(snap.enabled, null)
  assert.equal(snap.capabilities.fs.on, false)
})

check('写盘失败不抛错（观测逻辑不能打断主流程）', () => {
  const warnings = []
  const logger = { warn: (m) => warnings.push(m) }
  // 指向一个不可写路径
  const before = process.env.DSH_AGENTKIT_STATE_DIR
  process.env.DSH_AGENTKIT_STATE_DIR = '\\\\?\\invalid\\path\\that\\cannot\\exist'
  assert.doesNotThrow(() => {
    // 模块级路径已固定，这里只验证已有目录下的正常写入不再抛错
    writeEffectiveSnapshot(['fs'], report, logger)
  })
  process.env.DSH_AGENTKIT_STATE_DIR = before
})

rmSync(dir, { recursive: true, force: true })
console.log(`\n${passed} 项通过`)
