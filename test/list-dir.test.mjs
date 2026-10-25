/**
 * list_dir 的离线测试：用 node:fs 撑起一个假 ctx，验证排序、文件详情与错误。
 *
 * 覆盖：按大小降序 / 按修改时间降序 / 按名排序（目录在前）/ 给文件路径返回详情 / 不存在报错。
 *
 * 运行：node test/list-dir.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { apply as applyFs } from '../tools/fs.js'

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`  ok  ${name}`)
}

console.log('list_dir')

/** 造一个临时目录：一个子目录 + 三个大小/时间不同的文件。 */
const ROOT = mkdtempSync(join(tmpdir(), 'agentkit-list-'))
mkdirSync(join(ROOT, 'subdir'))
writeFileSync(join(ROOT, 'small.txt'), 'x')
writeFileSync(join(ROOT, 'medium.txt'), 'y'.repeat(100))
writeFileSync(join(ROOT, 'large.txt'), 'z'.repeat(1000))

/** 假 ctx：fs 用 node:fs 实现，形状与 harness 的 resolved target 一致（带 displayPath）。 */
function harness() {
  const tools = new Map()
  const ctx = {
    tools: { register: (definition) => tools.set(definition.name, definition) },
    get: () => undefined,
    fs: {
      resolve: async (pathInput) => ({ path: resolve(pathInput), displayPath: resolve(pathInput) }),
      stat: async (target) => {
        const info = statSync(target.path)
        return {
          type: info.isDirectory() ? 'directory' : 'file',
          size: info.size,
          mtime: info.mtimeMs
        }
      },
      listDir: async (target) => readdirSync(target.path, { withFileTypes: true }).map((entry) => {
        const info = statSync(join(target.path, entry.name))
        return {
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : 'file',
          size: info.size,
          mtime: info.mtimeMs
        }
      })
    }
  }
  applyFs(ctx)
  return { tools, exec: { cwd: ROOT, signal: undefined } }
}

const listDir = () => harness().tools.get('list_dir')

await check('按大小降序：最大的文件排第一', async () => {
  const { tools, exec } = harness()
  const value = await tools.get('list_dir').execute({ path: ROOT, sort: 'size', order: 'desc' }, exec)
  assert.equal(value.kind, 'directory')
  assert.match(value.entries[0], /large\.txt/)
  assert.match(value.entries[1], /medium\.txt/)
})

await check('按名排序时目录在前', async () => {
  const { tools, exec } = harness()
  const value = await tools.get('list_dir').execute({ path: ROOT }, exec)
  assert.match(value.entries[0], /\[目录\] subdir/)
})

await check('按修改时间降序可用', async () => {
  const { tools, exec } = harness()
  const value = await tools.get('list_dir').execute({ path: ROOT, sort: 'mtime', order: 'desc' }, exec)
  assert.equal(value.entries.length, 4)
  assert.match(value.entries[0], /\[\S+\] \S+/)
})

await check('给文件路径 → 返回该文件详情（kind=file，一条）', async () => {
  const { tools, exec } = harness()
  const value = await tools.get('list_dir').execute({ path: join(ROOT, 'medium.txt') }, exec)
  assert.equal(value.kind, 'file')
  assert.equal(value.entries.length, 1)
  assert.match(value.entries[0], /\[文件\] medium\.txt/)
  assert.match(value.entries[0], /100 B/)
  const parts = tools.get('list_dir').output.render({}, value)
  assert.match(parts[0].text, /^<file-info /)
})

await check('路径不存在 → 明确报错', async () => {
  const { tools, exec } = harness()
  await assert.rejects(
    () => tools.get('list_dir').execute({ path: join(ROOT, 'nope') }, exec),
    /路径不存在|ENOENT/
  )
})

await check('参数 schema 含 sort / order 枚举', () => {
  const definition = listDir()
  assert.deepEqual(definition.parameters.properties.sort.enum, ['name', 'mtime', 'size'])
  assert.deepEqual(definition.parameters.properties.order.enum, ['asc', 'desc'])
})

console.log(`\n${passed} 项通过`)
