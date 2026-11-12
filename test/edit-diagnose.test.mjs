/**
 * edit 未命中诊断的行为自测。
 * 运行：node test/edit-diagnose.test.mjs
 *
 * 背景：报错只丢一句"找不到 old_string，请先用 read_text 确认原文"，
 * 既用了旧工具名（read_text），也没告诉模型差在哪，导致反复盲目重试。
 * 现在 diagnoseMiss() 要给出：近似行号、缩进差异、全角/半角差异提示。
 */
import assert from 'node:assert/strict'
import { diagnoseMiss } from '../tools/fs.js'

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`  ok  ${name}`)
}

/** 一份带缩进与全角标点的样例文件（CRLF）。 */
const FILE = [
  '# 一、功能',
  '',
  '  缩进两格的一行：说明文字',
  '**怎么用**：运行检查。',
  '嵌套更深：',
  '    深层的代码示例'
].join('\r\n')

console.log('diagnoseMiss')

check('缩进不同：报出行号与两边的空格数', () => {
  const msg = diagnoseMiss(FILE, '缩进两格的一行：说明文字')
  assert.match(msg, /第 3 行/)
  assert.match(msg, /缩进不同/)
  assert.match(msg, /old_string 用了 0 个空格，原文是 2 个空格/)
})

check('全角/半角不同：定位到相近行并提示标点差异', () => {
  const msg = diagnoseMiss(FILE, '**怎么用**:运行检查。')
  assert.match(msg, /第 4 行/)
  assert.match(msg, /开头相近/)
  assert.match(msg, /全角\/半角/)
})

check('首行逐字命中但后续行不符：建议缩小片段', () => {
  const msg = diagnoseMiss(FILE, '**怎么用**：运行检查。\n这一行不存在')
  assert.match(msg, /逐字相同/)
  assert.match(msg, /更短、更独特的片段/)
})

check('完全找不到：提示可能路径或文件选错', () => {
  const msg = diagnoseMiss(FILE, '完全不存在的内容 xyz')
  assert.match(msg, /没有相近内容/)
  assert.match(msg, /路径或文件选错/)
})

check('指引使用当前工具名 read（不是 read_text）', () => {
  const msg = diagnoseMiss(FILE, '不存在的内容')
  assert.match(msg, /请先用 `read` 确认原文/)
  assert.doesNotMatch(msg, /read_text/, 'read_text 是旧名，按它去调只会再失败')
})

check('空 old_string 安全降级', () => {
  const msg = diagnoseMiss(FILE, '')
  assert.match(msg, /请先用 `read`/)
})

check('多行 old_string 只看首行定位', () => {
  const msg = diagnoseMiss(FILE, '缩进两格的一行：说明文字\n第二行不存在')
  assert.match(msg, /第 3 行/)
})

console.log(`\n${passed} 项通过`)
