# 通用 agent 工具集（`@local/dsh-agentkit`）

与翻译、模型无关的**通用 agent 工具集**，以 DSH 的 bundle + agent preset 形式分发。
它提供一个 `generic`（通用环境）预设，以及一组"把 Windows 上最容易出错的环节封进工具层"的能力。

- 文件读写**编码 / 换行 / 字符集**全兜底（本地 + `代号:/远程` SFTP），写回按**原字符集**编码
- **禁用 Windows PowerShell 5.1 与 cmd**，放行 `sh`（bash）与 `pwsh`（PowerShell 7，UTF-8）
- 软件源走**镜像**（pip 清华 / npm npmmirror / 模型 hf-mirror）、外网走**代理**（直连慢或不通时自动注入）
- 文件账本式任务面板、沙箱提权、技能加载、检索、委派、后台作业、交付卡片、预设管理

## 安装

```bash
# 在 DSH 里用插件管理器安装（本地目录或打包产物都行）
plugin_manager install_bundle <本目录 或 local-dsh-agentkit-<版本>.tgz>
```

或从命令行：

```bash
dsh plugin --profile <profile> install <路径或 tgz>
```

安装后**重启一次** DSH Desktop（新增/删除 JS 模块需要重启；只改 YAML 补丁会热重载）。

## 它装了什么

| 项 | 说明 |
|---|---|
| 宿主行 `agentkit` | 只承载「插件 → 通用 agent 工具集」里的设置页（不注册任何工具，不污染其它 preset） |
| 预设 `generic`（通用环境） | 挂载下列能力；系统提示词自带 `{{cwd}}` 的 persona suffix |
| 设置页 | ① 全局能力闸门 ② 软件源镜像 ③ 外网代理 ④ **预设管理**（单选预设 → 读取/编辑它的能力与 persona → 保存/撤销）⑤ 新建预设 |

## 能力（13 项，可在设置页按需开关）

| 能力 | 工具数 | 提供 |
|---|---|---|
| `fs` | 5 | `read` / `read_many`（一次读多个文件，支持目录+通配）/ `write` / `edit` / `list_dir`（含排序与文件详情）：编码、换行、字符集安全；本地 + `代号:/远程`；含沙箱提权 |
| `sftp` | 2 | `sftp_hosts`：远程主机代号增删查 + `ping` 验证凭据（AsyncSSH 侧车，复用长连接）；`search_remote`：远程内容检索（本地检索用 `grep`） |
| `run` | 1 | `run`：argv 直连执行，不经 shell、不需要引号转义 |
| `sh` | 1 | `sh`：bash（MSYS2） |
| `pwsh` | 1 | `pwsh`：PowerShell 7，强制 UTF-8 |
| `env` | 2 | `env_setup` / `pip_install`：探测环境、按镜像装依赖、写 ENV.md |
| `proxy` | 1 | `net_check`：外网/代理探测，结果注入子进程环境 |
| `doc` | 3 | `ocr_doc`（docling 包装）/ `merge_files`（按 manifest 合并）/ `pack`（tar 打包） |
| `split` | 1 | `split_file`：大文件拆块 + manifest |
| `img` | 4 | `read_image` 整图直投模型；`image_info` 看尺寸；`crop_image` 裁一块（默认直接给模型看）；`resize_image` 缩放（缺 Pillow 时按镜像自动装） |
| `tasks` | 4 | `plan_init` / `task_update` / `task_show` / `stage_set`：进度写 `TASKS.md`，摘要注入上下文 |
| `guard` | 0 | 结构性 shell 禁令：禁 `powershell` / `powershell_ise` / `cmd` / `cmd.exe` / `shell` / `bash` / `terminal*`，放行 `pwsh` / `sh` |
| `preset` | 5 | `preset_create` / `preset_list` / `preset_delete` / `preset_inject` / `preset_eject` |

> 设置页里的能力开关是**全局闸门**：与每个 preset 自己声明的 `tools` 数组**取交集**。

## 配置文件

工作区根目录（任选其一）：`dsh-plugin.json` / `.dsh/dsh-plugin.json`

```json
{
  "mirrors": { "pip_index_url": "https://pypi.tuna.tsinghua.edu.cn/simple",
               "npm_registry": "https://registry.npmmirror.com",
               "hf_endpoint": "https://hf-mirror.com" },
  "proxy":   { "enabled": true, "host": "127.0.0.1", "port": 10808, "slow_ms": 3000,
               "probe_url": ["https://raw.githubusercontent.com/", "https://pypi.org/simple/"],
               "no_proxy": ["localhost", "127.0.0.1"] },
  "sftp":    { "hosts": { "remote1": { "host": "remote1", "user": "sakuya",
                                       "strict_host_key": true, "root": "/" } } }
}
```

设置页里的值作为**默认**，本文件按项目覆盖（`sftp.hosts` 按代号逐项合并）。
镜像域名会自动进 `NO_PROXY` —— **软件源走镜像、不走代理**。

## 状态文件（插件自己维护，可删）

| 文件 | 用途 |
|---|---|
| `presets.generated.json` | `preset_create` 生成的自定义预设 + 注入/编辑状态 |
| `presets.generated.patch.yml` | 由上面渲染出的补丁（**覆盖声明是顶层 `- id: preset-<x>` 条目，不带 `insert`**） |
| `cordis.patch.yml` | 手写主补丁：宿主行 + `generic` 预设 |

