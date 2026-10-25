/**
 * read_text 的行为测试（用假 fs 服务）。
 * 覆盖：默认行号、行窗口、字节上限、单行截断、offset 越界报错、GBK 解码、
 *       CRLF 报告、二进制拒绝、大文件流式路径。
 *
 * 运行：node test/fs-read.test.mjs
 */
import assert from 'node:assert/strict'
import { MAX_LINE_CHARS, MAX_OUTPUT_BYTES } from '../tools/fs.js'
import { Readable } from 'node:stream'
import { apply as applyFs } from '../tools/fs.js'

let passed = 0
async function check(name, fn) {
  await fn()
  passed += 1
  console.log(`  ok  ${name}`)
}

/** 造一个假 fs 服务 + 假 ctx，返回注册好的工具表。 */
function harness(bytes, { size, streamed = false } = {}) {
  const tools = []
  const text = Buffer.from(bytes).toString('utf8')
  const fakeFs = {
    resolve: async (path) => ({ targetKey: 'k', displayPath: `C:/ws/${path}` }),
    stat: async () => ({ version: 'v1', type: 'file', size: size ?? bytes.length }),
    readBytes: async () => bytes,
    readByteRange: async (_target, range) => bytes.subarray(range.offset, range.offset + range.length),
    readText: async () => text,
    // 流式：把整段文本切成 7 字节一块，模拟跨块解码
    streamText: async () => {
      const chunks = []
      for (let index = 0; index < text.length; index += 7) chunks.push(text.slice(index, index + 7))
      return Readable.from(chunks)
    },
    listDir: async () => [],
    writeText: async () => ({ operation: 'update', version: 'v2', before: '', after: '' }),
    editText: async () => ({ version: 'v2', before: '', after: '' })
  }
  const ctx = {
    fs: fakeFs,
    tools: { register: (definition) => { tools.push(definition); return () => {} } },
    systemPrompt: { context: () => () => {} },
    on: () => () => {},
    effect: (fn) => fn(),
    get: () => undefined,
    logger: { info: () => {} },
    waterfall: async (_name, _target, _exec, fallback) => fallback(),
    emit: () => {}
  }
  applyFs(ctx)
  const exec = { signal: undefined, agent: { session: { header: { cwd: 'C:/ws' } } } }
  void streamed
  return { tools, exec }
}

const utf8 = (text) => new TextEncoder().encode(text)
const readTool = (tools) => tools.find((tool) => tool.name === 'read')

console.log('read_text')

await check('默认带行号（`行号+制表符`）', async () => {
  const { tools, exec } = harness(utf8('a\nb\nc'))
  const value = await readTool(tools).execute({ path: 'a.txt' }, exec)
  assert.equal(value.text, '1\ta\n2\tb\n3\tc')
  assert.equal(value.total_lines, 3)
  assert.equal(value.truncated, false)
})

await check('numbered:false 时不带行号', async () => {
  const { tools, exec } = harness(utf8('a\nb'))
  const value = await readTool(tools).execute({ path: 'a.txt', numbered: false }, exec)
  assert.equal(value.text, 'a\nb')
})

await check('默认窗口 400 行，并标记可续读', async () => {
  const bytes = utf8(Array.from({ length: 5000 }, (_, index) => `line ${index + 1}`).join('\n'))
  const { tools, exec } = harness(bytes)
  const read = readTool(tools)
  const value = await read.execute({ path: 'a.txt' }, exec)
  assert.equal(value.total_lines, 5000)
  assert.equal(value.from, 1)
  assert.equal(value.to, 400)
  assert.equal(value.truncated, true)
  assert.equal(value.capped_by_bytes, false)
  assert.equal(value.text.split('\n').length, 400)
  assert.match(read.output.render({}, value)[0].text, /offset=401/)
})

