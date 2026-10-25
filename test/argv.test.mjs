/**
 * argv 构造的纯函数自测。
 * 运行：node test/argv.test.mjs
 */
import assert from 'node:assert/strict'
import {
  DEFAULT_PIP_INDEX_URL,
  doclingArgv,
  mirrorHost,
  pipInstallArgv,
  pipShowArgv,
  tarPackArgv
} from '../lib/argv.js'

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`  ok  ${name}`)
}

console.log('argv')

check('pip 安装 argv 带镜像与 trusted-host', () => {
  const argv = pipInstallArgv({ packages: ['docling'], indexUrl: DEFAULT_PIP_INDEX_URL })
  assert.equal(argv[0], '-m')
  assert.equal(argv[1], 'pip')
  assert.equal(argv[2], 'install')
  assert.ok(argv.includes('--index-url'))
  assert.ok(argv.includes(DEFAULT_PIP_INDEX_URL))
  assert.ok(argv.includes('--trusted-host'))
  assert.ok(argv.includes('pypi.tuna.tsinghua.edu.cn'))
  assert.ok(argv.includes('--no-input'))
  assert.equal(argv.at(-1), 'docling')
})

check('pip 安装 argv 支持 upgrade / user 与版本约束', () => {
  const argv = pipInstallArgv({ packages: ['docling==2.5.0', 'pypdf'], indexUrl: DEFAULT_PIP_INDEX_URL, upgrade: true, user: true })
  assert.ok(argv.includes('--upgrade'))
  assert.ok(argv.includes('--user'))
  assert.equal(argv.at(-1), 'pypdf')
})

check('pip show argv', () => {
  assert.deepEqual(pipShowArgv(['docling']), ['-m', 'pip', 'show', 'docling'])
})

check('镜像主机名解析', () => {
  assert.equal(mirrorHost(DEFAULT_PIP_INDEX_URL), 'pypi.tuna.tsinghua.edu.cn')
  assert.equal(mirrorHost('not a url'), undefined)
})

check('tar 打包 argv（-a 自动选格式）', () => {
  assert.deepEqual(tarPackArgv({ output: 'C:/a/out/book.zh.zip', dir: 'C:/a/out', items: ['book.zh.md', 'book.zh.docx'] }), [
    '-a', '-c', '-f', 'C:/a/out/book.zh.zip', '-C', 'C:/a/out', 'book.zh.md', 'book.zh.docx'
  ])
})

check('docling argv', () => {
  assert.deepEqual(doclingArgv({ input: 'C:/a/book.pdf', outDir: 'C:/a/out/ocr' }), ['C:/a/book.pdf', '--output', 'C:/a/out/ocr'])
  assert.deepEqual(doclingArgv({ input: 'a.pdf', outDir: 'o', to: 'md' }), ['a.pdf', '--output', 'o', '--to', 'md'])
})

console.log(`\n${passed} 项通过`)
