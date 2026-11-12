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
 *
 * 只列**实际注册成功**的工具：注册层会把与出货工具撞名、或已被本插件注册过的
 * 定义让出（`tools/registry.js` 的 `yielded`/`reentrant`），这些工具在提示词里
 * 出现而实际不可用会把模型引向"工具不存在"的失败。
 *
 * @param {string[]} capabilities - 本次启用的能力名。
 * @param {{registered?: string[], takenOver?: string[]}} [report] - 注册层报告。
 *   省略时退回按能力表全量列出（供单测与无注册层场景）。
 * @returns {string} 提示词片段；无能力或全被让出时为空串。
 */
export function renderCapabilities(capabilities, report) {
  if (!Array.isArray(capabilities) || capabilities.length === 0) return ''
  const available = report === undefined
    ? undefined
    : new Set([...(report.registered ?? []), ...(report.takenOver ?? [])])
  const lines = []
  for (const capability of capabilities) {
    const tools = TOOL_NAMES[capability]
    if (tools === undefined || tools.length === 0) continue
    const listed = available === undefined ? tools : tools.filter((tool) => available.has(tool))
    if (listed.length === 0) continue
    lines.push(`- ${capability}: ${listed.join(', ')}`)
  }
  if (lines.length === 0) return ''
  // 建议段落只针对**本插件自己提供**的工具。
  // `grep` / `glob` 由预设的 search-tools 行（@deepseek-ai/dsh-tool-fs-search）提供，
  // 不在本能力表里 —— 早先这里写 `has('grep')` 恒为 false，那条建议永远不会出现，
  // 还容易让人以为 grep 是本插件的工具。
  const has = (tool) => available === undefined || available.has(tool)
  const advice = []
  if (has('read')) {
    advice.push(`- 看文件用 read（默认不带行号，正文可直接作为 edit 的 old_string；要行号定位传 numbered: true），不要用 cat/head/tail/sed -n。`)
  }
  if (has('read_many')) advice.push('- 一次性看多个文件用 read_many，不要写 shell for 循环。')
  if (has('list_dir')) advice.push('- 列目录用 list_dir，不要用 ls/dir/Get-ChildItem。')
  const editors = ['edit', 'write'].filter(has)
  if (editors.length > 0) {
    advice.push(`- 改文件用 ${editors.join(' 或 ')}（字面量替换、保留行尾与字符集），不要用 sed -i / 重定向覆盖。`)
  }
  // glob / grep 的默认行为会包含被忽略与隐藏文件（缓存、历史快照、沙箱副本）。
  // 不限定范围拿到的清单不可信，枚举类结论必须用 path 收窄。
  advice.push('- 检索（glob / grep）会包含被忽略与隐藏的文件：枚举结果必须用 path 限定到真实源码目录，否则缓存目录与历史快照会污染清单。')
  return [
    // 措辞必须**限定作用域**：这段只描述 agentkit 自己挂了什么。
    // 早先写成「其余能力未启用，不要尝试」被读成"本会话的工具全集"，
    // 导致模型误判 subagent / grep / glob / web_search / job_* 不可用而放弃委派
    // （实测发生过：模型据此以为起不了子代理，自己串行干了本该并行的任务）。
    // 事实上这些工具来自 dsh-base 与其它出货插件，与这段清单无关。
    'agentkit 挂载的能力（仅描述本插件自己注册的工具；其它来源的工具照常可用，以你实际看到的工具列表为准）：',
    ...lines,
    ...(advice.length === 0 ? [] : ['', '优先用上面的工具，不要用 shell 代替它们：', ...advice])
  ].join('\n')
}

/**
 * 把能力清单注册为动态上下文。
 *
 * 必须是**动态** `text` 函数而不是静态字符串：设置页改能力 → HMR 重载 → 已存在的
 * 会话仍持有旧上下文对象。静态字符串会把「已经关掉的能力」一直留在提示词里
 * （实测：设置页把 sftp/preset 关掉后，旧会话的提示词仍宣传两者）。
 *
 * @param {object} ctx - 预设作用域上下文。
 * @param {string[]} capabilities - 本次启用的能力。
 * @param {{registered?: string[], takenOver?: string[]}} [report] - 注册层报告；
 *   传入时只列实际可用的工具（推荐）。
 * @returns {boolean} 是否登记成功。
 */
export function applyCapabilitiesContext(ctx, capabilities, report) {
  const initial = renderCapabilities(capabilities, report)
  if (initial === '') return false
  if (typeof ctx?.systemPrompt?.context !== 'function') return false
  try {
    ctx.systemPrompt.context({
      name: 'agentkit:capabilities',
      // 110 与沙箱说明同档：在 persona 之后、任务面板之前。
      order: 110,
      // 每次组装都重新渲染：能力被关掉后，旧会话的下一轮提示词立刻不再提它。
      text: () => renderCapabilities(capabilities, report)
    })
    return true
  } catch {
    return false
  }
}
