/**
 * 纯函数自测：编码/换行探测与任务账本解析。
 * 运行：node test/pure.test.mjs
 */
import assert from 'node:assert/strict'
import {
  countLines,
  decodeText,
  detectEol,
  dominantEol,
  encodingLabel,
  eolLabel,
  looksBinary,
  normalizeEol,
  splitLines,
  stripBom
} from '../lib/encoding.js'
import { buildPanel, parseLedger, serializeLedger } from '../tools/tasks.js'

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`  ok  ${name}`)
}

const utf8 = (text) => new TextEncoder().encode(text)

console.log('encoding')

check('UTF-8 无 BOM', () => {
  const result = decodeText(utf8('中文 abc\n第二行\n'))
  assert.equal(result.encoding, 'utf-8')
  assert.equal(result.bom, false)
  assert.equal(result.text, '中文 abc\n第二行\n')
})

check('UTF-8 BOM 被识别并剥离', () => {
  const result = decodeText(utf8('\uFEFF中文'))
  assert.equal(result.encoding, 'utf-8')
  assert.equal(result.bom, true)
  assert.equal(result.text, '中文')
})

check('UTF-16LE BOM', () => {
  const bytes = new Uint8Array([0xff, 0xfe, 0x2d, 0x4e, 0x87, 0x65]) // 中文
  const result = decodeText(bytes)
  assert.equal(result.encoding, 'utf-16le')
  assert.equal(result.bom, true)
  assert.equal(result.text, '中文')
})

check('GBK 回退（非合法 UTF-8）', () => {
  // "中文" 的 GBK 编码
  const bytes = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4])
  const result = decodeText(bytes)
  assert.equal(result.encoding, 'gbk')
  assert.equal(result.text, '中文')
})

check('二进制探测', () => {
  assert.equal(looksBinary(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])), true)
  assert.equal(looksBinary(utf8('纯文本没有 NUL')), false)
})

check('换行风格探测', () => {
  assert.equal(detectEol('a\r\nb\r\n'), 'crlf')
  assert.equal(detectEol('a\nb\n'), 'lf')
  assert.equal(detectEol('a\rb\r'), 'cr')
  assert.equal(detectEol('a\r\nb\n'), 'mixed')
  assert.equal(detectEol('单行无换行'), 'none')
})

check('mixed 取多数派', () => {
  assert.equal(dominantEol('a\r\nb\r\nc\n'), 'crlf')
  assert.equal(dominantEol('a\r\nb\nc\n'), 'lf')
  assert.equal(dominantEol('无换行', 'crlf'), 'crlf')
})

check('换行规范化 + BOM 剥离', () => {
  assert.equal(normalizeEol('a\nb\r\nc', 'crlf'), 'a\r\nb\r\nc')
  assert.equal(normalizeEol('a\r\nb', 'lf'), 'a\nb')
  assert.equal(stripBom('\uFEFFx'), 'x')
  assert.equal(stripBom('x'), 'x')
})

check('行切分与计数', () => {
  assert.equal(countLines('a\nb\nc'), 3)
  assert.equal(countLines('a\nb\nc\n'), 3)
  assert.equal(countLines(''), 0)
  assert.deepEqual(splitLines('a\r\nb'), ['a', 'b'])
})

check('标签', () => {
  assert.equal(eolLabel('crlf'), 'CRLF')
  assert.equal(eolLabel('none'), '无换行')
  assert.equal(encodingLabel('gbk', false), 'gbk')
  assert.equal(encodingLabel('utf-8', true), 'utf-8 (BOM)')
})

console.log('tasks')

const SAMPLE = [
  '# 任务面板',
  'goal: 把 book.pdf 翻译成中文并排版',
  'stage: 2/4 OCR+翻译',
  '- [x] #1 拆分 book.pdf → out/chunks',
  '- [~] #2 逐块 OCR+翻译 → out/zh | 当前 chunk-0007',
  '- [ ] #3 排版 → out/book.zh.docx',
  '# 人手写的注释行会被忽略',
  '- [!] #4 合并封装 → out/book.zh.zip | 等 7z'
].join('\n')

check('账本解析', () => {
  const ledger = parseLedger(SAMPLE)
  assert.equal(ledger.goal, '把 book.pdf 翻译成中文并排版')
  assert.equal(ledger.stage, '2/4 OCR+翻译')
  assert.equal(ledger.tasks.length, 4)
  assert.deepEqual(ledger.tasks[0], { id: 1, status: 'done', text: '拆分 book.pdf → out/chunks' })
  assert.equal(ledger.tasks[1].status, 'doing')
  assert.equal(ledger.tasks[1].note, '当前 chunk-0007')
  assert.equal(ledger.tasks[3].status, 'blocked')
  assert.equal(ledger.tasks[3].note, '等 7z')
})

check('序列化可往返（CRLF 输入也一样）', () => {
  const ledger = parseLedger(SAMPLE.replace(/\n/g, '\r\n'))
  const text = serializeLedger(ledger)
  assert.deepEqual(parseLedger(text), ledger)
  assert.equal(text.includes('\r'), false)
})

check('面板包含目标/阶段/进度/下一步', () => {
  const panel = buildPanel(parseLedger(SAMPLE), 'TASKS.md')
  assert.match(panel, /任务面板（TASKS\.md）/)
  assert.match(panel, /目标: 把 book\.pdf/)
  assert.match(panel, /阶段: 2\/4/)
  assert.match(panel, /进度: 1\/4 完成/)
  assert.match(panel, /下一步: #3 排版/)
  assert.ok(panel.length < 700, `面板过长: ${panel.length}`)
})

check('空账本不注入任何内容', () => {
  assert.equal(buildPanel({ goal: '', stage: '', tasks: [] }, 'TASKS.md'), '')
})

check('任务多于 6 项时折叠', () => {
  const ledger = {
    goal: 'g',
    stage: 's',
    tasks: Array.from({ length: 12 }, (_, index) => ({ id: index + 1, status: 'todo', text: `任务 ${index + 1}` }))
  }
  const panel = buildPanel(ledger, 'TASKS.md')
  assert.match(panel, /另有 6 项/)
})

console.log(`\n${passed} 项通过`)
