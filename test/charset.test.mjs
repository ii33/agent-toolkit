/**
 * 字符集写回测试：通过 Python 助手做 GBK / UTF-16 的编码往返，
 * 用本包自己的解码器读回来验证一致性。
 *
 * 运行：node test/charset.test.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pythonArg, pythonScript } from './deps.mjs'
import { decodeText } from '../lib/encoding.js'

const HELPER = fileURLToPath(new URL('../lib/encode_write.py', import.meta.url))
const PY = pythonScript(HELPER)

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`  ok  ${name}`)
}

/** 调 --encode-only 模式拿字节。 */
function encodeOnly(encoding, bom, text) {
  const result = spawnSync(PY.command, [PY.script, '--encode-only', encoding, bom ? '1' : '0'], {
    cwd: PY.cwd,
    input: Buffer.from(text, 'utf8'),
    encoding: 'buffer',
    timeout: 30_000
  })
  assert.equal(result.status, 0, `python 退出码 ${result.status}: ${result.stderr?.toString() ?? ''}`)
  return new Uint8Array(Buffer.from(result.stdout.toString('ascii').trim(), 'base64'))
}

/** 调写文件模式。 */
function writeFile(encoding, bom, text, path) {
  const result = spawnSync(PY.command, [PY.script, pythonArg(path), encoding, bom ? '1' : '0'], {
    cwd: PY.cwd,
    input: Buffer.from(text, 'utf8'),
    encoding: 'utf8',
    timeout: 30_000
  })
  assert.equal(result.status, 0, `python 退出码 ${result.status}: ${result.stderr ?? ''}`)
  return /ok (\d+)/u.exec(result.stdout ?? '')
}

console.log('charset')

check('GBK 编码往返', () => {
  const bytes = encodeOnly('gbk', false, '中文测试')
  assert.deepEqual([...bytes], [0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4])
  const decoded = decodeText(bytes)
  assert.equal(decoded.encoding, 'gbk')
  assert.equal(decoded.text, '中文测试')
})

check('UTF-16LE 带 BOM 编码往返', () => {
  const bytes = encodeOnly('utf-16le', true, '中文')
  assert.deepEqual([...bytes.slice(0, 2)], [0xff, 0xfe])
  const decoded = decodeText(bytes)
  assert.equal(decoded.encoding, 'utf-16le')
  assert.equal(decoded.bom, true)
  assert.equal(decoded.text, '中文')
})

check('UTF-8 带 BOM 编码往返', () => {
  const bytes = encodeOnly('utf-8', true, 'hello')
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf])
  const decoded = decodeText(bytes)
  assert.equal(decoded.encoding, 'utf-8')
  assert.equal(decoded.bom, true)
  assert.equal(decoded.text, 'hello')
})

check('写文件模式原子落盘并可读回', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-charset-'))
  try {
    const path = join(directory, 'gbk.txt')
    const match = writeFile('gbk', false, '第一行\n第二行\n', path)
    assert.ok(match !== null, '应当回报 ok <bytes>')
    const decoded = decodeText(readFileSync(path))
    assert.equal(decoded.encoding, 'gbk')
    assert.equal(decoded.text, '第一行\n第二行\n')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

check('不支持的字符集报错而不是写乱码', () => {
  const result = spawnSync(PY.command, [PY.script, '--encode-only', 'utf-32', '0'], {
    cwd: PY.cwd,
    input: Buffer.from('x', 'utf8'),
    encoding: 'utf8',
    timeout: 30_000
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr ?? '', /unsupported encoding/)
})

console.log(`\n${passed} 项通过`)
