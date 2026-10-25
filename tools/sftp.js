/**
 * SFTP 能力：把远程主机代号暴露给模型，并管理侧车会话。
 *
 * 模型只需要知道一件事：**代号代表一台远程主机**，把它写在路径最前面
 * （`nas:/data/book.md`）就能用同一套 read_text / write_text / edit_text / list_dir 操作远程文件。
 * 本工具负责让模型发现有哪些代号、验证凭据是否可用、以及手动断开连接。
 *
 * @module @local/dsh-doc-pipeline/sftp
 */
import { closeAllSessions, closeSession, loadHosts, remotePing, resolveRemote, sessionInfo } from '../lib/remote.js'
import { removeHost, saveHost } from '../lib/settings.js'
import { createToolRegistrar } from './registry.js'

/** 需要工具注册表与文件系统（读配置）。 */
export const inject = ['tools', 'fs']

/**
 * 定义 sftp_hosts。
 * @param {object} ctx - 插件上下文。
 * @returns {object} 工具定义。
 */
function sftpHostsDefinition(ctx) {
  return {
    name: 'sftp_hosts',
    description: '管理远程 SFTP 主机代号；代号可直接写在路径里（形如 `代号:/远程/路径`），'
      + 'read_text / write_text / edit_text / list_dir / read_image 都支持。'
      + 'action：list 列出代号与连接状态；add 写入一台主机（用 password_env 指定环境变量名，不要给明文密码）；'
      + 'remove 删除；ping 真实连接以验证凭据；close 断开常驻连接。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'remove', 'ping', 'close'], description: '默认 list。' },
        code: { type: 'string', description: '主机代号（小写字母/数字/下划线/短横线）；除 list 外都必填。' },
        host: { type: 'string', description: 'add：主机名或 IP。' },
        user: { type: 'string', description: 'add：登录用户名。' },
        port: { type: 'number', description: 'add：端口，默认 22。' },
        key: { type: 'string', description: 'add：私钥路径（支持 ~ 开头）。' },
        password_env: { type: 'string', description: 'add：存放密码的**环境变量名**（不要写明文密码）。' },
        root: { type: 'string', description: 'add：远程根目录，代号路径会拼在它下面。' },
        description: { type: 'string', description: 'add：一句话说明，供模型识别这台主机。' },
        strict_host_key: { type: 'boolean', description: 'add：是否用 ~/.ssh/known_hosts 校验主机键，默认 true。' }
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string' },
          file: { type: 'string' },
          error: { type: 'string' },
          lines: { type: 'array', items: { type: 'string' } }
        },
        required: ['action', 'lines']
      },
      render: (_args, value) => [{
        type: 'text',
        text: `<sftp action="${value.action}"${value.file === undefined ? '' : ` config="${value.file}"`}/>${value.error === undefined ? '' : `\n配置问题：${value.error}`}\n${value.lines.join('\n')}`
      }]
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const action = typeof args?.action === 'string' && args.action !== '' ? args.action : 'list'
      const { hosts, file, error } = await loadHosts(ctx, exec)
      const live = new Map(sessionInfo().map((entry) => [entry.code, entry]))

      if (action === 'list') {
        const codes = Object.keys(hosts)
        if (codes.length === 0) {
          return {
            action,
            ...(file === undefined ? {} : { file }),
            ...(error === undefined ? {} : { error }),
            lines: [
              '还没有配置任何远程主机。',
              '在工作区根目录创建 sftp-hosts.json，形如：',
              '{"hosts":{"nas":{"host":"10.0.0.5","user":"me","key":"C:/Users/me/.ssh/id_ed25519","root":"/volume1","description":"家庭 NAS 文档库"}}}',
              '配置后即可用 `nas:/path/to/file` 访问。'
            ]
          }
        }
        const lines = codes.map((code) => {
          const host = hosts[code]
          const state = live.get(code)
          const where = `${host.host ?? '?'}:${host.port ?? 22}`
          const root = host.root === undefined ? '' : ` root=${host.root}`
          const desc = host.description === undefined ? '' : ` — ${host.description}`
          const conn = state === undefined ? '未连接' : `连接中(登录 ${state.logins} 次)`
          return `\`${code}\` → ${where} user=${host.user ?? '(默认)'}${root} [${conn}]${desc}`
        })
        return {
          action,
          ...(file === undefined ? {} : { file }),
          ...(error === undefined ? {} : { error }),
          lines
        }
      }

      const code = typeof args?.code === 'string' ? args.code.trim().toLowerCase() : ''
      if (code === '') throw new Error(`${action} 需要 code（主机代号）`)
      if (!/^[a-z][a-z0-9_-]{0,31}$/u.test(code)) {
        throw new Error(`代号不合法：${code}（小写字母开头，只含小写字母/数字/下划线/短横线）`)
      }

      if (action === 'remove') {
        const result = await removeHost(ctx, exec, code)
        await closeSession(code)
        return {
          action,
          file: result.file,
          lines: [result.removed ? `已删除 \`${code}\`（现有 ${result.hosts} 台）` : `设置里没有 \`${code}\``]
        }
      }

      if (action === 'add') {
        const host = typeof args?.host === 'string' && args.host.trim() !== '' ? args.host.trim() : undefined
        if (host === undefined) throw new Error('add 需要 host（主机名或 IP）')
        const config = {
          host,
          ...(typeof args?.user === 'string' && args.user !== '' ? { user: args.user } : {}),
          ...(Number.isInteger(args?.port) ? { port: args.port } : {}),
          ...(typeof args?.key === 'string' && args.key !== '' ? { key: args.key } : {}),
          ...(typeof args?.password_env === 'string' && args.password_env !== '' ? { password_env: args.password_env } : {}),
          ...(typeof args?.root === 'string' && args.root !== '' ? { root: args.root } : {}),
          ...(typeof args?.description === 'string' && args.description !== '' ? { description: args.description } : {}),
          ...(args?.strict_host_key === false ? { strict_host_key: false } : {})
        }
        const result = await saveHost(ctx, exec, code, config)
        return {
          action,
          file: result.file,
          lines: [`已写入 \`${code}\` → ${host}（现有 ${result.hosts} 台）`, '接下来用 action=ping 验证凭据。']
        }
      }

      if (action === 'close') {
        const closed = await closeSession(code)
        return { action, lines: [closed ? `已断开 \`${code}\` 的常驻连接。` : `\`${code}\` 当前没有活动连接。`] }
      }

      const remote = await resolveRemote(ctx, exec, `${code}:/`)
      if (remote === undefined) {
        throw new Error(`代号 \`${code}\` 不在 sftp-hosts.json 里（用 action=list 查看可用代号）`)
      }
      const result = await remotePing(ctx, exec, remote)
      return {
        action,
        lines: [`\`${code}\` 连接${result.connected ? '成功' : '未建立'}，本次进程累计登录 ${result.logins} 次。`]
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `SFTP ${args.action ?? 'list'}`, kind: 'other' }
    }
  }
}

/**
 * 挂载 sftp_hosts，并在卸载时回收所有侧车进程。
 * @param {object} ctx - preset 作用域的插件上下文。
 */
export function apply(ctx) {
  const register = createToolRegistrar(ctx)
  register(sftpHostsDefinition(ctx))
  ctx.effect(() => () => closeAllSessions(), 'agent-toolkit:sftp:cleanup')
}
