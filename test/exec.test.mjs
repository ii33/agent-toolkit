/**
 * 运行期测试：用假 subprocess 验证执行核心（lib/exec.js）与 run / sh 的 argv 形状。
 * 重点验证：子进程输出按 GBK 正确解码（Windows 中文程序不再乱码）、退出码透传、参数校验。
 *
 * 运行：node test/exec.test.mjs
 */
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { execCapture } from '../lib/exec.js'
import { apply as applyRun } from '../tools/run.js'
import { apply as applySh } from '../tools/sh.js'

let passed = 0
async function check(name, fn) {
  await fn()
  passed += 1
  console.log(`  ok  ${name}`)
}

/** 造一个假 subprocess：可指定 stdout 原始字节、stderr 字节与退出码，并记录收到的 spec。 */
function fakeSubprocess({ stdoutBytes = [], stderrBytes = [], exitCode = 0 } = {}) {
  const calls = []
  return {
    calls,
    service: {
      // 绝对路径原样返回，裸名字才补 .exe（与真实 resolveExecutable 语义一致）
      resolveExecutable: async (name) => (/[\\/]/u.test(name) ? name : `C:/fake/${name}.exe`),
      spawn: (spec) => {
        calls.push(spec)
        return {
          stdin: undefined,
          stdout: Readable.from(stdoutBytes.map((bytes) => Buffer.from(bytes))),
          stderr: Readable.from(stderrBytes.map((bytes) => Buffer.from(bytes))),
          control: undefined,
          collected: {},
          done: Promise.resolve({ exitCode, signal: null }),
          terminate: () => {},
          waitForExit: async () => true
        }
      }
    }
  }
}

/** 收集 apply() 注册的工具。 */
function collectTools(apply, ctx) {
  const tools = []
  apply({ ...ctx, tools: { register: (definition) => { tools.push(definition); return () => {} } } })
  return tools
}

console.log('exec')

await check('GBK 子进程输出被正确解码', async () => {
  const fake = fakeSubprocess({ stdoutBytes: [[0xd6, 0xd0, 0xce, 0xc4, 0x21]] }) // "中文!"
  const ctx = { get: (name) => (name === 'subprocess' ? fake.service : undefined) }
  const result = await execCapture(ctx, { signal: undefined }, { argv: ['x'], cwd: 'C:/a', timeoutMs: 5000 })
  assert.equal(result.exitCode, 0)
  assert.equal(result.output, '中文!')
  assert.equal(result.timedOut, false)
  assert.equal(result.truncated, false)
})

await check('stderr 被单独标注，非零退出码透传', async () => {
  const fake = fakeSubprocess({ stdoutBytes: [[0x6f, 0x6b]], stderrBytes: [[0x62, 0x61, 0x64]], exitCode: 3 })
  const ctx = { get: (name) => (name === 'subprocess' ? fake.service : undefined) }
  const result = await execCapture(ctx, { signal: undefined }, { argv: ['x'], cwd: 'C:/a', timeoutMs: 5000 })
  assert.equal(result.exitCode, 3)
  assert.match(result.output, /^ok/)
  assert.match(result.output, /\[stderr\]\nbad/)
})

await check('环境变量注入 pip 镜像与 UTF-8 编码', async () => {
  const fake = fakeSubprocess({})
  const ctx = { get: (name) => (name === 'subprocess' ? fake.service : undefined) }
  await execCapture(ctx, { signal: undefined }, { argv: ['x'], cwd: 'C:/a', timeoutMs: 5000 })
  const spec = fake.calls[0]
  assert.equal(spec.env.PYTHONIOENCODING, 'utf-8')
  assert.equal(spec.env.PYTHONUTF8, '1')
  assert.match(spec.env.PIP_INDEX_URL, /^https:\/\//)
  assert.equal(spec.env.PIP_TRUSTED_HOST, new URL(spec.env.PIP_INDEX_URL).host)
  assert.equal(spec.stdio.stdin, 'ignore')
})

console.log('run / sh')

await check('run 用 argv 直连，不经过 shell', async () => {
  const fake = fakeSubprocess({ stdoutBytes: [[0x68, 0x69]] })
  const ctx = { get: (name) => (name === 'subprocess' ? fake.service : undefined) }
  const tools = collectTools(applyRun, ctx)
  const run = tools.find((tool) => tool.name === 'run')
  const value = await run.execute({ program: 'python', args: ['-c', 'print(1)'] }, { signal: undefined, agent: { session: { header: { cwd: 'C:/a' } } } })
  assert.equal(value.exit_code, 0)
  assert.deepEqual(fake.calls[0].argv, ['C:/fake/python.exe', '-c', 'print(1)'])
})

await check('run 拒绝含 NUL 的参数', async () => {
  const fake = fakeSubprocess({})
  const ctx = { get: (name) => (name === 'subprocess' ? fake.service : undefined) }
  const run = collectTools(applyRun, ctx).find((tool) => tool.name === 'run')
  await assert.rejects(
    () => run.execute({ program: 'python', args: ['a\u0000b'] }, { signal: undefined, agent: { session: { header: { cwd: 'C:/a' } } } }),
    /NUL/
  )
})

await check('sh 走 bash -c，且能定位到 MSYS2 bash', async () => {
  const fake = fakeSubprocess({ stdoutBytes: [[0x6f, 0x6b]] })
  const ctx = { get: (name) => (name === 'subprocess' ? fake.service : undefined) }
  const sh = collectTools(applySh, ctx).find((tool) => tool.name === 'sh')
  const value = await sh.execute({ command: 'ls -la | head -3' }, { signal: undefined, agent: { session: { header: { cwd: 'C:/a' } } } })
  assert.equal(value.exit_code, 0)
  assert.equal(fake.calls[0].argv[1], '-c')
  assert.equal(fake.calls[0].argv[2], 'ls -la | head -3')
  assert.match(fake.calls[0].argv[0], /bash\.exe$/i)
})

console.log(`\n${passed} 项通过`)
