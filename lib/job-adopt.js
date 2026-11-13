/**
 * 长任务响应式返回：超时不杀进程，转为后台作业。
 *
 * 解决什么问题：`sh`/`pwsh`/`run` 跑一条超过上限（默认 10 分钟）的命令时，
 * 以前只能先杀掉进程再报错 —— 命令白跑了，模型只能拆碎片重试。
 *
 * 现在如果宿主挂了 `ctx.jobs`（`@deepseek-ai/dsh-tool-jobs` 提供），超时那一刻
 * 把**已经在跑的进程**挂到后台作业上：进程继续跑，模型拿到作业 id，
 * 之后用 `job_output` 增量读输出、`job_kill` 终止。
 *
 * 这是"响应式"的关键：调用方不必预先预测要跑多久，也不必阻塞等它。
 *
 * `ctx.jobs.start(spec)` 的真实契约（读 dsh-jobs-local 源码确认）：
 *   - 返回 **id 字符串**，不是 handle；
 *   - `spec.run(handle)` 同步返回 `{ done: Promise<{status, detail?}>, cancel() }`；
 *   - handle 提供 `append(text)` / `updateProgress(line)`。
 */

/** 作业类型标签（`job_list` 里显示）。 */
export const JOB_KIND = 'process'

/**
 * 判断后台作业是否真的可用。
 *
 * `jobs.start()` 的契约：必须有 controller 服务这个 agent，否则抛
 * `JOB_CONTROLLER_UNAVAILABLE`（"load @deepseek-ai/dsh-tool-jobs in its composition"）。
 * 没挂 `tool-jobs` 时应当安静降级，而不是每次调用都抛一次。
 *
 * @param {object} ctx - 插件上下文。
 * @param {object} jobs - `ctx.get('jobs')` 的返回值。
 * @returns {boolean} 可用则为 true。
 */
export function jobControllerAvailable(ctx, jobs) {
  if (jobs === undefined || jobs === null || typeof jobs.start !== 'function') return false
  // 有些接缝暴露 servesOwner；能问就问，问不出来则乐观放行（由调用处的 try/catch 兜底）。
  if (typeof jobs.servesOwner !== 'function') return true
  try {
    // 传一个占位 owner：只要有 controller 已经注册，多数实现都会返回 true。
    const probe = { id: '\u0000probe' }
    return jobs.servesOwner(probe) === true
  } catch {
    // servesOwner 抛错说明状态不可判定，退回乐观放行。
    return true
  }
}

/**
 * 直接以后台作业的形式启动一个子进程，**立刻返回作业 id，不阻塞会话**。
 *
 * 与 {@link adoptAsJob} 的区别：这里是从一开始就不等待，适合明确知道要跑很久的命令
 * （训练、全量构建、大批量转换）。调用方拿到 id 后按需 `job_output` 增量读取。
 *
 * @param {object} ctx - 插件上下文（需有 `jobs` 服务）。
 * @param {object} exec - 工具执行上下文（作为作业 owner）。
 * @param {object} options - 启动参数。
 * @param {string} options.label - 作业显示名（命令摘要）。
 * @param {string} [options.kind] - 作业类型；默认 {@link JOB_KIND}。
 * @param {(onOutput: (text: string) => void) => Promise<{exitCode: number, signal?: string, stdout: string, stderr: string}>} options.run - 真正启动进程；
 *   拿到 `onOutput` 后把增量输出喂给它。
 * @returns {{id: string} | undefined} 作业句柄；没有 jobs 服务时 undefined（调用方应回退为同步执行）。
 */
export function startAsJob(ctx, exec, options) {
  let jobs
  try {
    jobs = ctx.get?.('jobs')
  } catch {
    jobs = undefined
  }
  if (jobs === undefined || jobs === null || typeof jobs.start !== 'function') return undefined
  // 没挂 tool-jobs 时 `start()` 会抛 JOB_CONTROLLER_UNAVAILABLE；
  // 这时应安静退回同步执行，而不是让命令失败。
  if (!jobControllerAvailable(ctx, jobs)) return undefined

  let stop
  try {
    const id = jobs.start({
      kind: options.kind ?? JOB_KIND,
      label: String(options.label ?? '').slice(0, 120) || 'process',
      owner: exec?.agent,
      run: (handle) => {
        const emit = (text) => {
          if (text === '' || text === undefined) return
          try { handle.append(String(text)) } catch { /* 作业已结束 */ }
        }
        // 进程从创建那刻起就在后台跑：本函数同步返回 hooks，不等它结束。
        const done = Promise.resolve()
          .then(() => options.run(emit))
          .then(
            (r) => ({ status: r.exitCode === 0 ? 'succeeded' : 'failed', detail: r.exitCode === 0 ? undefined : `退出码 ${r.exitCode}` }),
            (error) => ({ status: 'failed', detail: String(error) })
          )
        stop = () => {
          try { options.cancel?.() } catch { /* 已结束 */ }
        }
        return {
          done,
          cancel: () => { stop?.(); return Promise.resolve() }
        }
      }
    })
    return { id: String(id) }
  } catch (error) {
    ctx.logger?.warn?.(`agentkit: 后台启动失败 —— ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

/**
 * 把一个进行中的子进程托管为后台作业。
 *
 * @param {object} ctx - 插件上下文（需有 `jobs` 服务）。
 * @param {object} exec - 工具执行上下文（作为作业 owner）。
 * @param {object} options - 托管参数。
 * @param {string} options.label - 作业显示名（命令摘要）。
 * @param {string} [options.kind] - 作业类型；默认 {@link JOB_KIND}。
 * @param {(reason?: unknown) => void} options.cancelProcess - 终止子进程（job_kill 时调用）。
 * @param {Promise<{exitCode: number, cancelled?: boolean}>} options.done - 子进程结束信号。
 * @returns {{id: string, append: (text: string) => void} | undefined} 句柄；不可用时 undefined。
 */
export function adoptAsJob(ctx, exec, options) {
  let jobs
  try {
    jobs = ctx.get?.('jobs')
  } catch {
    jobs = undefined
  }
  // 没有 jobs 服务、或只有抽象接缝（无 start）时安静降级：调用方按普通超时处理。
  if (jobs === undefined || jobs === null || typeof jobs.start !== 'function') return undefined
  // `jobs.start()` 要求有人 attachController（由 @deepseek-ai/dsh-tool-jobs 挂载时完成）。
  // 没有 controller 时会抛 JOB_CONTROLLER_UNAVAILABLE；先探一下，避免把异常打成日志噪声。
  if (!jobControllerAvailable(ctx, jobs)) return undefined

  let append = () => {}
  try {
    const id = jobs.start({
      kind: options.kind ?? JOB_KIND,
      label: String(options.label ?? '').slice(0, 120) || 'process',
      owner: exec?.agent,
      run: (handle) => {
        append = (text) => {
          try { handle.append(text) } catch { /* 作业已结束 */ }
        }
        return {
          // 作业的"产出"就是子进程的生命周期
          done: options.done.then(
            (r) => ({ status: r.cancelled === true ? 'killed' : (r.exitCode === 0 ? 'succeeded' : 'failed') }),
            (error) => ({ status: 'failed', detail: String(error) })
          ),
          // job_kill → 终止子进程；终止失败也不该让作业卡住
          cancel: () => {
            try { options.cancelProcess() } catch { /* 已结束 */ }
            return Promise.resolve()
          }
        }
      }
    })
    return { id: String(id), append: (text) => append(text) }
  } catch (error) {
    ctx.logger?.warn?.(`agentkit: 转后台作业失败（按普通超时处理）—— ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}
