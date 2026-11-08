/**
 * 混合行尾编辑自测：只替换命中区间，保留未改动行的原始行尾。
 * 运行：node test/eol-mixed.test.mjs
 *
 * 背景：host 的 `fs.editText` 用 `detectLineEndings`（取主导风格）+ `restoreLineEndings`
 * 整份写回，CRLF/LF 混排文件被编辑后会被统一成一种风格，git diff 全是行尾噪声。
 * 这里验证 `planEolPreservingEdit` 只动命中区间。
 */
import assert from 'node:assert/strict'
import {
  detectEol,
  eolAt,
  planEolPreservingEdit,
  toLfView
} from '../lib/encoding.js'

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`  ok  ${name}`)
}

// 6 行混排：奇数行 CRLF、偶数行 LF（与真实场景 788 CRLF / 2374 行同型）
const MIXED = 'a=1\r\nb=2\nc=3\r\nd=4\ne=5\r\nf=6\n'

const show = (text) => text.replace(/\r\n/g, '<CRLF>').replace(/\n/g, '<LF>\n').replace(/\r/g, '<CR>')

console.log('检测与视图')

check('混排被识别为 mixed', () => {
  assert.equal(detectEol(MIXED), 'mixed')
  assert.equal(detectEol('a\r\nb\r\n'), 'crlf')
  assert.equal(detectEol('a\nb\n'), 'lf')
})

check('toLfView 映射回原文下标', () => {
  const { lf, map } = toLfView('a\r\nb\rc\n')
  assert.equal(lf, 'a\nb\nc\n')
  assert.equal(map[0], 0) // a
  assert.equal(map[1], 1) // \r（吞掉 \n）
  assert.equal(map[2], 3) // b
  assert.equal(map[3], 4) // 裸 \r
  assert.equal(map[4], 5) // c
  assert.equal(map[map.length - 1], 7) // 末尾哨兵
})

check('eolAt 取本行行尾（末行回退上一行）', () => {
  assert.equal(eolAt('a\r\nb', 0), '\r\n')
  assert.equal(eolAt('a\nb', 0), '\n')
  assert.equal(eolAt('a\rb', 0), '\r')
  assert.equal(eolAt('a\r\nb', 3), '\r\n') // 末行无行尾，回退上一行
  assert.equal(eolAt('a', 0), '\n') // 完全没有换行
})

console.log('只替换命中区间')

check('单行编辑：其它行的 CRLF/LF 原样保留', () => {
  const plan = planEolPreservingEdit(MIXED, 'b=2', 'b=CHANGED', false)
  assert.equal(plan.occurrences, 1)
  assert.equal(plan.replaced, 1)
  assert.equal(plan.text, 'a=1\r\nb=CHANGED\nc=3\r\nd=4\ne=5\r\nf=6\n')
  // 行尾结构没变：3 个 CRLF + 3 个 LF
  assert.equal((plan.text.match(/\r\n/g) ?? []).length, 3)
  assert.equal((plan.text.match(/(?<!\r)\n/g) ?? []).length, 3)
})

check('插入多行沿用锚点行的行尾', () => {
  // 锚点行 "b=2" 以 LF 结尾 → 新增行也用 LF
  const lfAnchor = planEolPreservingEdit(MIXED, 'b=2', 'b=2\nb2=x', false)
  assert.equal(lfAnchor.text, 'a=1\r\nb=2\nb2=x\nc=3\r\nd=4\ne=5\r\nf=6\n')
  // 锚点行 "c=3" 以 CRLF 结尾 → 新增行也用 CRLF
  const crlfAnchor = planEolPreservingEdit(MIXED, 'c=3', 'c=3\r\nc2=y', false)
  assert.equal(crlfAnchor.text, 'a=1\r\nb=2\nc=3\r\nc2=y\r\nd=4\ne=5\r\nf=6\n')
})

check('delete（new_string 为空）只删命中区间', () => {
  const plan = planEolPreservingEdit(MIXED, 'b=2\n', '', false)
  assert.equal(plan.text, 'a=1\r\nc=3\r\nd=4\ne=5\r\nf=6\n')
})

check('replace_all 跨两种行尾全替换', () => {
  const file = 'x=1\r\ny=2\nx=3\r\ny=4\n'
  const plan = planEolPreservingEdit(file, 'x=', 'X=', true)
  assert.equal(plan.occurrences, 2)
  assert.equal(plan.replaced, 2)
  assert.equal(plan.text, 'X=1\r\ny=2\nX=3\r\ny=4\n')
})

check('模式用「错误」的行尾风格也能匹配', () => {
  // 用 CRLF 写模式去匹配 LF 行
  const plan = planEolPreservingEdit('a\nb\nc\n', 'a\r\nb', 'Z', false)
  assert.equal(plan.replaced, 1)
  assert.equal(plan.text, 'Z\nc\n')
  // 用 LF 写模式去匹配 CRLF 行
  const crlf = planEolPreservingEdit('a\r\nb\r\nc\r\n', 'a\nb', 'Z', false)
  assert.equal(crlf.text, 'Z\r\nc\r\n')
})

console.log('边界')

check('找不到时不动文件', () => {
  const plan = planEolPreservingEdit(MIXED, 'nope', 'x', false)
  assert.equal(plan.occurrences, 0)
  assert.equal(plan.replaced, 0)
  assert.equal(plan.text, MIXED)
})

check('多处命中但未开 replace_all 时只报数不替换', () => {
  const plan = planEolPreservingEdit('k=1\nk=2\r\n', 'k=', 'K=', false)
  assert.equal(plan.occurrences, 2)
  assert.equal(plan.replaced, 1)
  assert.equal(plan.text, 'K=1\nk=2\r\n')
})

check('纯 CRLF / 纯 LF 文件行为一致', () => {
  assert.equal(planEolPreservingEdit('a\r\nb\r\n', 'b', 'B').text, 'a\r\nB\r\n')
  assert.equal(planEolPreservingEdit('a\nb\n', 'b', 'B').text, 'a\nB\n')
})

check('空模式不做任何事', () => {
  assert.equal(planEolPreservingEdit(MIXED, '', 'x').text, MIXED)
})

check('大文件只改一处时未命中字节不变（字节数只差增量）', () => {
  const lines = []
  for (let i = 0; i < 2400; i += 1) {
    lines.push(i % 3 === 0 ? `line-${i}=0\r\n` : `line-${i}=0\n`)
  }
  const file = lines.join('')
  const plan = planEolPreservingEdit(file, 'line-1200=0', 'line-1200=1', false)
  assert.equal(plan.text.length, file.length) // 同长度替换
  const before = file.slice(0, file.indexOf('line-1200=0'))
  assert.ok(plan.text.startsWith(before), '命中点之前的内容逐字节相同')
  assert.ok(plan.text.endsWith(file.slice(file.indexOf('line-1200=0') + 'line-1200=0'.length)), '命中点之后逐字节相同')
  // 命中点之后仍是原来的混排：CRLF 与 LF 都还在
  assert.ok(plan.text.includes('\r\n'))
  assert.ok(/(?<!\r)\n/.test(plan.text))
})

if (process.env.DSH_EOL_DEBUG === '1') {
  console.log('\n示例：')
  console.log(show(planEolPreservingEdit(MIXED, 'b=2', 'b=CHANGED').text))
}

console.log(`\n${passed} 项通过`)