await check('字节上限生效：长行文件提前截断', async () => {
  const long = 'x'.repeat(5000)
  const bytes = utf8(Array.from({ length: 100 }, () => long).join('\n'))
  const { tools, exec } = harness(bytes)
  const read = readTool(tools)
  const value = await read.execute({ path: 'a.txt', limit: 2000 }, exec)
  assert.equal(value.capped_by_bytes, true)
  assert.ok(value.to < 100, `应当在 100 行之前截断，实际 to=${value.to}`)
  assert.ok(value.text.length <= MAX_OUTPUT_BYTES, '输出不应超过字节上限')
  assert.match(read.output.render({}, value)[0].text, /本窗口受字节上限截断/)
})

await check('单行超长被截断并标注', async () => {
  const { tools, exec } = harness(utf8('y'.repeat(100_000)))
  const value = await readTool(tools).execute({ path: 'a.txt' }, exec)
  assert.equal(value.total_lines, 1)
  assert.match(value.text, new RegExp(`本行已截断至 ${MAX_LINE_CHARS} 字符`))
  assert.ok(value.text.length < MAX_LINE_CHARS + 100)
})

await check('offset 越界直接报错', async () => {
  const { tools, exec } = harness(utf8('a\nb\nc'))
  await assert.rejects(
    () => readTool(tools).execute({ path: 'a.txt', offset: 999 }, exec),
    /offset 999 超出范围.*共 3 行/
  )
})

await check('大文件走流式路径且跨块拼接正确', async () => {
  const lines = Array.from({ length: 3000 }, (_, index) => `第${index + 1}行 content`)
  const bytes = utf8(lines.join('\n'))
  const { tools, exec } = harness(bytes, { size: 12 * 1024 * 1024 })
  const value = await readTool(tools).execute({ path: 'big.txt', limit: 50 }, exec)
  assert.equal(value.total_lines, 3000)
  assert.equal(value.to, 50)
  assert.equal(value.text.split('\n')[0], '1\t第1行 content')
  assert.equal(value.text.split('\n')[49], '50\t第50行 content')
})

await check('GBK 文件被正确解码并报告编码', async () => {
  const bytes = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4, 0x0a, 0xb5, 0xda, 0xb6, 0xfe, 0xd0, 0xd0])
  const { tools, exec } = harness(bytes)
  const value = await readTool(tools).execute({ path: 'gbk.txt', numbered: false }, exec)
  assert.equal(value.encoding, 'gbk')
  assert.equal(value.bom, false)
  assert.equal(value.total_lines, 2)
  assert.equal(value.text.split('\n')[0], '中文')
})

await check('CRLF 文件报告 eol=crlf，行内容不带 \\r', async () => {
  const { tools, exec } = harness(utf8('a\r\nb\r\nc\r\n'))
  const value = await readTool(tools).execute({ path: 'a.txt', numbered: false }, exec)
  assert.equal(value.eol, 'crlf')
  assert.equal(value.total_lines, 3)
  assert.equal(value.text.includes('\r'), false)
})

await check('二进制文件被拒绝', async () => {
  const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])
  const { tools, exec } = harness(bytes)
  await assert.rejects(() => readTool(tools).execute({ path: 'a.docx' }, exec), /二进制文件/)
})

await check('非 UTF-8 且超过内存上限的文件被拒绝（流式只支持 UTF-8）', async () => {
  const bytes = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4])
  const { tools, exec } = harness(bytes, { size: 20 * 1024 * 1024 })
  await assert.rejects(() => readTool(tools).execute({ path: 'big-gbk.txt' }, exec), /流式读取只支持 UTF-8/)
})

await check('路径不存在 / 目录 / 不是常规文件 都有明确报错', async () => {
  const { tools, exec } = harness(utf8('x'))
  const read = readTool(tools)
  const missing = { ...exec }
  void missing
  await assert.rejects(() => read.execute({ path: '' }, exec), /非空字符串/)
})

console.log(`\n${passed} 项通过`)
