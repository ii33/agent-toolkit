/**
 * 远程 shell 禁令的离线测试（纯函数）。
 *
 * 运行：node test/shell-ban.test.mjs
 */
import assert from 'node:assert/strict'
import { BANNED_SHELL_TOKENS, REMOTE_EXECUTORS, localShellBanReason, remoteShellBanReason } from '../lib/shell-ban.js'

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`  ok  ${name}`)
}

console.log('shell ban')

check('远程执行器 + 被禁 shell → 拒绝（含常见写法）', () => {
  assert.equal(typeof remoteShellBanReason('ssh win1 powershell -Command "Get-Process"'), 'string')
  assert.equal(typeof remoteShellBanReason('ssh win1 "powershell.exe -Command dir"'), 'string')
  assert.equal(typeof remoteShellBanReason('ssh win1 cmd /c dir'), 'string')
  assert.equal(typeof remoteShellBanReason('plink -batch win1 cmd.exe /c whoami'), 'string')
  assert.equal(typeof remoteShellBanReason('sshpass -p x ssh win1 powershell -c dir'), 'string')
  assert.equal(typeof remoteShellBanReason('psexec \\\\win1 cmd /c dir'), 'string')
  assert.equal(typeof remoteShellBanReason(['ssh', 'win1', 'cmd', '/c', 'dir']), 'string')
})

check('远程执行器 + 放行的 shell → 通过', () => {
  assert.equal(remoteShellBanReason('ssh remote1 pwsh -Command "Get-Process"'), undefined)
  assert.equal(remoteShellBanReason('ssh remote1 bash -lc "ls -la"'), undefined)
  assert.equal(remoteShellBanReason('ssh remote1 sh -c "df -h"'), undefined)
  assert.equal(remoteShellBanReason('ssh remote1 cat /etc/hostname'), undefined)
  assert.equal(remoteShellBanReason(['ssh', 'remote1', 'uname', '-a']), undefined)
})

check('本地命令（没有远程执行器）不受影响', () => {
  assert.equal(remoteShellBanReason('echo hello'), undefined)
  assert.equal(remoteShellBanReason('ls -la'), undefined)
  assert.equal(remoteShellBanReason('git status'), undefined)
  assert.equal(remoteShellBanReason(''), undefined)
  assert.equal(remoteShellBanReason(undefined), undefined)
})

check('命令位置出现被禁 shell → 拒绝（本地也要拦）', () => {
  assert.equal(typeof localShellBanReason('powershell -c "Get-Process"'), 'string')
  assert.equal(typeof localShellBanReason('cmd /c dir'), 'string')
  assert.equal(typeof localShellBanReason('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -c x'), 'string')
  assert.equal(typeof localShellBanReason('FOO=1 powershell -c x'), 'string')
  assert.equal(typeof localShellBanReason('sudo cmd /c dir'), 'string')
  assert.equal(typeof localShellBanReason('ls -la; powershell -c x'), 'string')
  assert.equal(typeof localShellBanReason('ls -la && cmd /c dir'), 'string')
})

check('命令位置不是被禁 shell → 放行（不误伤检索与放行 shell）', () => {
  assert.equal(localShellBanReason('grep -i powershell log.txt'), undefined)
  assert.equal(localShellBanReason('echo powershell'), undefined)
  assert.equal(localShellBanReason('rg "cmd /c" README.md'), undefined)
  assert.equal(localShellBanReason('pwsh -NoProfile -Command "Get-Date"'), undefined)
  assert.equal(localShellBanReason('sh -c "ls -la"'), undefined)
  assert.equal(localShellBanReason('python -m pip install pillow'), undefined)
  assert.equal(localShellBanReason(''), undefined)
})

check('名单与本地 guard 一致（禁 5.1 与 cmd，不牵连 pwsh）', () => {
  assert.deepEqual(BANNED_SHELL_TOKENS, ['powershell', 'cmd'])
  assert.equal(BANNED_SHELL_TOKENS.includes('pwsh'), false)
  assert.ok(REMOTE_EXECUTORS.includes('ssh'))
})

console.log(`\n${passed} 项通过`)
