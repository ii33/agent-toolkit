/**
 * 拆分规划的纯函数自测。
 * 运行：node test/split.test.mjs
 */
import assert from 'node:assert/strict'
import { chunkName, planByteChunks, planLineChunks, planMarkerChunks } from '../lib/split-plan.js'

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`  ok  ${name}`)
}

console.log('split-plan')

check('按行数切块，末块收尾', () => {
  assert.deepEqual(planLineChunks(1000, 300), [
    { from: 1, to: 300 },
    { from: 301, to: 600 },
    { from: 601, to: 900 },
    { from: 901, to: 1000 }
  ])
})

check('不足一块时只切一块', () => {
  assert.deepEqual(planLineChunks(100, 200), [{ from: 1, to: 100 }])
  assert.deepEqual(planLineChunks(0, 200), [])
})

check('重叠行数生效且不重复尾块', () => {
  assert.deepEqual(planLineChunks(10, 4, 1), [
    { from: 1, to: 4 },
    { from: 4, to: 7 },
    { from: 7, to: 10 }
  ])
})

check('按字符预算切块（不切碎行）', () => {
  assert.deepEqual(planByteChunks(['aaa', 'bbb', 'ccc'], 8), [
    { from: 1, to: 2 },
    { from: 3, to: 3 }
  ])
  assert.deepEqual(planByteChunks(['x'.repeat(20)], 8), [{ from: 1, to: 1 }])
})

check('按标题标记切块，标记行归入下一块', () => {
  const lines = ['intro', '# A', 'x', '# B', 'y']
  assert.deepEqual(planMarkerChunks(lines, /^# /), [
    { from: 1, to: 1, title: 'intro' },
    { from: 2, to: 3, title: '# A' },
    { from: 4, to: 5, title: '# B' }
  ])
})

check('无标记时整篇一块', () => {
  assert.deepEqual(planMarkerChunks(['a', 'b'], /^# /), [{ from: 1, to: 2 }])
})

check('块文件名补零', () => {
  assert.equal(chunkName('book', 7), 'book-0007.txt')
  assert.equal(chunkName('book', 1234, '.md'), 'book-1234.md')
})

console.log(`\n${passed} 项通过`)
