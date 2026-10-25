/**
 * 图片工具的离线测试：真的跑一遍侧车（Pillow），用假 ctx 走完工具链路。
 *
 * 覆盖：image_info / crop_image（box 与 ratio）/ resize_image /
 *       交给模型时的渲染（text + image 两个 part）。
 *
 * 运行：node test/image-ops.test.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn as spawnProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { pythonRuntime, pythonScript } from './deps.mjs'
import { apply as applyImageOps } from '../tools/image-ops.js'

/**
 * 假 spawn：把 harness 的 spawn 契约（argv/stdio/done/stdout/stderr）套在 node:child_process 上。
 * @param {object} spec - harness 的 spawn 规格。
 * @returns {object} handle（done + stdout + stderr）。
 */
function fakeSpawn(spec) {
  const child = spawnProcess(spec.argv[0], spec.argv.slice(1), {
    cwd: spec.cwd,
    env: spec.env,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const input = spec.stdio === undefined ? undefined : spec.stdio.stdin
  child.stdin.end(typeof input === 'object' && input !== null ? String(input.data ?? '') : '')
  return {
    done: new Promise((resolve) => {
      child.on('close', (code, signal) => resolve({ exitCode: code, signal }))
    }),
    stdout: child.stdout,
    stderr: child.stderr
  }
}

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`  ok  ${name}`)
}

console.log('image ops')

const SIDECAR = fileURLToPath(new URL('../tools/image_ops.py', import.meta.url))
const PY = pythonScript(SIDECAR)

/**
 * 直接调侧车（测试自己造图用）。
 * @param {object} request - 请求。
 * @returns {object} 响应。
 */
function sidecar(request) {
  const output = execFileSync(PY.command, [PY.script, '--auto-install'], {
    cwd: PY.cwd,
    input: JSON.stringify(request),
    encoding: 'utf8'
  })
  const line = output.split('\n').map((item) => item.trim()).filter((item) => item.startsWith('{')).pop()
  return JSON.parse(line)
}

/** 1×1 的合法 PNG，用侧车放大成 200×100 当测试图。 */
const ONE_PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wF/AAAAAElFTkSuQmCC'
const big = sidecar({ op: 'resize', data_b64: ONE_PIXEL, width: 200, height: 100 })
const IMAGE = Buffer.from(String(big.data_b64), 'base64')
assert.ok(IMAGE.length > 0, '测试图应生成成功')

/** 假 ctx：注册表 + subprocess + attachments + fs。 */
function harness() {
  const tools = new Map()
  const ctx = {
    tools: { register: (definition) => tools.set(definition.name, definition) },
    get: (name) => {
      // 与 sidecar() 用同一个解释器：DSH_TEST_PYTHON 指到自带 Pillow 的那份时，
      // 插件侧解析出来的可执行文件也必须是它，否则两半用的不是同一个 python。
      if (name === 'subprocess') return { resolveExecutable: async () => pythonRuntime.command, spawn: fakeSpawn }
      if (name === 'attachments') {
        return {
          saveImage: async ({ data, mediaType }) => ({ attachmentId: 'att-test', mediaType, bytes: data.length })
        }
      }
      return undefined
    },
    fs: {
      resolve: async (path) => path,
      stat: async () => ({ type: 'file', size: IMAGE.length }),
      readBytes: async () => new Uint8Array(IMAGE)
    }
  }
  applyImageOps(ctx)
  return { tools, exec: { cwd: process.cwd() } }
}

await check('image_info 报出真实尺寸与字节数', async () => {
  const { tools, exec } = harness()
  const info = await tools.get('image_info').execute({ file_path: 'C:/tmp/x.png' }, exec)
  assert.equal(info.width, 200)
  assert.equal(info.height, 100)
  assert.ok(info.bytes > 0)
})

await check('crop_image 用像素框裁剪并交给模型（含 image 块）', async () => {
  const { tools, exec } = harness()
  const cropped = await tools.get('crop_image').execute({ file_path: 'C:/tmp/x.png', box: [10, 10, 110, 60] }, exec)
  assert.equal(cropped.width, 100)
  assert.equal(cropped.height, 50)
  assert.equal(cropped.attachment_id, 'att-test')
  const parts = tools.get('crop_image').output.render({}, cropped)
  assert.equal(parts.length, 2, '应同时给说明行与图片块')
  assert.equal(parts[0].type, 'text')
  assert.equal(parts[1].type, 'image')
  assert.equal(parts[1].attachment.attachmentId, 'att-test')
})

await check('crop_image 用比例框裁剪', async () => {
  const { tools, exec } = harness()
  const half = await tools.get('crop_image').execute({ file_path: 'C:/tmp/x.png', ratio: [0, 0, 0.5, 1] }, exec)
  assert.equal(half.width, 100)
  assert.equal(half.height, 100)
})

await check('crop_image 缺 box/ratio 时报错', async () => {
  const { tools, exec } = harness()
  await assert.rejects(
    () => tools.get('crop_image').execute({ file_path: 'C:/tmp/x.png' }, exec),
    /需要 box（像素）或 ratio/
  )
})

await check('resize_image 按最长边等比缩放', async () => {
  const { tools, exec } = harness()
  const resized = await tools.get('resize_image').execute({ file_path: 'C:/tmp/x.png', max_side: 50 }, exec)
  assert.equal(resized.width, 50)
  assert.equal(resized.height, 25)
})

await check('三个工具都注册且参数 schema 合法', () => {
  const { tools } = harness()
  for (const name of ['image_info', 'crop_image', 'resize_image']) {
    const definition = tools.get(name)
    assert.ok(definition !== undefined, `${name} 应注册`)
    assert.equal(definition.parameters.type, 'object')
    assert.ok(definition.description.length > 0)
  }
})

console.log(`\n${passed} 项通过`)
