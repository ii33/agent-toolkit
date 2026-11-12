/**
 * 二进制读取拒绝的引导文案。
 * 运行：node test/binary-hint.test.mjs
 *
 * 背景：读到 PNG 时报"看起来是二进制文件，read_text 只处理文本"——
 * 既用了旧工具名，又没告诉模型该用什么（图片就该用 read_image）。
 */
import assert from 'node:assert/strict'

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`  ok  ${name}`)
}

// binaryReadError 未导出（内部实现），这里通过其行为契约验证：用 read 工具实测。
const { createRequire } = await import('node:module')
const requireProfile = createRequire('C:\\Users\\youai\\.dsh\\profiles\\desktop\\package.json')
const mod = await import(`file:///${requireProfile.resolve('@local/dsh-agentkit').replace(/\\/g, '/')}`)

/** 用一段含 NUL 的字节构造读失败的 harness。 */
function harness(bytes) {
  const tools = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: { get: () => undefined, register: (d) => { tools.push(d); return () => {} } },
    systemPrompt: { context() {}, section() {} },
    on: () => () => {},
    effect: (fn) => { fn(); return () => {} },
    get: () => undefined,
    waterfall: async () => undefined,
    emit() {},
    fs: {
      resolve: (p) => ({ displayPath: typeof p === 'string' ? p : p.rawPath, rawPath: p }),
      stat: async () => ({ type: 'file', size: bytes.length, version: 1 }),
      readBytes: async () => bytes,
      readByteRange: async () => bytes.subarray(0, 4096),
      contains: () => true,
      processPath: (t) => t.rawPath ?? t.displayPath,
      readText: async () => bytes.toString('utf8')
    }
  }
  mod.apply(ctx, { tools: ['fs'] })
  return { read: tools.find((t) => t.name === 'read'), ctx }
}

const exec = { signal: undefined, agent: { session: { id: 'x', header: { cwd: 'C:\\w' } } } }
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])

async function messageFor(path, bytes = PNG) {
  const { read } = harness(bytes)
  try {
    await read.execute({ file_path: path }, exec)
    return null
  } catch (error) {
    return String(error.message)
  }
}

console.log('二进制读取拒绝')

const pngMsg = await messageFor('C:\\a\\b\\launcher-notice.png')
check('图片文件引导到 read_image', () => {
  assert.ok(pngMsg, '应当拒绝')
  assert.match(pngMsg, /read_image/, 'PNG 必须指向 read_image')
  assert.match(pngMsg, /image_info/, '顺带指出元信息工具')
})

check('不再使用旧工具名 read_text', () => {
  assert.doesNotMatch(pngMsg, /read_text/, 'read_text 已不存在')
  assert.match(pngMsg, /`read` 只处理文本/)
})

const binMsg = await messageFor('C:\\a\\b\\data.bin')
check('非图片二进制给出通用出路', () => {
  assert.ok(binMsg)
  assert.doesNotMatch(binMsg, /read_image/, '非图片不该指向图片工具')
  assert.match(binMsg, /不是文本文件/)
  assert.match(binMsg, /file|head -c|xxd/, '给出 shell 侧的处理手段')
})

check('大写的图片扩展名同样识别', async () => {
  const msg = await messageFor('C:\\a\\b\\SHOT.PNG')
  assert.match(msg, /read_image/)
})

console.log(`\n${passed} 项通过`)