> 覆盖方言要点（踩过坑）：`insert:` 是**追加**；顶层 `- id: <既有 id>`（不带 `insert`）才是**覆盖**。
> 写成 `insert:` 里的同 id 行会让组合后的 profile 出现**重复 entry id**，应用会进恢复模式。

## 依赖

- **无 npm 依赖**（`schemastery` / `cosmokit` / `react` 由 DSH 安装提供；取不到时优雅降级）
- 远程 SFTP 需要 `asyncssh`：侧车会在缺失时**按镜像自动安装**（也可用 `env_setup`）
- 文档能力需要 `docling`（`env_setup({ pip_packages: ["docling"] })`）

## 测试

```bash
# 离线依赖（真 YAML 解析器 + 真 React）与 python 解释器（image 能力要 Pillow）
export DSH_TEST_DEPS=/path/to/node_modules            # js-yaml 4.3.2 + react 18 + react-dom 18
export DSH_TEST_PYTHON=/path/to/python.exe            # 可选：强制指定解释器
export DSH_SHIPPED_MODULES=/path/to/app/node_modules  # 可选：用真实出货预设代替 test/fixtures

node test/pure.test.mjs             # 纯函数
node test/argv.test.mjs             # argv 直连执行
node test/exec.test.mjs             # 子进程封装
node test/load.test.mjs             # 能力装载与工具 schema
node test/fs-read.test.mjs          # 读文件（编码/行号/上限/越界）
node test/list-dir.test.mjs         # 目录列举
node test/charset.test.mjs          # 字符集写回（Python 助手）
node test/sftp.test.mjs             # SFTP 侧车协议（内存后端）
node test/remote.test.mjs           # 完整 SFTP JS 管道
node test/sandbox.test.mjs          # 沙箱提权与围栏自检
node test/shell-ban.test.mjs        # shell 禁令
node test/split.test.mjs            # 大文件拆块
node test/image-ops.test.mjs        # 图片工具（需要 Pillow）
node test/client-render.test.mjs    # 客户端卡片 SSR 渲染
node test/preset-inject.test.mjs    # 预设注入/编辑（含真实出货预设）
node test/measure-capabilities.mjs  # 各能力的 token 成本
node test/measure.mjs <会话日志>     # 各 preset 的系统提示词 + 工具 schema 占用（需要一份会话日志路径）
```

`test/deps.mjs` 负责解析上面这些依赖：DSH Desktop 把装机包放在 `resources/app.asar` 内，
普通 `node` 读不进去，所以测试按 `$DSH_TEST_DEPS` → `test/vendor` → 仓库 `node_modules`
的顺序找依赖，出货预设则按 `$DSH_SHIPPED_MODULES` → `$DSH_APP_ROOT` → `test/fixtures` 回落。
找不到就**报错并给出安装指引**，不会偷偷跳过。刷新 fixture 见 `test/fixtures/README.md`。

Python 解释器同样按 `$DSH_TEST_PYTHON` → `$DSH_PYTHON` → `$DSH_HOME/dsh-runtimes/*/dependencies/python`
→ `<resourcesPath>/runtime/*/…` → PATH 的顺序挑，**优先能 `import PIL` 的那份** —— 所以在装了 DSH 的机器上
`image-ops` 开箱即可跑，`DSH_TEST_PYTHON` 只在需要强制指定时才用。`generic` 预设的能力清单也不再由测试各自硬抄，
而是取自出货 `cordis.patch.yml`（`test/deps.mjs` 的 `shippedGenericCapabilities()`）。

Python 助手一律经 `test/deps.mjs` 的 `pythonScript()` / `pythonArg()` 调用：
MSYS2 / Cygwin 的 python 用 posixpath，`D:\...` 形式的绝对路径会被当成相对路径
（插件自身走 `lib/exec.js` 的 `pythonPathArg()` 做同样的转换）。

## 兼容性

适配目标：**DSH Desktop 0.2.1-rc.2**（schemastery 3.18.5 / react 18）。相对 1.3.0 的适配点：

- **工具重名改为显式裁决**：0.2.1-rc.2 里 preset 层的注册会**遮蔽**宿主层同名工具（只有同一层内重复才报错），
  所以 `read` / `write` / `edit` 有意接管（保留编码 / 换行 / 远程语义），`pwsh` / `read_image` 让给出货实现
  （用它的沙箱审批与图片路由）。裁决表在 `tools/registry.js`，每次装载都记日志；原来的"吞掉注册异常"补丁已删除。
- 预设补丁去掉已废弃的 `backgroundMode`（0.2.1-rc.2 的 `dsh-tool-subagent` 无此字段，本地子代理默认可续）。
- `loader/volatile-update` → `settings/document-updated`（按命名空间过滤；旧事件名已不存在）。
- 沙箱提权闸门改看 `ctx.get('sandboxPolicy')`（0.2.1-rc.2 的 `fs` 没有 `sandboxMode`）。
- Python 助手路径按解释器风格转换：`lib/exec.js` 的 `pythonPathStyle()` / `pythonPathArg()`
  （MSYS2 / Cygwin 的 python 用 posixpath，Windows 绝对路径会被当相对路径）。
- `dsh.client.inject` 去掉 `dsh-client-ui-slots`：它仍是可用的平台内置模块，但已不是客户端模块图的行。

## 隔离性

所有工具注册在**选中该 preset 的会话**里；宿主行不注册工具；guard 按 agent 注册。
其它 preset / 会话看不到本工具集，也不会改变宿主默认行为。

## 许可证

[MIT](LICENSE) © 2026 ii33
