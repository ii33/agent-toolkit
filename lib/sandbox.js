/**
 * 沙箱提权：让模型能就**一次**写入申请更宽的模式，走用户审批，一次性生效。
 *
 * 为什么需要：本工具集只盖章"当前策略"，所以工作区外的写入会被后端拒绝，而模型
 * 手里没有申请放宽的手段（出货的 write/edit 有 `sandbox_permissions` 参数，我的原来没有）。
 * 这里把它补齐，语义与出货一致：
 *   - 两个参数**只在挂载了沙箱策略服务时才广告**（`ctx.get('sandboxPolicy')` 有定义；
 *     0.2.1-rc.2 的 fs 提供者已不再暴露 `sandboxMode`）；
 *   - 两个参数必须成对出现，且只能申请**更宽**的模式；
 *   - 申请走 `ctx.approval.request()`，只有 `allowed-once`（一次性许可）才执行；
 *   - 重复当前模式不需要审批。
 *
 * 另外还负责一件出货工具不需要管、但这里必须管的事：**非 UTF-8 写回绕过了 fs 服务**
 * （走 Python 助手直接落盘），所以那条路径要自己做围栏自检——read-only 一律拒绝、
 * workspace-write 要求目标在工作区根之内。
 *
 * @module @local/dsh-agent-toolkit/sandbox
 */

/** 可申请的目标模式（比 read-only 更宽的两级）。 */
export const ESCALATION_TARGETS = ['workspace-write', 'danger-full-access']

/** 模式强弱排序。 */
const MODE_RANK = { 'read-only': 0, 'workspace-write': 1, 'danger-full-access': 2 }

/**
 * 当前组合是否挂着能围栏的文件系统后端。
 *
 * 0.2.1-rc.2 的 `fs` 服务契约里**没有** `sandboxMode` 成员（对照 Service 'fs' 的方法目录：
 * resolve/processPath/contains/stat/readText/writeText/editText/…），围栏能力改由
 * `sandboxPolicy` 服务体现（`resolve()` → `{ mode, workspaceRoot }`）。只看 `fs.sandboxMode`
 * 会让这里恒为 false，两个提权参数永远不广告 —— 提权功能静默失效。
 * @param {object} ctx - 插件上下文。
 * @returns {boolean} 是否可提权。
 */
export function sandboxConfined(ctx) {
  if (ctx?.get?.('sandboxPolicy') !== undefined) return true
  // 老后端若仍暴露 sandboxMode 也认，保持向后兼容。
  return ctx?.fs?.sandboxMode !== undefined
}

/**
 * 提权参数：只在会围栏的组合里广告，避免给不必提权的部署增加噪声。
 * @param {object} ctx - 插件上下文。
 * @returns {Record<string, unknown>} 参数片段（或空对象）。
 */
export function escalationSchemaFields(ctx) {
  if (!sandboxConfined(ctx)) return {}
  return {
    sandbox_permissions: {
      type: 'string',
      enum: [...ESCALATION_TARGETS],
      description: '仅在当前沙箱模式拒绝该操作时使用：申请一次性放宽到该模式。必须与 justification 同时提供，用户会收到审批。'
    },
    justification: {
      type: 'string',
      description: '与 sandbox_permissions 配对：一句话说明这次操作为什么需要更宽权限，使用用户当前的语言。'
    }
  }
}

/**
 * 校验提权参数配对。
 * @param {unknown} mode - `sandbox_permissions`。
 * @param {unknown} justification - `justification`。
 */
export function validateEscalationArgs(mode, justification) {
  if (mode === undefined && justification === undefined) return
  if (mode === undefined || justification === undefined) {
    throw new Error('sandbox_permissions 与 justification 必须同时提供')
  }
  if (typeof mode !== 'string' || !ESCALATION_TARGETS.includes(mode)) {
    throw new Error(`sandbox_permissions 只能是 ${ESCALATION_TARGETS.join(' / ')}`)
  }
  if (typeof justification !== 'string' || justification.trim() === '') {
    throw new Error('justification 不能是空字符串')
  }
}

