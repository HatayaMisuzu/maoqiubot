# 小毛球 Bot 工作台

这是 Windows 个人桌面工作台。桌面壳（Electron）、本机服务端（HTTP/SSE/WebSocket）、原生连接器与内置外接 Agent 管理组件协同运行；后端、毛球之家与附件共用一份 SQLite 数据目录（主库 v10，连接器本地库 v2）。工作 Bot 在配置的本机环境与工作区目录中执行，前端 `web-demo/` 通过本机 HTTP 和 SSE 接口与工作台交互（亦支持纯浏览器模式运行，桌面进程管理入口将降级为只读监控视图）。

详细文档结构与架构拓扑见 [docs/README.md](docs/README.md)。

## Windows 桌面版

在项目目录下使用 [Xiaomaoqiu.exe](dist/Xiaomaoqiu-win32-x64/Xiaomaoqiu.exe) 打开桌面窗口。复制分发包时须保留同目录内的运行库、资源与 `agent-manager` 组件。关闭窗口会收进系统托盘，正在运行的任务会继续执行。从托盘菜单可重新打开窗口、重启连接器或退出工作台。

分发目录位于项目的 `dist/` 下时，桌面版沿用项目的 `data/` 文件夹和连接器配置；移至别处后，默认使用应用的用户数据目录。可通过 `MAOQIU_DATA` 显式指定数据目录，通过 `MAOQIU_CONNECTOR_CONFIG` 指定连接器 JSON，通过 `MAOQIU_DESKTOP_PROFILE` 隔离 Electron 用户配置目录。切换启动方式前应先退出使用同一数据目录的旧进程。

### 源码启动、脚本与打包

需要 Node.js 22.18 或更新版本。内置外接 Agent 管理组件（`agent-manager.exe`）的 Windows x64 源码构建还需要 pnpm、Rust MSVC 工具链和 Windows SDK，需在 x64 Native Tools Command Prompt 或已加载同等工具链的 PowerShell 中执行；DSH 桌面版官方启动器使用其自带运行环境。

```powershell
Set-Location E:\xiaomaoqiu
npm.cmd ci
npm.cmd run build:agent-manager
npm.cmd run desktop
npm.cmd run package:desktop
```

| 脚本命令 | 作用 |
| --- | --- |
| `npm.cmd run desktop` | 启动 Electron 桌面窗口及内置服务端/连接器 |
| `npm.cmd run local` | 启动本机 HTTP 服务与本地连接器（默认端口 `4317`，浏览器模式访问） |
| `npm.cmd start` | 仅启动服务端（不启动默认本地连接器） |
| `npm.cmd run connector` | 独立运行连接器进程（按传入配置或 `MAOQIU_NODE_URL` 连接服务端） |
| `npm.cmd run build:agent-manager` | 拉取/应用 CC Switch 补丁并编译产出 `dist/agent-manager/`（含开源许可声明） |
| `npm.cmd run package:desktop` | 校验并打包 Windows 免安装桌面目录至 `dist/`（可用 `MAOQIU_PACKAGE_OUT` 改目录） |
| `npm.cmd run backup -- save/restore ...` | 创建或恢复数据库、附件及脱敏连接器配置快照 |
| `npm.cmd run check` | 运行 TypeScript 类型检查（`tsc --noEmit`） |
| `npm.cmd test` | 运行 Node 单元测试套件 |
| `npm.cmd run test:e2e` | 运行 Playwright 浏览器端到端回归测试（Windows 上需先执行 `npx playwright install chromium --only-shell`） |

#### 常用环境变量

- `MAOQIU_DATA`：数据目录路径（默认 `data/`）
- `MAOQIU_CONNECTOR_CONFIG`：指定连接器配置 JSON 路径（覆盖 `<data>/desktop-connector.json`）
- `MAOQIU_DESKTOP_PROFILE`：指定 Electron profile/userData 路径
- `MAOQIU_DSH_EXECUTABLE`：指定 DSH 官方可执行入口路径（如 `dsh.cmd`）
- `MAOQIU_CHAT_CODEX`：指定主聊 Codex CLI 可执行文件名称或路径（默认 `codex`）
- `MAOQIU_SAFE_PLUGINS=1`：安全模式，启动时不加载外部可执行扩展
- `MAOQIU_PACKAGE_OUT`：指定 `package:desktop` 输出目录
- `MAOQIU_MODEL_KEY_*` / `MAOQIU_PLUGIN_KEY_*`：分别供主聊外部模型及扩展工具引用的密钥环境变量（自动从 Codex/连接器子进程隔离）

### 外接 Agent 管理与执行实例

桌面端侧栏底部的「Agent 设置」打开集中监控与管理弹窗：可查看本机工作 Bot 状态、待核对运行与按天统计的可用量，或点击「打开管理窗口」启动内置 CC Switch 组件，也可以点击「执行实例与工作区」增删改本机实例配置并点「测试连接」验证握手。浏览器模式下对应入口为「Bot 监控」。

- 配置窗口打开时，工作台会暂停空闲本机连接器；若有运行仍在进行，会提示等待或先停止。若同一种 Agent 配置了多份独立配置目录，可在「目标配置」切换对应实例。
- 从仓库根目录配置的实例可在「执行实例与工作区 → 新建 Git 工作树」建立 `maoqiu/<实例 ID>` 独立工作分支及新实例，用于多 Bot 并行修改互不干扰。
- Codex 工作 Bot 支持在实例配置中选择「Codex 供应商模式」（`official` 官方 ChatGPT 登录 / `native` 跟随本机供应商）。

