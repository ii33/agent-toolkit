/**
 * 账本按会话隔离自测。
 * 运行：node test/tasks-isolation.test.mjs
 *
 * 背景：默认账本曾是固定 `TASKS.md`，同一工作目录下的所有会话共用同一个文件，
 * 多个会话并行会互相覆盖目标/阶段/任务 —— 表现为"每个会话最后都变成同一个会话"。
 */
import assert from 'node:assert/strict'
import { defaultLedgerPath } from '../tools/tasks.js'

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`  ok  ${name}`)
}

const execOf = (sessionId) => ({
  agent: { session: { id: sessionId, header: { cwd: 'C:/work' } } }
})

console.log('defaultLedgerPath')

check('不同会话得到不同路径', () => {
  const a = defaultLedgerPath(execOf('session-a'))
  const b = defaultLedgerPath(execOf('session-b'))
  assert.notEqual(a, b, '两个会话绝不能共用同一个账本')
  assert.equal(a, '.dsh/tasks/session-a.md')
  assert.equal(b, '.dsh/tasks/session-b.md')
})

check('同一会话始终得到同一路径（跨轮次/跨重启稳定）', () => {
  assert.equal(defaultLedgerPath(execOf('session-a')), defaultLedgerPath(execOf('session-a')))
})

check('路径落在工作区内的 .dsh/tasks 下', () => {
  const p = defaultLedgerPath(execOf('x'))
  assert.ok(p.startsWith('.dsh/tasks/'), '应是工作区内的相对路径，便于人查看')
  assert.ok(p.endsWith('.md'))
})

check('不再使用固定的 TASKS.md', () => {
  assert.notEqual(defaultLedgerPath(execOf('any')), 'TASKS.md')
})

check('拿不到 sessionId 时安全退回 TASKS.md（不抛错）', () => {
  assert.equal(defaultLedgerPath({}), 'TASKS.md')
  assert.equal(defaultLedgerPath(undefined), 'TASKS.md')
  assert.equal(defaultLedgerPath({ agent: {} }), 'TASKS.md')
  assert.equal(defaultLedgerPath({ agent: { session: {} } }), 'TASKS.md')
  assert.equal(defaultLedgerPath({ agent: { session: { id: '' } } }), 'TASKS.md')
})

console.log(`\n${passed} 项通过`)
