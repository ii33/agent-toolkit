/**
 * SFTP 的 JS 管道测试：设置文件 → 拉起侧车进程 → JSON 行协议 → 远程读写。
 *
 * 用侧车的 `--self-test` 内存后端当"远程主机"，因此不需要网络与凭据，
 * 但走的仍是真实进程、真实管道、真实协议编解码。
 *
 * 运行：node test/remote.test.mjs
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { apply as applySftp } from '../tools/sftp.js'
import { closeAllSessions, remoteList, remoteReadBytes, remoteStat, remoteWriteBytes, resolveRemote } from '../lib/remote.js'

let passed = 0
async function check(name, fn) {
  await fn()
  passed += 1
  console.log(`  ok  ${name}`)
}

/** 设置文件内容：一台自检主机。 */
const SETTINGS = JSON.stringify({
  sftp: { hosts: { selftest: { host: 'unused', user: 'nobody', root: '/', self_test: true, idle_seconds: 60 } } }
})

/**
 * 造一个假 ctx：fs 只提供设置文件读取；subprocess 用真实进程 + 真实管道。
 * @returns {object} 上下文与工具表。
 */
function harness() {
  const tools = []
  const fakeFs = {
    resolve: async (path) => ({ targetKey: 'k', displayPath: `C:/ws/${path}` }),
    stat: async () => ({ version: 'v1', type: 'file', size: SETTINGS.length }),
    readText: async () => SETTINGS,
    readByteRange: async () => new TextEncoder().encode(SETTINGS),
    // 侧车进程需要一个**真实存在**的工作目录，否则 Windows 上 spawn 直接 ENOENT
    processPath: () => process.cwd(),
    writeText: async () => ({ operation: 'update', version: 'v2' }),
    listDir: async () => []
  }
  const subprocess = {
    resolveExecutable: async (name) => {
      if (name === 'python' || name === 'python3') return 'python'
      throw new Error(`not found: ${name}`)
    },
    spawn: (spec) => {
      const child = spawn(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        env: spec.env,
        stdio: ['pipe', 'pipe', 'pipe']
      })
      const done = new Promise((resolve) => {
        child.once('exit', (code, signal) => resolve({ exitCode: code, signal: signal ?? null }))
      })
      return {
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        done,
        terminate: () => child.kill(),
        waitForExit: async () => true
      }
    }
  }
  const ctx = {
    fs: fakeFs,
    tools: { register: (definition) => { tools.push(definition); return () => {} } },
    systemPrompt: { context: () => () => {} },
    on: () => () => {},
    effect: (fn) => fn(),
    get: (name) => (name === 'subprocess' ? subprocess : undefined),
    logger: { info: () => {} },
    waterfall: async (_name, _target, _exec, fallback) => fallback(),
    emit: () => {}
  }
  applySftp(ctx)
  const exec = { signal: undefined, agent: { session: { header: { cwd: 'C:/ws' } } } }
  return { ctx, exec, tools }
}

const decode = (bytes) => Buffer.from(bytes).toString('utf8')

console.log('sftp js pipeline')

const { ctx, exec, tools } = harness()

await check('代号解析：selftest:/readme.md 命中配置里的主机', async () => {
  const remote = await resolveRemote(ctx, exec, 'selftest:/readme.md')
  assert.ok(remote !== undefined, '应当解析为远程目标')
  assert.equal(remote.code, 'selftest')
  assert.equal(remote.remotePath, '/readme.md')
  assert.equal(remote.displayPath, 'selftest:/readme.md')
})

await check('未配置的代号按本地路径处理（不误判）', async () => {
  assert.equal(await resolveRemote(ctx, exec, 'nope:/x.md'), undefined)
  assert.equal(await resolveRemote(ctx, exec, 'C:\\temp\\a.md'), undefined)
  assert.equal(await resolveRemote(ctx, exec, 'a.md'), undefined)
})

await check('stat 经真实侧车进程返回类型与体积', async () => {
  const remote = await resolveRemote(ctx, exec, 'selftest:/readme.md')
  const info = await remoteStat(ctx, exec, remote)
  assert.equal(info.type, 'file')
  assert.ok(info.size > 0)
})

await check('list 返回条目', async () => {
  const remote = await resolveRemote(ctx, exec, 'selftest:/')
  const entries = await remoteList(ctx, exec, remote)
  assert.ok(entries.some((entry) => entry.name === 'readme.md' && entry.type === 'file'))
  assert.ok(entries.some((entry) => entry.name === 'sub' && entry.type === 'directory'))
})

await check('read 字节正确（含中文与 base64 编解码）', async () => {
  const remote = await resolveRemote(ctx, exec, 'selftest:/readme.md')
  const bytes = await remoteReadBytes(ctx, exec, remote)
  assert.equal(decode(bytes), '# hello\n中文\n')
})

await check('write → read 往返一致', async () => {
  const remote = await resolveRemote(ctx, exec, 'selftest:/round.txt')
  const payload = new TextEncoder().encode('第一行\nsecond line\n')
  await remoteWriteBytes(ctx, exec, remote, payload)
  const back = await remoteReadBytes(ctx, exec, remote)
  assert.equal(decode(back), '第一行\nsecond line\n')
})

await check('sftp_hosts action=list 列出代号与说明', async () => {
  const list = tools.find((tool) => tool.name === 'sftp_hosts')
  const value = await list.execute({ action: 'list' }, exec)
  assert.equal(value.action, 'list')
  assert.ok(value.lines.some((line) => line.includes('selftest')), `应当列出 selftest：${value.lines.join(' | ')}`)
})

await check('sftp_hosts action=ping 真实连上自检后端', async () => {
  const list = tools.find((tool) => tool.name === 'sftp_hosts')
  const value = await list.execute({ action: 'ping', code: 'selftest' }, exec)
  assert.match(value.lines.join(' '), /连接成功/)
})

closeAllSessions()

console.log(`\n${passed} 项通过`)