快捷交互：工作台支持 `Ctrl+K` 打开快速切换与搜索面板（命令面板），`Ctrl+I` 切换右侧上下文面板；在窄屏设备下上下文面板与侧栏抽屉均支持遮罩点击与 `Esc` 收起。

## 项目、话题和模型

1. 在「毛球之家」创建项目，选择「绑定工作区」，核对执行实例、profile 与工作目录（API 工作 Bot 不挂载本机工作区目录，固定采用明确选中的材料权限）。项目可绑定多个实例，每个实例保有独立会话与工作目录。
2. 在项目中打开小毛球话题，发出委派，或直接创建 Codex、DSH、Hermes 或 API 工作 Bot 话题。点击任务卡可打开同一工作话题。
3. 在工作话题顶部选择下一轮模型，或点击「Bot 设置」配置名称、擅长描述、启用/直聊/委派开关与允许项目范围（Codex 支持在此按需查询官方额度窗口；DSH/Hermes 提示查看原生客户端并在监控统计任务用量）。
4. 项目实例绑定默认仅收到本轮消息及明确选中的材料；开启工作区资料访问后可授予只读、追加或管理权限（单次运行令牌最长 24 小时，撤销授权、解除绑定或运行终态即失效）。
5. 毛球之家时间线支持「查看记录」「查看出处」「接续此交接」及「带入工作话题」，记录正文与简报支持安全 Markdown 渲染。
6. 请求停止在有原生执行证据时发往原运行，待发指令可撤回，无法确认的提示保持「送达待核对」并可等待核对、查询原生回执或放弃。
7. 交付核对支持「执行结束」「成果已提交」与「验收通过」逐项审查，项目简报区分待核验条件、执行方自述证据与已验证内容。

点击小毛球联系人打开固定主聊，侧聊可通过右键/「会话操作」执行「设为主聊」（需原主聊确认）。新话题草稿按 Bot 与项目范围独立保留（单附件上限 16 MiB，图片支持缩略预览），首次发送时原子创建。主聊顶部「设置」集中管理主聊模型、主聊人格（支持 `persona.md`）、记忆候选、事项提醒（`datetime-local` 含时区提交）、主聊工具权限与插件和 Skill。详细说明见 [会话与工作区指南](docs/sessions.md) 与 [第三阶段指南](docs/phase3.md)。

## 独立主聊、协作与插件

1. 在「主聊模型」可保留本机 Codex，或接入 OpenAI Chat Completions / Responses、Anthropic Messages、Gemini Interfaces（支持连接测试、模型发现与能力测试，并可将外部模型直接注册为独立 API 工作 Bot）。
2. 工具调用经由原生函数调用或结构化决策提交后由本地宿主逐一核验；未在「主聊工具权限」豁免的操作会弹出确认卡。
3. 「插件与 Skill」支持内置网页搜索/读取插件（[plugins/web/README.md](plugins/web/README.md)）、导入 Agent Skills、声明式业务 API 与经静态检查和摘要授权的可信 JS 扩展（[插件 SDK](plugins/README.md)）。

## 原生接入说明

- **Codex**：通过本机官方 CLI 与 stdio App Server 运行，支持目录按需读取、导入、原生文本历史、分支、归档、恢复与官方额度窗口查询。[Codex App Server](https://developers.openai.com/codex/app-server/)
- **DSH**：通过官方 `dsh --profile acp` 运行，按握手能力开放模型选择、会话目录、导入与续接。[DSH 会话配置说明](connector/DSH.md)
- **Hermes Agent**：通过官方 `hermes acp` 接入，核对工作区并支持会话目录与运行授权。[Hermes 接入说明](connector/HERMES.md)
- **API 工作 Bot**：复用本机配置的外部文本/视觉模型，强制非流式单次请求以回收完整 token 用量并支持在途取消。

## HTTP、SSE 和备份

所有者访问令牌位于数据目录的 `access.local.json`。项目资料、交接与空间 API 详见 [毛球之家公共 API](server/home/API.md)，会话与节点端点详见 [会话说明](docs/sessions.md)。

```powershell
# 创建停机完整备份（含连接器本地库与脱敏桌面连接器配置）
npm.cmd run backup -- save data backups\snapshot --offline --connector data\node-local --connector-config data\desktop-connector.json

# 恢复到全新目录后启动
npm.cmd run backup -- restore backups\snapshot restored-data
$env:MAOQIU_DATA = 'restored-data'
npm.cmd start
```

备份默认包含 `workbench.sqlite`、`persona.md`、`chat-models.json`、`chat-policy.json`、附件与插件包，并通过 `--without-access` 控制是否剔除 `access.local.json`。传入 `--connector-config` 时仅保留安全的启动参数、工作树与 `CODEX_HOME`/`DSH_HOME`/`HERMES_HOME`/`HERMES_DATA_DIR_SUFFIX` 环境变量，自动剥离密钥环境变量。切勿使用旧版程序打开 v10 数据库。

第三方开源组件及许可声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