/**
 * 解析本次写入要用的策略：带提权参数时走审批拿一次性许可。
 * @param {object} ctx - 插件上下文。
 * @param {object} exec - 工具执行上下文。
 * @param {object} args - 工具参数。
 * @param {string} toolName - 工具名（进审批审计）。
 * @returns {Promise<object|undefined>} 要盖章的策略。
 */
export async function resolveWritePolicy(ctx, exec, args, toolName) {
  const policyService = ctx.get('sandboxPolicy')
  const standing = policyService === undefined
    ? undefined
    : policyService.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
  const mode = args?.sandbox_permissions
  const justification = args?.justification
  validateEscalationArgs(mode, justification)
  if (mode === undefined) return standing
  if (standing === undefined) throw new Error('当前组合没有沙箱策略服务，无法提权')
  if ((MODE_RANK[mode] ?? -1) <= (MODE_RANK[standing.mode] ?? -1)) {
    throw new Error(`sandbox_permissions 只能申请比当前模式（${standing.mode}）更宽的模式`)
  }
  const approval = ctx.get('approval')
  if (approval === undefined || exec.agent === undefined) {
    throw new Error('提权需要审批通道（ctx.approval）与 agent 上下文，当前不可用')
  }
  const request = `申请放宽沙箱模式：${standing.mode} → ${mode}。理由：${justification}`
  const outcome = await approval.request({
    agent: exec.agent,
    toolName,
    ...(exec.callId === undefined ? {} : { callId: exec.callId }),
    reason: request,
    displayReason: { zh: request, en: request },
    signal: exec.signal
  })
  if (outcome !== 'allowed-once') {
    throw new Error(`提权未获批准（${outcome}）：请改写到工作区内，或请用户放宽会话的沙箱策略`)
  }
  return { ...standing, mode }
}

/**
 * 给沙箱拒绝加上"可重试一次"的可执行提示。
 * @param {unknown} error - 写路径抛出的错误。
 * @param {object|undefined} policy - 本次盖章的策略。
 * @returns {unknown} 原错误，或带提示的新错误。
 */
export function withSandboxHint(error, policy) {
  const message = error instanceof Error ? error.message : String(error)
  const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined
  if (code !== 'FS_SANDBOX_DENIED' && !/sandbox/i.test(message)) return error
  const hint = `[沙箱拒绝：当前模式 ${policy?.mode ?? '(未知)'}] 这次写入确实需要工作区外时，可带 sandbox_permissions（workspace-write 或 danger-full-access）与 justification 重试一次，用户会收到审批；否则请改写工作区内的路径。`
  return new Error(`${message}\n${hint}`)
}

/**
 * 围栏自检：给**绕过 fs 服务**的写路径（Python 助手按原字符集写回）兜底。
 * @param {object} ctx - 插件上下文。
 * @param {object|undefined} policy - 本次盖章的策略。
 * @param {object} target - 已解析的 FsTarget。
 * @returns {Promise<void>} 被拒时抛错。
 */
export async function assertPathAllowed(ctx, policy, target) {
  if (policy === undefined) return
  if (policy.mode === 'read-only') {
    throw new Error(`[沙箱拒绝：read-only] 当前会话不允许写入 "${target.displayPath}"`)
  }
  if (policy.mode !== 'workspace-write') return
  if (policy.workspaceRoot === undefined) return
  const root = await ctx.fs.resolve(policy.workspaceRoot)
  if (!ctx.fs.contains(root, target)) {
    throw new Error(`[沙箱拒绝：workspace-write] "${target.displayPath}" 不在工作区 ${policy.workspaceRoot} 内；`
      + '这次写入确实需要工作区外时，可带 sandbox_permissions 与 justification 重试一次（用户会收到审批）')
  }
}
