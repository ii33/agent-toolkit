/**
 * 客户端半边：插件 →「通用 agent 工具集」的设置页。
 *
 * 功能：
 *   ① 全局能力开关（闸门）
 *   ② 软件源镜像 / 外网代理
 *   ③ **预设管理**：单选框选中一个预设 → 自动读取它的声明 → 显示/编辑它的
 *      工具集能力与 persona（prefix）→ 保存（写入宿主行的 preset_edits）
 *   ④ **新建预设**：id / 名称 / 能力 / persona → 保存（写入宿主行的 preset_new）
 *
 * 读写通道（都已实测）：
 *   - 读预设列表：`agentPresets.list()` → `{ presets: [{id, name, order, isDefault}] }`
 *   - 读某预设声明：`agentPresets.read(id)` → `{ agentPreset, name, description, content }`（content 是插件列表 YAML）
 *   - 读写设置：`configForms.get('agentkit')` 的表单作用域（`getSnapshot()` / `subscribe()` / `mutate([ops], revision)`）
 *   客户端只能写设置 → 由宿主行 `agentkit` 据 preset_edits / preset_new / inject_into 渲染覆盖声明 ✓
 *
 * 模块格式（踩过两次的坑）：必须是 `window.__ModuleLoader__.load({ id, factory(require) {…} })`，
 * 用 `require` 取 React，`inject`/`apply` 挂在 `exports` 上，**末尾 `return module.exports`**。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-agentkit',
  factory(require) {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useState } = React

    /** 服务集合。 */
    const inject = ['slots', 'locale', 'remote', 'remote.agentPresets', 'configForms']

    /** bundle 包名 = `plugins.bundle.config` 的 key。 */
    const PACKAGE = '@local/dsh-agentkit'
    /** 宿主行 id = 设置命名空间。 */
    const HOST_NS = 'agentkit'
    /** 本插件自己的字典命名空间。 */
    const LOCALE_NS = 'agentkit.page'

    /** 词典。 */
    const zh = {
      title: '通用 agent 工具集',
      capable: '全局能力开关',
      capableHint: '闸门：这里关掉的能力，在所有挂了工具集的预设里都不再注册。',
      cap_fs: '文件读写 read / write / edit / list_dir / read_many：编码、换行、字符集全兜底；本地 + 代号:/远程；含沙箱提权',
      cap_sftp: '远程主机 sftp_hosts（代号增删查 + ping 验证）+ search_remote（远程内容检索，本地用 grep）',
      cap_run: 'argv 直连运行程序 run：不经 shell，不需要引号转义',
      cap_sh: 'bash（MSYS2 的 sh）：POSIX 管道与文本工具',
      cap_pwsh: 'PowerShell 7（pwsh）：Windows 原生操作用它，强制 UTF-8；5.1 与 cmd 被 guard 禁用',
      cap_env: '环境与依赖 env_setup / pip_install：探测环境、按镜像装依赖、结论写进 ENV.md',
      cap_proxy: '外网代理 net_check：直连慢或不通时，自动给子进程注入 HTTP(S)_PROXY',
      cap_doc: '文档处理 ocr_doc / merge_files / pack：docling OCR、按 manifest 合并、打包交付',
      cap_split: '大文件拆块 split_file：产出编号块文件 + manifest.json',
      cap_img: '图片：read_image 整图交给模型；image_info 看尺寸；crop_image 裁一块（默认直接给模型看）；resize_image 缩放',
      cap_tasks: '任务账本 plan_init / task_update / task_show / stage_set：进度写 TASKS.md，摘要注入上下文',
      cap_guard: '结构性 shell 禁令：禁 powershell / cmd / terminal*，放行 pwsh / sh',
      cap_preset: '预设管理 preset_create / list / delete / inject / eject：新建、列出、删除、注入、撤销',
      mirrors: '软件源镜像',
      mirrorsHint: '留空即用内置默认（清华 pip / npmmirror / hf-mirror）；镜像域名自动进 NO_PROXY，不走代理。',
      proxy: '外网代理',
      proxyHint: '直连慢或不通时，自动给子进程加 HTTP(S)_PROXY。',
      enabled: '启用代理探测',
      presets: '预设管理',
      presetsHint: '单选一个预设即可读取它的配置；下面的能力与 persona 只作用于该预设（不改动出货预设的其它行）。',
      loading: '读取中…',
      rosterFailed: '读取预设列表失败：',
      readFailed: '读取该预设失败：',
      noToolkit: '该预设当前没有挂工具集（保存时会加上）。',
      persona: 'persona（系统提示词 prefix）',
      personaHint: '留空 = 不改动它原有的 persona。保存即替换该预设的 prefix（其它配置行保持不动）。',
      suffixHint: 'suffix（persona 的第二段，如 standard 的 `Your working directory is {{cwd}}.`）；留空不动。',
      complete: 'complete：让 persona 独占提示词（关掉其它插件注入的段落；内置预设慎用）',
      contributors: '注意：该预设还有这些行会注入提示词段落 —— ',
      save: '保存到该预设',
      saved: '已保存；重载后生效',
      editSaved: '已保存的编辑（重载后该预设使用这些值）：',
      undoEdit: '撤销编辑（恢复原声明）',
      failed: '保存失败：',
      create: '新建预设',
      createHint: '填 id 与名字即可（能力默认 fs/sh/tasks，persona 留空则自动生成）。',
      createId: 'id（小写字母数字与连字符）',
      createName: '显示名',
      createDescription: '一句话说明',
      createHint2: '保存后重载，新预设出现在「新会话」的选择器里。',
      createButton: '创建',
      created: '已创建；重载后可见',
      injectInto: '也把工具集注入到（勾选）',
      current: '当前',
      noForm: '没有可用的设置表单：插槽没有传 form，configForms 也没提供该命名空间。',
      rejected: '宿主拒绝了这次保存（版本过期或设置只读）。'
    }
    const en = {
      title: 'General agent toolkit',
      capable: 'Global capabilities',
      capableHint: 'Gate: a capability disabled here is not registered in any preset that mounts the toolkit.',
      cap_fs: 'Files read / write / edit / list_dir / read_many: encoding, newline and charset safe; local + code:/remote; includes sandbox escalation',
      cap_sftp: 'Remote hosts sftp_hosts (codes, ping) + search_remote (content search over SFTP; use grep locally)',
      cap_run: 'run: argv-direct process execution, no shell, no quoting',
      cap_sh: 'bash (MSYS2 sh): POSIX pipes and text tools',
      cap_pwsh: 'PowerShell 7 (pwsh): native Windows work, UTF-8 forced; 5.1 and cmd are banned by guard',
      cap_env: 'Environment env_setup / pip_install: probe, install via mirror, write ENV.md',
      cap_proxy: 'Proxy net_check: inject HTTP(S)_PROXY into subprocesses when direct is slow or blocked',
      cap_doc: 'Documents ocr_doc / merge_files / pack: docling OCR, manifest merge, archive delivery',
      cap_split: 'split_file: numbered chunk files plus manifest.json',
      cap_img: 'Images: read_image (whole image), image_info (dimensions), crop_image (region, fed to the model), resize_image',
      cap_tasks: 'Task ledger plan_init / task_update / task_show / stage_set: progress in TASKS.md, summary injected',
      cap_guard: 'Structural shell ban: powershell / cmd / terminal* denied, pwsh / sh allowed',
      cap_preset: 'Presets preset_create / list / delete / inject / eject',
      mirrors: 'Package mirrors',
      mirrorsHint: 'Empty means built-in defaults (TUNA pip / npmmirror / hf-mirror); mirror hosts bypass the proxy.',
      proxy: 'Outbound proxy',
      proxyHint: 'When a direct connection is slow or blocked, subprocesses get HTTP(S)_PROXY.',
      enabled: 'Enable proxy probing',
      presets: 'Presets',
      presetsHint: 'Pick one preset to load its configuration; the capabilities and persona below apply to that preset only.',
      loading: 'Loading…',
      rosterFailed: 'Reading the preset roster failed: ',
      readFailed: 'Reading that preset failed: ',
      noToolkit: 'This preset does not mount the toolkit yet (saving will add it).',
      persona: 'persona (system prompt prefix)',
      personaHint: 'Empty leaves the existing persona untouched. Saving replaces that preset\u2019s prefix only.',
      suffixHint: 'suffix (persona\u2019s second part, e.g. standard\u2019s `Your working directory is {{cwd}}.`); empty leaves it.',
      complete: 'complete: let the persona own the whole prompt (drops sections injected by other plugins; risky on built-ins)',
      contributors: 'Note: these rows also inject prompt sections — ',
      save: 'Save to this preset',
      saved: 'Saved; applies after reload',
      editSaved: 'Saved edit (this preset uses these values after reload): ',
      undoEdit: 'Undo edit (restore the original declaration)',
      failed: 'Save failed: ',
      create: 'Create preset',
      createHint: 'An id and a name are enough (capabilities default to fs/sh/tasks).',
      createId: 'id (lowercase, digits, dashes)',
      createName: 'Display name',
      createDescription: 'One-line description',
      createHint2: 'After a reload the preset appears in the new-session picker.',
      createButton: 'Create',
      created: 'Created; visible after reload',
      injectInto: 'Also inject the toolkit into (tick)',
      current: 'current',
      noForm: 'No settings form is available: the slot passed no form and configForms serves no such namespace.',
      rejected: 'The Host refused this write (stale revision or read-only settings).'
    }

    /** 能力清单（与宿主 index.js 的 CAPABILITIES 一致）。 */
    const CAPABILITIES = ['fs', 'sftp', 'run', 'sh', 'pwsh', 'env', 'proxy', 'doc', 'split', 'img', 'tasks', 'guard', 'preset']
    /** 每条能力注册的工具数（实测口径，见 test/measure-capabilities.mjs）。 */
    const TOOL_COUNTS = {
      fs: 5, sftp: 2, run: 1, sh: 1, pwsh: 1, env: 2, proxy: 1,
      doc: 3, split: 1, img: 4, tasks: 4, guard: 0, preset: 5
    }
    /** 镜像字段。 */
    const MIRROR_FIELDS = ['pip_index_url', 'npm_registry', 'hf_endpoint']
    /** 代理字段。 */
    const PROXY_FIELDS = [
      { name: 'host', numeric: false },
      { name: 'port', numeric: true },
      { name: 'slow_ms', numeric: true }
    ]

    /** 读一个可能是 volatile 引用或普通值的字段。 */
    function plain(value) {
      if (value === undefined || value === null) return value
      if (typeof value === 'object' && typeof value.get === 'function') {
        try {
          return value.get()
        } catch {
          return undefined
        }
      }
      return value
    }

    /** 从任意"表单对象"取快照。 */
    function snapshotOf(source) {
      if (source === undefined || source === null) return undefined
      if (typeof source.getSnapshot === 'function') {
        try {
          return source.getSnapshot()
        } catch {
          return undefined
        }
      }
      return source
    }

    /**
     * 是否是真正的"设置表单作用域"。
     * 实测契约（0.2.1-rc.2 `@deepseek-ai/dsh-client-ui-settings/lib/client.js` 的
     * `ConfigFormController`）：getSnapshot() / subscribe(listener) / mutate(ops, revision)。
     * `configForms` 服务由同一个包的 `ConfigForms` 类提供（super(ctx, "configForms")）。
     * @param {unknown} value - 待判定的值。
     * @returns {boolean} 是否具备作用域三件套。
     */
    function isScope(value) {
      return value !== null && typeof value === 'object'
        && typeof value.getSnapshot === 'function' && typeof value.subscribe === 'function'
    }

    /**
     * 把插槽调用方可能传的"零件"形状包成作用域。
     * plugin-manager 的 `formFor(id)` 只传 `{ state, mutate }`（state 是 getSnapshot() 的结果），
     * 不是作用域本体；只有在拿不到 configForms 服务时才退到这条路上。
     * @param {unknown} parts - 插槽传进来的 form 值。
     * @returns {object|undefined} 作用域外观；形状不认识时 undefined。
     */
    function scopeFromParts(parts) {
      if (parts === null || typeof parts !== 'object') return undefined
      if (typeof parts.mutate !== 'function') return undefined
      const read = () => (parts.state === undefined
        ? undefined
        : { value: parts.state.value, revision: parts.state.revision })
      return {
        getSnapshot: read,
        subscribe: () => () => {},
        mutate: (ops, revision) => parts.mutate(ops, revision)
      }
    }

    /**
     * 解 Remote 方法的返回信封。
     * 实测契约：客户端 Remote 调用回 `{ ok: true, value }` 或 `{ ok: false, error: { message } }`
     * （见 `dsh-client-ui-settings/lib/client.js` 里 `remote.settings.describe()` 的读法）。
     * 也容忍直接返回负载本身（旧写法）。
     * @param {unknown} raw - Remote 返回值。
     * @param {string} what - 诊断用的方法名。
     * @returns {unknown} 负载。
     */
    function unwrapRemote(raw, what) {
      if (raw !== null && typeof raw === 'object' && raw.ok === false) {
        const message = raw.error !== null && typeof raw.error === 'object' && typeof raw.error.message === 'string'
          ? raw.error.message
          : `${what} failed`
        throw new Error(message)
      }
      return raw !== null && typeof raw === 'object' && raw.value !== undefined ? raw.value : raw
    }

    /**
     * 找插件列表里某一项的行范围。
     * 注意：harness 的 YAML dumper 会给字符串加引号（`- id: "toolkit"`），所以这里要容忍引号。
     */
    function entryRange(lines, entryId) {
      const wanted = new RegExp(`^- id:\\s*["']?${entryId}["']?\\s*$`)
      const start = lines.findIndex((line) => wanted.test(line.trim()))
      if (start === -1) return undefined
      let end = lines.length
      for (let index = start + 1; index < lines.length; index += 1) {
        if (/^- id: /.test(lines[index].trim())) {
          end = index
          break
        }
      }
      return { start, end }
    }

    /**
     * 读某个键的字符串列表，两种写法都支持：
     *   - 内联 `tools: [fs, sh]`
     *   - 块序列 `tools:` + 若干 `- fs` 行（harness 的 YAML dumper 用这种）
     * @param {string[]} lines - 行。
     * @param {number} from - 起始行。
     * @param {number} to - 结束行。
     * @param {string} key - 键名。
     * @returns {string[]|undefined} 列表；没有该键时 undefined。
     */
    function readListValue(lines, from, to, key) {
      const strip = (value) => value.trim().replace(/^["']|["']$/g, '')
      for (let index = from; index < to; index += 1) {
        const inline = new RegExp(`^\\s*${key}:\\s*\\[(.*)\\]\\s*$`).exec(lines[index])
        if (inline !== null) {
          return inline[1].split(',').map(strip).filter((name) => name !== '')
        }
        const head = new RegExp(`^(\\s*)${key}:\\s*$`).exec(lines[index])
        if (head !== null) {
          const indent = head[1].length
          const items = []
          for (let cursor = index + 1; cursor < to; cursor += 1) {
            const line = lines[cursor]
            if (line.trim() === '') continue
            if ((/^ */).exec(line)[0].length <= indent) break
            const item = /^\s*-\s*(.+)$/.exec(line)
            if (item !== null) items.push(strip(item[1]))
          }
          return items
        }
      }
      return undefined
    }

    /** 读该预设当前挂的工具集能力；没有 toolkit 行返回 undefined。 */
    function readCapabilities(content) {
      const lines = String(content ?? '').split('\n')
      const range = entryRange(lines, 'toolkit')
      if (range === undefined) return undefined
      return readListValue(lines, range.start, range.end, 'tools') ?? []
    }

    /** 读 persona 的某个文本字段（prefix / suffix）。 */
    function readPersonaText(content, key) {
      const lines = String(content ?? '').split('\n')
      const range = entryRange(lines, 'persona')
      if (range === undefined) return ''
      for (let index = range.start; index < range.end; index += 1) {
        const block = new RegExp(`^(\\s*)${key}:\\s*[|>][-+]?\\s*$`).exec(lines[index])
        if (block !== null) {
          const indent = block[1].length
          const body = []
          for (let cursor = index + 1; cursor < range.end; cursor += 1) {
            const line = lines[cursor]
            if (line.trim() !== '' && (/^ */).exec(line)[0].length <= indent) break
            body.push(line)
          }
          const nonEmpty = body.filter((line) => line.trim() !== '')
          const base = nonEmpty.length === 0 ? 0 : Math.min(...nonEmpty.map((line) => (/^ */).exec(line)[0].length))
          return body.map((line) => (line.trim() === '' ? '' : line.slice(base))).join('\n').replace(/\s+$/, '')
        }
        const inline = new RegExp(`^\\s*${key}:\\s*(.+)$`).exec(lines[index])
        if (inline !== null) return inline[1].replace(/^["']|["']$/g, '')
      }
      return ''
    }

    /** 读 persona 的三个字段：prefix / suffix / complete。 */
    function readPersonaFields(content) {
      const lines = String(content ?? '').split('\n')
      const range = entryRange(lines, 'persona')
      let complete = false
      if (range !== undefined) {
        for (let index = range.start; index < range.end; index += 1) {
          if (/^\s*complete:\s*true\s*$/.test(lines[index])) {
            complete = true
            break
          }
        }
      }
      return { prefix: readPersonaText(content, 'prefix'), suffix: readPersonaText(content, 'suffix'), complete }
    }

    /**
     * 该预设里"还会向系统提示词注入段落"的其它行。
     * persona 只给一句话时，其余段落由这些行分别注入（组合式提示词）。
     */
    function promptContributors(content) {
      const known = ['agent-instructions', 'skill-filesystem', 'planning', 'delegation', 'compaction', 'command-goal', 'tool-goal']
      const found = []
      for (const line of String(content ?? '').split('\n')) {
        const match = /^- id:\s*["']?([^"'\s]+)["']?\s*$/.exec(line.trim())
        if (match !== null && known.includes(match[1])) found.push(match[1])
      }
      return found
    }

    /** 一行输入框。 */
    function Field({ label, value, onCommit, numeric }) {
      const [draft, setDraft] = useState(String(value === undefined || value === null ? '' : value))
      useEffect(() => {
        setDraft(String(value === undefined || value === null ? '' : value))
      }, [value])
      return h('label', { style: { display: 'block', margin: '6px 0' } },
        h('span', { style: { display: 'block', fontSize: '12px', opacity: 0.75 } }, label),
        h('input', {
          type: numeric === true ? 'number' : 'text',
          value: draft,
          onChange: (event) => setDraft(event.target.value),
          onBlur: () => {
            const next = numeric === true ? Number(draft) : draft
            if (numeric === true && !Number.isFinite(next)) return
            onCommit(next)
          },
          style: {
            width: '100%', padding: '6px 8px', borderRadius: '6px',
            border: '1px solid var(--dsw-alias-border-l3, #d0d5dd)', background: 'transparent', color: 'inherit'
          }
        }))
    }

    /** 多行输入框（失焦提交）。 */
    function Area({ label, value, onCommit, hint, rows }) {
      const [draft, setDraft] = useState(value === undefined || value === null ? '' : value)
      useEffect(() => {
        setDraft(value === undefined || value === null ? '' : value)
      }, [value])
      return h('label', { style: { display: 'block', margin: '6px 0' } },
        h('span', { style: { display: 'block', fontSize: '12px', opacity: 0.75 } }, label),
        hint === undefined ? null : h('span', { style: { display: 'block', fontSize: '11px', opacity: 0.6, margin: '2px 0 4px' } }, hint),
        h('textarea', {
          value: draft,
          rows: rows === undefined ? 8 : rows,
          onChange: (event) => setDraft(event.target.value),
          onBlur: () => onCommit(draft),
          style: {
            width: '100%', padding: '6px 8px', borderRadius: '6px', font: 'inherit',
            border: '1px solid var(--dsw-alias-border-l3, #d0d5dd)', background: 'transparent', color: 'inherit'
          }
        }))
    }

    /** 开关。 */
    function Toggle({ label, checked, onToggle, disabled }) {
      return h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', margin: '4px 0' } },
        h('input', {
          type: 'checkbox',
          role: 'switch',
          'aria-checked': checked === true ? 'true' : 'false',
          checked: checked === true,
          disabled: disabled === true,
          onChange: () => onToggle(checked !== true)
        }),
        h('span', null, label))
    }

    /** 单选按钮。 */
    function Radio({ label, checked, onSelect }) {
      return h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', margin: '3px 0' } },
        h('input', { type: 'radio', checked: checked === true, onChange: () => onSelect() }),
        h('span', null, label))
    }

    /**
     * 一组能力勾选：每条带一句说明（`cap_<名字>` 词典项）并标出工具数。
     * @param {{selected: string[], onToggle: Function, tr: Function}} props - 选中项、切换回调、翻译函数。
     * @returns {unknown} React 元素。
     */
    function CapabilityGrid({ selected, onToggle, tr }) {
      return h('div', {
        style: {
          display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
          gap: '2px 14px', margin: '2px 0 4px'
        }
      },
        CAPABILITIES.map((name) => h('label', {
          key: name,
          style: { display: 'flex', alignItems: 'flex-start', gap: '8px', margin: '4px 0' }
        },
          h('input', {
            type: 'checkbox',
            role: 'switch',
            'aria-checked': selected.includes(name) ? 'true' : 'false',
            checked: selected.includes(name),
            onChange: () => onToggle(name, !selected.includes(name)),
            style: { marginTop: '2px' }
          }),
          h('span', null,
            h('span', { style: { display: 'block', fontSize: '13px' } },
              `${name}${TOOL_COUNTS[name] === undefined ? '' : `（${TOOL_COUNTS[name]} 个工具）`}`),
            h('span', { style: { display: 'block', fontSize: '11px', lineHeight: '15px', opacity: 0.65 } },
              tr(`cap_${name}`))))))
    }

    /**
     * 设置卡片。
     * @param {{ form?: object, configForms?: object, agentPresets?: object, t?: Function }} props - 插槽 props。
     * @returns {unknown} React 元素。
     */
    function AgentkitCard({ form, configForms, agentPresets, t }) {
      const tr = typeof t === 'function' ? t : (key) => (zh[key] !== undefined ? zh[key] : key)
      // 作用域来源优先级：插槽给的真作用域 → configForms 服务 → 插槽给的 { state, mutate } 零件。
      // 为什么不能无条件优先插槽的 form：plugin-manager 的 `formFor()` 传的是 { state, mutate }，
      // 那不是作用域，当成作用域用会读到空值（所有能力勾选都变未选中）。
      const servedScope = configForms !== undefined && typeof configForms.get === 'function'
        ? configForms.get(HOST_NS)
        : undefined
      const scope = useMemo(
        () => (isScope(form) ? form : (isScope(servedScope) ? servedScope : scopeFromParts(form))),
        [form, servedScope]
      )
      const [snapshot, setSnapshot] = useState(() => snapshotOf(scope))
      const [note, setNote] = useState('')
      const [roster, setRoster] = useState([])
      const [rosterError, setRosterError] = useState('')
      const [selected, setSelected] = useState('')
      const [detail, setDetail] = useState(undefined)
      const [detailError, setDetailError] = useState('')
      const [draftCaps, setDraftCaps] = useState([])
      const [draftPersona, setDraftPersona] = useState('')
      const [draftSuffix, setDraftSuffix] = useState('')
      const [draftComplete, setDraftComplete] = useState(false)
      const [createOpen, setCreateOpen] = useState(false)
      const [draftNew, setDraftNew] = useState({ id: '', name: '', description: '', capabilities: ['fs', 'sh', 'tasks'], persona: '' })

      // 读预设列表
      useEffect(() => {
        let alive = true
        const load = async () => {
          try {
            if (agentPresets === undefined || typeof agentPresets.list !== 'function') {
              if (alive) setRosterError('agentPresets remote 不可用')
              return
            }
            const raw = await agentPresets.list()
            const value = unwrapRemote(raw, 'remote.agentPresets.list')
            const list = Array.isArray(value) ? value : (Array.isArray(value && value.presets) ? value.presets : [])
            if (alive) {
              setRoster(list.filter((entry) => entry !== null && typeof entry.id === 'string'))
              setRosterError('')
            }
          } catch (problem) {
            if (alive) setRosterError(problem && problem.message ? problem.message : String(problem))
          }
        }
        void load()
        return () => {
          alive = false
        }
      }, [agentPresets])

      // 订阅表单
      useEffect(() => {
        setSnapshot(snapshotOf(scope))
        if (scope === undefined || typeof scope.subscribe !== 'function') return undefined
        const read = () => setSnapshot(snapshotOf(scope))
        return scope.subscribe(read)
      }, [scope])

      // 选中预设 → 读它的声明
      useEffect(() => {
        if (selected === '' || agentPresets === undefined || typeof agentPresets.read !== 'function') {
          setDetail(undefined)
          return undefined
        }
        let alive = true
        setDetailError('')
        setDetail(undefined)
        const load = async () => {
          try {
            const raw = await agentPresets.read(selected)
            const value = unwrapRemote(raw, 'remote.agentPresets.read')
            if (!alive) return
            const content = value !== null && typeof value === 'object' && typeof value.content === 'string' ? value.content : ''
            setDetail({ id: selected, name: value && value.name, description: value && value.description, content })
            const fields = readPersonaFields(content)
            // 优先用"已保存的编辑"（设置里的 preset_edits）：否则重新选中时读的是**原声明**，
            // 会让人以为"保存无效"（其实覆盖已经生效，见宿主日志的挂载行）。
            const live = plain(snapshotOf(scope)?.value) ?? {}
            const saved = live.preset_edits !== null && typeof live.preset_edits === 'object'
              ? live.preset_edits[selected]
              : undefined
            const declaredCaps = readCapabilities(content) ?? []
            const savedCaps = Array.isArray(saved?.capabilities) ? saved.capabilities : undefined
            setDraftCaps(savedCaps !== undefined && savedCaps.length > 0 ? savedCaps : declaredCaps)
            setDraftPersona(typeof saved?.persona === 'string' && saved.persona.trim() !== '' ? saved.persona : fields.prefix)
            setDraftSuffix(typeof saved?.suffix === 'string' && saved.suffix.trim() !== '' ? saved.suffix : fields.suffix)
            setDraftComplete(saved?.complete === 'true' ? true : (saved?.complete === 'false' ? false : fields.complete))
          } catch (problem) {
            if (alive) setDetailError(problem && problem.message ? problem.message : String(problem))
          }
        }
        void load()
        return () => {
          alive = false
        }
      }, [selected, agentPresets])

      /** 写设置。 */
      const commit = useCallback(async (path, next) => {
        if (scope === undefined || typeof scope.mutate !== 'function') {
          setNote('mutate 不可用')
          return
        }
        setNote('')
        try {
          const revision = snapshot !== undefined ? snapshot.revision : undefined
          // 实测契约：ConfigFormController.mutate(ops, expectedRevision) 解析为 boolean
          // （ui-settings/lib/client.js）：宿主拒绝写入时**不抛异常**，只回 false。
          const accepted = await scope.mutate([{ op: 'set', path, value: next }], revision)
          setNote(accepted === false ? tr('rejected') : tr('saved'))
        } catch (problem) {
          setNote(tr('failed') + (problem && problem.message ? problem.message : String(problem)))
        }
      }, [scope, snapshot, tr])

      const value = plain(snapshot !== undefined ? (snapshot.value !== undefined ? snapshot.value : snapshot) : undefined) || {}
      const capabilities = plain(value.capabilities) || {}
      const mirrors = plain(value.mirrors) || {}
      const proxy = plain(value.proxy) || {}
      const edits = plain(value.preset_edits) || {}
      const injectedRaw = plain(value.inject_into)
      const injected = Array.isArray(injectedRaw) ? injectedRaw : []
      const currentEdit = edits !== null && typeof edits === 'object' ? edits[selected] : undefined
      const contributors = detail === undefined ? [] : promptContributors(detail.content)
      const rosterLabel = useMemo(() => {
        const map = new Map()
        for (const entry of roster) map.set(entry.id, entry.name === undefined || entry.name === '' ? entry.id : entry.name)
        return map
      }, [roster])

      /**
       * 预设单选项：roster 里的顺序优先，再补上设置里已经"认识"的 id
       * （preset_edits 的键、inject_into 的项）。为什么需要：`agentPresets.list()`
       * 失败或还没回来时，用户至少还能选到自己已经编辑过/注入过的预设，
       * 否则整个预设管理区会因为没有 roster 而完全不可用。
       */
      const presetIds = useMemo(() => {
        const ids = []
        const seen = new Set()
        const add = (id) => {
          if (typeof id !== 'string' || id === '' || seen.has(id)) return
          seen.add(id)
          ids.push(id)
        }
        for (const entry of roster) add(entry.id)
        for (const id of Object.keys(edits)) add(id)
        for (const id of injected) add(id)
        return ids
      }, [roster, edits, injected])

      if (scope === undefined) {
        return h('div', null,
          h('p', { style: { margin: '0 0 6px', fontSize: '13px' } }, tr('noForm')),
          h('pre', {
            style: {
              margin: 0, padding: '8px', fontSize: '11px', lineHeight: '16px', whiteSpace: 'pre-wrap',
              wordBreak: 'break-all', background: 'var(--dsw-alias-bg-base, #f5f5f5)',
              border: '1px solid var(--dsw-alias-border-l3, #e0e0e0)', borderRadius: '6px'
            }
          }, `form: ${form === undefined ? '无' : '有'}；configForms: ${configForms === undefined ? '无' : '有'}；agentPresets: ${agentPresets === undefined ? '无' : '有'}`))
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px' } },
        // ① 全局能力闸门
        h('section', null,
          h('h4', { style: { margin: '0 0 6px' } }, tr('capable')),
          h('p', { style: { margin: '0 0 6px', fontSize: '12px', opacity: 0.75 } }, tr('capableHint')),
          h(CapabilityGrid, {
            selected: CAPABILITIES.filter((name) => capabilities[name] === true),
            onToggle: (name, next) => void commit(['capabilities', name], next),
            tr
          })),
        // ② 镜像
        h('section', null,
          h('h4', { style: { margin: '0 0 6px' } }, tr('mirrors')),
          h('p', { style: { margin: '0 0 6px', fontSize: '12px', opacity: 0.75 } }, tr('mirrorsHint')),
          MIRROR_FIELDS.map((field) => h(Field, {
            key: field, label: field, value: mirrors[field],
            onCommit: (next) => void commit(['mirrors', field], next)
          }))),
        // ③ 代理
        h('section', null,
          h('h4', { style: { margin: '0 0 6px' } }, tr('proxy')),
          h(Toggle, {
            label: tr('enabled'),
            checked: proxy.enabled !== false,
            onToggle: (next) => void commit(['proxy', 'enabled'], next)
          }),
          h('p', { style: { margin: '0 0 6px', fontSize: '12px', opacity: 0.75 } }, tr('proxyHint')),
          PROXY_FIELDS.map((field) => h(Field, {
            key: field.name, label: field.name, numeric: field.numeric, value: proxy[field.name],
            onCommit: (next) => void commit(['proxy', field.name], next)
          }))),
        // ④ 预设管理
        h('section', { style: { borderTop: '1px solid var(--dsw-alias-border-l3, #e0e0e0)', paddingTop: '10px' } },
          h('h4', { style: { margin: '0 0 6px' } }, tr('presets')),
          h('p', { style: { margin: '0 0 6px', fontSize: '12px', opacity: 0.75 } }, tr('presetsHint')),
          roster.length === 0
            ? h('p', { style: { margin: 0, fontSize: '12px', opacity: 0.75 } },
                rosterError === '' ? tr('loading') : `${tr('rosterFailed')}${rosterError}`)
            : null,
          presetIds.length === 0
            ? null
            : h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' } },
                presetIds.map((id) => h(Radio, {
                  key: id,
                  label: `${rosterLabel.get(id) === undefined ? id : rosterLabel.get(id)}（${id}）`
                    + (injected.includes(id) ? ` · ${tr('injectInto')}` : '')
                    + (edits[id] !== undefined ? ` · ${tr('current')}` : ''),
                  checked: selected === id,
                  onSelect: () => setSelected(id)
                }))),
          selected === ''
            ? null
            : h('div', { style: { marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '8px' } },
                detailError !== ''
                  ? h('p', { style: { margin: 0, fontSize: '12px' } }, `${tr('readFailed')}${detailError}`)
                  : detail === undefined
                    ? h('p', { style: { margin: 0, fontSize: '12px', opacity: 0.75 } }, tr('loading'))
                    : h('div', null,
                        h('p', { style: { margin: '0 0 4px', fontSize: '12px', opacity: 0.75 } },
                          `${detail.name === undefined || detail.name === '' ? detail.id : detail.name} · `
                          + (readCapabilities(detail.content) === undefined ? tr('noToolkit') : `${tr('current')}：${(readCapabilities(detail.content) ?? []).join(', ') || '（无）'}`)),
                        h(CapabilityGrid, {
                          selected: draftCaps,
                          onToggle: (name, next) => setDraftCaps((previous) => (
                            next ? [...previous, name] : previous.filter((item) => item !== name)
                          )),
                          tr
                        }),
                        h(Area, {
                          label: `${tr('persona')} · prefix`,
                          hint: tr('personaHint'),
                          rows: 8,
                          value: draftPersona,
                          onCommit: (next) => setDraftPersona(next)
                        }),
                        h(Area, {
                          label: `${tr('persona')} · suffix`,
                          hint: tr('suffixHint'),
                          rows: 2,
                          value: draftSuffix,
                          onCommit: (next) => setDraftSuffix(next)
                        }),
                        h(Toggle, {
                          label: tr('complete'),
                          checked: draftComplete,
                          onToggle: (next) => setDraftComplete(next)
                        }),
                        contributors.length === 0 ? null : h('p', { style: { margin: '2px 0 0', fontSize: '11px', opacity: 0.6 } },
                          `${tr('contributors')}${contributors.join(', ')}`),
                        h('button', {
                          type: 'button',
                          onClick: () => void commit(['preset_edits', selected], {
                            capabilities: draftCaps,
                            persona: draftPersona,
                            suffix: draftSuffix,
                            complete: draftComplete ? 'true' : 'false'
                          }),
                          style: {
                            alignSelf: 'flex-start', padding: '6px 12px', borderRadius: '6px', cursor: 'pointer',
                            border: '1px solid var(--dsw-alias-border-l3, #d0d5dd)', background: 'transparent', color: 'inherit'
                          }
                        }, `${tr('save')}${currentEdit === undefined ? '' : '（覆盖）'}`),
                        currentEdit === undefined ? null : h('p', { style: { margin: '2px 0 0', fontSize: '11px', opacity: 0.7 } },
                          `${tr('editSaved')}${(Array.isArray(currentEdit.capabilities) ? currentEdit.capabilities : []).join(', ') || '（无能力）'}`),
                        currentEdit === undefined ? null : h('button', {
                          type: 'button',
                          onClick: () => void commit(['preset_edits', selected], {
                            capabilities: [], persona: '', suffix: '', complete: ''
                          }),
                          style: {
                            alignSelf: 'flex-start', padding: '4px 10px', borderRadius: '6px', cursor: 'pointer',
                            fontSize: '12px', border: '1px solid var(--dsw-alias-border-l3, #d0d5dd)',
                            background: 'transparent', color: 'inherit'
                          }
                        }, tr('undoEdit'))))),
        // ⑤ 新建预设
        h('section', { style: { borderTop: '1px solid var(--dsw-alias-border-l3, #e0e0e0)', paddingTop: '10px' } },
          h('h4', { style: { margin: '0 0 6px' } }, tr('create')),
          h('p', { style: { margin: '0 0 6px', fontSize: '12px', opacity: 0.75 } }, tr('createHint')),
          createOpen
            ? h('div', null,
                h(Field, { label: tr('createId'), value: draftNew.id, onCommit: (next) => setDraftNew((p) => ({ ...p, id: String(next) })) }),
                h(Field, { label: tr('createName'), value: draftNew.name, onCommit: (next) => setDraftNew((p) => ({ ...p, name: String(next) })) }),
                h(Field, { label: tr('createDescription'), value: draftNew.description, onCommit: (next) => setDraftNew((p) => ({ ...p, description: String(next) })) }),
                h(CapabilityGrid, {
                  selected: draftNew.capabilities,
                  onToggle: (name, next) => setDraftNew((p) => ({
                    ...p,
                    capabilities: next ? [...p.capabilities, name] : p.capabilities.filter((item) => item !== name)
                  })),
                  tr
                }),
                h(Area, {
                  label: tr('persona'),
                  hint: tr('personaHint'),
                  rows: 6,
                  value: draftNew.persona,
                  onCommit: (next) => setDraftNew((p) => ({ ...p, persona: next }))
                }),
                h('p', { style: { margin: '4px 0 6px', fontSize: '12px', opacity: 0.75 } }, tr('createHint2')),
                h('button', {
                  type: 'button',
                  disabled: draftNew.id.trim() === '',
                  onClick: () => void commit(['preset_new'], draftNew),
                  style: {
                    padding: '6px 12px', borderRadius: '6px', cursor: 'pointer',
                    border: '1px solid var(--dsw-alias-border-l3, #d0d5dd)', background: 'transparent', color: 'inherit'
                  }
                }, tr('createButton'))
              )
            : h('button', {
                type: 'button',
                onClick: () => setCreateOpen(true),
                style: {
                  padding: '6px 12px', borderRadius: '6px', cursor: 'pointer',
                  border: '1px solid var(--dsw-alias-border-l3, #d0d5dd)', background: 'transparent', color: 'inherit'
                }
              }, tr('create')
            )),
        note === '' ? null : h('p', { style: { margin: 0, fontSize: '12px' } }, note))
    }

    /**
     * 渲染错误边界：任何渲染期异常都变成页面上的可见文字。
     * 为什么需要：React 默认把渲染异常变成"空白"，而客户端 Loader 又不给错误信息，
     * 于是故障表现为"什么都没显示" —— 有了它至少能看到真实原因。
     */
    class RenderBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: undefined }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      render() {
        if (this.state.error !== undefined) {
          const message = this.state.error !== null && typeof this.state.error === 'object'
            ? String(this.state.error.message ?? this.state.error)
            : String(this.state.error)
          const stack = this.state.error !== null && typeof this.state.error === 'object' && typeof this.state.error.stack === 'string'
            ? this.state.error.stack
            : ''
          return h('pre', {
            style: {
              margin: 0, padding: '10px', fontSize: '11px', lineHeight: '16px', whiteSpace: 'pre-wrap',
              wordBreak: 'break-all', color: 'var(--dsw-alias-state-error-primary, #b42318)',
              background: 'var(--dsw-alias-bg-base, #f5f5f5)',
              border: '1px solid var(--dsw-alias-border-l3, #e0e0e0)', borderRadius: '6px'
            }
          }, `卡片渲染异常：${message}\n${stack}`)
        }
        return this.props.children
      }
    }

    /**
     * 挂载客户端半边。
     * @param {object} ctx - 客户端插件上下文。
     */
    function apply(ctx) {
      const t = ctx.locale.bind(LOCALE_NS)
      ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'agentkit: dictionaries')
      /** 用错误边界包一层，避免渲染异常变成空白。 */
      function Bounded(props) {
        return h(RenderBoundary, null, h(AgentkitCard, props))
      }
      ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: PACKAGE,
        locale: LOCALE_NS,
        inject: () => ({
          configForms: ctx.configForms,
          agentPresets: ctx.remote === undefined ? undefined : ctx.remote.agentPresets
        })
      }, Bounded)), 'agentkit: bundle settings page')
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  }
})
