/**
 * SFTP 侧车协议测试：用 --self-test 模式（内存后端）走真实管道，
 * 验证 JSON 行协议、base64 传输、缺失文件语义与生命周期，无需真实主机。
 *
 * 运行：node test/sftp.test.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { pythonScript } from './deps.mjs'

const SIDECAR = fileURLToPath(new URL('../tools/sftp_sidecar.py', import.meta.url))
const PY = pythonScript(SIDECAR)

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`  ok  ${name}`)
}

/** 一次性把请求喂给侧车，返回按 id 索引的响应。 */
function talk(requests) {
  const input = `${requests.map((request) => JSON.stringify(request)).join('\n')}\n`
  const result = spawnSync(PY.command, [PY.script, '--self-test'], {
    cwd: PY.cwd,
    input,
    encoding: 'utf8',
    timeout: 60_000
  })
  assert.equal(result.status, 0, `侧车退出码 ${result.status}: ${result.stderr ?? ''}`)
  const responses = new Map()
  for (const line of result.stdout.split('\n')) {
    if (line.trim() === '') continue
    const message = JSON.parse(line)
    responses.set(message.id, message)
  }
  return responses
}

console.log('sftp sidecar')

check('ping / stat / list / read / write / close 全链路', () => {
  const responses = talk([
    { id: 1, op: 'ping' },
    { id: 2, op: 'stat', path: '/readme.md' },
    { id: 3, op: 'list', path: '/' },
    { id: 4, op: 'read', path: '/readme.md' },
    { id: 5, op: 'write', path: '/new.txt', data: Buffer.from('hello', 'utf8').toString('base64') },
    { id: 6, op: 'read', path: '/new.txt' },
    { id: 7, op: 'close' },
    { id: 8, op: 'shutdown' }
  ])

  assert.equal(responses.get(1).ok, true)
  assert.equal(responses.get(1).pong, true)

  assert.equal(responses.get(2).ok, true)
  assert.equal(responses.get(2).info.type, 'file')
  assert.ok(responses.get(2).info.size > 0)

  const entries = responses.get(3).entries
  assert.ok(entries.some((entry) => entry.name === 'readme.md' && entry.type === 'file'))
  assert.ok(entries.some((entry) => entry.name === 'sub' && entry.type === 'dir'))

  const read = Buffer.from(responses.get(4).data, 'base64').toString('utf8')
  assert.match(read, /^# hello\n中文\n$/u)

  assert.equal(responses.get(5).ok, true)
  assert.equal(responses.get(5).bytes, 5)
  assert.equal(Buffer.from(responses.get(6).data, 'base64').toString('utf8'), 'hello')

  assert.equal(responses.get(7).ok, true)
  assert.equal(responses.get(8).ok, true)
})

check('缺失文件返回 info=null（而不是报错）', () => {
  const responses = talk([
    { id: 1, op: 'stat', path: '/nope.txt' },
    { id: 2, op: 'shutdown' }
  ])
  assert.equal(responses.get(1).ok, true)
  assert.equal(responses.get(1).info, null)
})

check('范围读（用于只取文件头）', () => {
  const responses = talk([
    { id: 1, op: 'read', path: '/readme.md', offset: 2, length: 5 },
    { id: 2, op: 'shutdown' }
  ])
  assert.equal(responses.get(1).ok, true)
  assert.equal(Buffer.from(responses.get(1).data, 'base64').toString('utf8'), 'hello')
  assert.equal(responses.get(1).size, 5)
})

check('坏 JSON 与未知 op 都被转成响应而不是崩溃', () => {
  const input = '{"id":1,"op":"ping"}\nnot json\n{"id":2,"op":"nope"}\n{"id":3,"op":"shutdown"}\n'
  const result = spawnSync(PY.command, [PY.script, '--self-test'], { cwd: PY.cwd, input, encoding: 'utf8', timeout: 60_000 })
  assert.equal(result.status, 0)
  const lines = result.stdout.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line))
  assert.equal(lines.length, 4)
  assert.equal(lines[1].ok, false)
  assert.match(lines[1].error, /bad json/)
  assert.equal(lines[2].ok, false)
  assert.equal(lines[2].code, 'BAD_OP')
  assert.equal(lines[3].ok, true)
})

check('asyncssh 缺失时报 MISSING_DEP（而不是崩溃或沉默）', () => {
  const input = '{"id":1,"op":"ping"}\n{"id":2,"op":"shutdown"}\n'
  const result = spawnSync(PY.command, [PY.script, '--simulate-missing-dep', '--auto-install', '0', '--host', 'example.invalid'], {
    cwd: PY.cwd,
    input,
    encoding: 'utf8',
    timeout: 60_000
  })
  assert.equal(result.status, 0)
  assert.match(result.stderr, /asyncssh: unavailable/)
  const lines = result.stdout.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line))
  assert.equal(lines[0].ok, false)
  assert.equal(lines[0].code, 'MISSING_DEP')
  assert.match(lines[0].error, /asyncssh/)
})

console.log(`\n${passed} 项通过`)
