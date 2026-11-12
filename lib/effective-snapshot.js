/**
 * 生效快照：把"这次实际注册了哪些工具"落盘，让能力开关的效果**可见**。
 *
 * 解决什么问题：设置页勾选/取消能力后，除了日志里几行字，用户没有任何办法确认
 * 它到底生效了没有 —— 表现为"打开了但完全看不出来有没有生效"。
 *
 * 快照写入 `<STATE_DIR>/effective.json`，包含：
 *   - 时间戳（什么时候算出来的）
 *   - 每个能力的开关状态与**实际注册成功的工具名**
 *   - 被让出 / 被接管 / 重入跳过的工具（解释"为什么没出现"）
 *
 * 它是只读观测数据：不参与任何决策，删掉也会自动重建。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 状态目录（与 presets.generated.json 同目录；测试可用环境变量改到临时目录）。 */
const STATE_DIR = process.env.DSH_AGENTKIT_STATE_DIR ?? fileURLToPath(new URL('..', import.meta.url))

/** 快照文件名。 */
const SNAPSHOT_FILE = join(STATE_DIR, 'effective.json')

/**
 * 每个能力会带来哪些工具名（用于把注册结果归到能力名下）。
 * 与 lib/capabilities-context.js 的 TOOL_NAMES 保持一致；这里只用于归因展示。
 */
const CAPABILITY_TOOLS = {
  fs: ['read', 'read_many', 'write', 'edit', 'list_dir'],
  run: ['run'],
  sh: ['sh'],
  pwsh: ['pwsh'],
  sftp: ['sftp_hosts', 'search_remote'],
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
 * 计算并写入生效快照。
 *
 * @param {string[]} enabled - 本次启用的能力（闸门）。
 * @param {object|undefined} report - `collisionReportOf(ctx)` 的注册层报告。
 * @param {object} [logger] - 记录写入失败，不让观测逻辑打断主流程。
 * @returns {{file: string, at: string, capabilities: object, total: number}} 快照对象。
 */
export function writeEffectiveSnapshot(enabled, report, logger) {
  const registered = [...(report?.registered ?? []), ...(report?.takenOver ?? []).map((item) => item.name)]
  const registeredSet = new Set(registered)
  const capabilities = {}
  for (const [name, tools] of Object.entries(CAPABILITY_TOOLS)) {
    const on = Array.isArray(enabled) && enabled.includes(name)
    const present = tools.filter((tool) => registeredSet.has(tool))
    capabilities[name] = {
      // on = 闸门打开；active = 真的注册出了工具（两者不同就说明有问题）
      on,
      active: on ? present.length > 0 || tools.length === 0 : false,
      tools: present
    }
  }
  const snapshot = {
    at: new Date().toISOString(),
    // 不启用任何能力时不写 enabled 开关列表（undefined 表示"没配过闸门"）
    enabled: Array.isArray(enabled) ? enabled : null,
    registered: [...registeredSet].sort(),
    total: registeredSet.size,
    capabilities,
    // 没出现的原因：让出（同作用域已有同名）、接管、重入跳过
    yielded: (report?.yielded ?? []).map((item) => ({ name: item.name, why: item.why })),
    takenOver: (report?.takenOver ?? []).map((item) => ({ name: item.name, why: item.why })),
    skipped: [...(report?.reentrant ?? [])]
  }
  try {
    mkdirSync(dirname(SNAPSHOT_FILE), { recursive: true })
    writeFileSync(SNAPSHOT_FILE, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
  } catch (error) {
    logger?.warn?.(`agentkit: 写生效快照失败（不影响功能）—— ${error instanceof Error ? error.message : String(error)}`)
  }
  return { file: SNAPSHOT_FILE, ...snapshot }
}

/** 快照文件路径（供提示与测试）。 */
export const EFFECTIVE_SNAPSHOT_FILE = SNAPSHOT_FILE
