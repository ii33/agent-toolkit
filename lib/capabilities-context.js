/**
 * 能力清单上下文：把「本会话实际挂上了哪些能力」写进系统提示词。
 *
 * 问题：generic 预设的能力是按需开关的（`tools: [...]` × 设置页闸门），但开关状态
 * 不在模型可观测范围内。会话开头模型不知道 `doc`/`img`/`split` 开没开，试探成本高于
 * 直接用 shell，于是退化成 `sh -c` 一把梭。
 *
 * 这里注册一条低优先级动态上下文，列出工具名与几个"用哪个"的选择建议。
 * 文本为空时不产生任何提示词（例如能力全关）。
 *
 * @module @local/dsh-agent-toolkit/capabilities-context
 */

/** 每行说明：能力 → 它注册出来的工具名。 */
const TOOL_NAMES = {
  fs: ['read', 'read_many', 'write', 'edit', 'list_dir'],
  sftp: ['sftp_hosts', 'search_remote'],
  run: ['run'],
  sh: ['sh'],
  pwsh: ['pwsh'],
  env: ['env_setup', 'pip_install'],
  proxy: ['net_check'],
  doc: ['ocr_doc', 'merge_files', 'pack'],
  split: ['split_file'],
  img: ['read_image', 'image_info', 'crop_image', 'resize_image'],
  tasks: ['plan_init', 'task_update', 'task_show', 'stage_set'],
  guard: [],
  preset: ['preset_create', 'preset_list', 'preset_delete', 'preset_inject', 'preset_eject']
}

/**
 * 渲染能力清单文本。
 * @param {string[]} capabilities - 本次实际启用的能力名。
 * @returns {string} 提示词片段；无能力时为空串。
 */
export function renderCapabilities(capabilities) {
  if (!Array.isArray(capabilities) || capabilities.length === 0) return ''
  const lines = []
  for (const capability of capabilities) {
    const tools = TOOL_NAMES[capability]
    if (tools === undefined) continue
    if (tools.length === 0) continue
    lines.push(`- ${capability}: ${tools.join(', ')}`)
  }
  if (lines.length === 0) return ''
  return [
    '本会话由 agentkit 挂载的能力（其余能力未启用，不要尝试）：',
    ...lines,
    '',
    '优先用上面的工具，不要用 shell 代替它们：',
    '- 看文件用 read（默认不带行号，正文可直接作为 edit 的 old_string；要行号定位传 numbered: true），不要用 cat/head/tail/sed -n。',
    '- 搜内容用 grep，列目录用 list_dir，不要用 ls/dir/findstr。',
    '- 改文件用 edit（字面量替换、保留行尾与字符集）或 write，不要用 sed -i / 重定向覆盖。',
    '- 一次性看多个文件用 read_many，不要写 shell for 循环。'
  ].join('\n')
}

/**
 * 把能力清单注册为动态上下文。
 * @param {object} ctx - 预设作用域上下文。
 * @param {string[]} capabilities - 本次启用的能力。
 * @returns {boolean} 是否登记成功。
 */
export function applyCapabilitiesContext(ctx, capabilities) {
  const text = renderCapabilities(capabilities)
  if (text === '') return false
  if (typeof ctx?.systemPrompt?.context !== 'function') return false
  try {
    ctx.systemPrompt.context({
      name: 'agentkit:capabilities',
      // 110 与沙箱说明同档：在 persona 之后、任务面板之前。
      order: 110,
      text
    })
    return true
  } catch {
    return false
  }
}
