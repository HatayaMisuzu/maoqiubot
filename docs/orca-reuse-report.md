# Orca 复用与小毛球升级验收

## 基线与上游

目标 `main` 起始提交 `705b77a07fc6af43b363b3202b89013e99e8f321`，执行 `git fetch origin` 后与 `origin/main` 一致，工作区起始干净。基线在 Windows 使用 Node.js 22.22.3 运行 `npm ci`、`npm run check`、`npm test` 与 `node scripts/smoke-live.ts`，46 项测试及真实 Codex 冒烟通过。

旧 Windows 包的 74 个运行时文件与 `3e637c251ae3d2f6f9e72a7663d1c0effa68c2ca` 对应文件逐一匹配，该提交已在 `main` 的历史中。Orca 升级以其后续版本为基础，沿用已有源码并打包成一个工作台。新包的运行时文件与本轮工作树逐一匹配，发行版 `package.json` 由打包器移除开发字段。

上游固定为 `baf50e624fc7616e01942220c2d57c05304d7fdb`，它是本轮拉取时的 Orca HEAD。核对该版本根许可证与直接复用文件，版权为 Lovecast Inc.，MIT 全文已随源码和桌面包分发。本项目依赖及锁文件无需变更。[Orca 固定版本](https://github.com/stablyai/orca/tree/baf50e624fc7616e01942220c2d57c05304d7fdb) · [许可证](../THIRD_PARTY_NOTICES.md)

## 上游对照与落地

| 方向 | Orca 入口与依赖 | 毛球采用方式与落地 |
| --- | --- | --- |
| 按资源排队 | `src/shared/concurrency/keyed-serialized-operations.ts` 的 `runKeyedSerializedOperation` 无外部依赖 | **直接复用**至 `connector/keyed-serialized-operations.ts`，替换 `connector/index.ts` 的手写队列。同目录任务按真实路径串行，独立目录可并行。待发取消在队列外处理，无需等待同目录任务完成。`Store.bind` 在 SQLite 事务内做冲突检查与写入。 |
| 原生协议和恢复 | `src/main/acp/session/acp-structured-session-contract.ts`、`src/main/acp/transport/acp-errors.ts`、`src/main/codex/app-server/codex-app-server-handshake.ts`。分别依赖上游结构化会话、生成的 ACP 类型、诊断包装和 App Server 连接类型 | **借鉴**能力和错误边界。`connector/adapters/index.ts` 汇总实例运行目录及本机限制，适配器各自探测目录与导入能力。`connector/rpc.ts` 先接收尾部 stdio 回执再处理退出，格式异常的响应保持待核对。Codex 运行及读取核对握手时的账号范围，丢失的回执继续通过原生 turn ID 查询。 |
| DSH Hooks | `src/main/dsh/dsh-hook-packages.ts`，依赖 DSH profile 安装的两个 Hook 包 | **不采用**。官方 ACP 可握手、读取模型及续接。Hook 需要改动原生 profile 和安装额外依赖，且无法代替推理回执。 |
| 历史与归属 | `src/main/ai-vault/transcripts/session-transcript-reader.ts`、`src/main/native-chat/conversation-adoption/structured-agent-cli-conversations.ts`，依赖上游跨平台文件访问、解析器及账号目录发现 | **借鉴**会话归属、分页和状态反馈。`server/tasks/index.ts` 与 `server/api/nodes.ts` 校验原项目、实例和运行身份，过滤外范围目录与导入。`web-demo/app.js` 增加目录和会话搜索，`web-demo/chat.js` 合并历史页并注明读取时间和缓存状态。Codex 官方接口已能满足本轮历史读取，DSH 使用已有工作台缓存。 |
| 协作与消息 | `src/shared/agent-session/journal/agent-session-message-source.ts`、`src/main/runtime/rpc/methods/orchestration/worker/start/local-worker-start.ts`，依赖 Orca mailbox、运行时与编排库 | **已有及小幅增强**。工作台持久化 sender、recipient、任务、运行、回复关系和授权回执。小毛球现有 `bot_list`、`bot_sessions`、`task_delegate`、`task_control`、`task_communications`、交付核对工具继续使用原来的 SQLite/API。`bot_sessions` 增加最近运行状态并排除委派草稿。 |
| Worktree | `src/shared/new-workspace/worktree-create-collision.ts` 与 `src/main/runtime/rpc/methods/orchestration/worker/start/placement/`。前者为纯类型，后者依赖 Orca Runtime 和 Git 工作区模型 | **借鉴**先核对目的地、再建立独立执行实例。`desktop/connector-settings.cjs` 调用系统 Git，核对根目录、路径、分支和实际 HEAD，记录基准提交并登记新配置。首次握手继承来源 Bot 权限。项目映射与资料授权仍通过毛球之家完成。 |
| 额度和休眠 | `src/main/rate-limits/providers/codex/codex-rpc-rate-limit-mapper.ts`、`src/shared/agent-session/lifecycle/stopping/agent-session-workspace-sleep.ts`。上游有独立额度缓存、会话库存和可验证的停止流程 | **借鉴额度**。通过现有 Codex App Server 读取官方百分比、窗口和重置时间，界面按需查询，主聊可用受范围约束的 `bot_usage`。DSH 额度未知。**本轮关闭空闲休眠**，连接器进程可承载多会话，DSH 待定结果缺少原生查询途径。 |
| 记忆与插件 | `src/main/bots/bot-memory-ops.ts` 依赖上游文本快照与 Zod。`src/shared/plugins/capabilities/plugin-capability-gate.ts` 依赖 Orca worker API 和渲染表面 | **已有**。复用毛球之家版本与所有者确认候选。现有 SDK v1 已校验 host API 与声明能力，保留网络审批、更新、回滚和安全模式。可信外部代码继承宿主进程权限。 |
| 桌面体验 | `docs/STYLEGUIDE.md`、`src/renderer/src/` 的会话和状态界面 | **借鉴**搜索、最近活动和状态就近呈现。继续使用现有 `web-demo`，在联系人、会话历史、Bot 和 Agent 设置中提供入口。 |

原生能力矩阵、操作步骤、HTTP 字段和未来适配器注册方法见[会话与工作区说明](sessions.md)及 [DSH 官方 ACP 接入](../connector/DSH.md)。本轮的原生执行入口仍是 Codex 与 DSH。主聊、独立 API 工作 Bot、插件、SQLite 及审批继续走现有路径。

## 验收结果

| 编号 | 结果 | 证据与限制 |
| --- | --- | --- |
| T01 | PASS | 旧库与连接器迁移、备份恢复、唯一主聊、项目授权与附件校验由 `upgrade` 和 `sessions` 测试覆盖。主库 v7，连接器库 v1。 |
| T02 | PASS | 真机 Codex App Server、官方 DSH 0.2.2-rc.5 握手。`upgrade` fixture 验证只有目录时拒绝导入。 |
| T03 | PASS | `smoke-live` 与 `smoke-sessions` 使用 Windows 已登录的官方 Codex、新建临时工作区和会话，两轮保持同一个 thread ID，原生历史与回执一致。 |
| T04 | BLOCKED | 官方 DSH 使用隔离 home，ACP 新建、读取一个模型及重启后恢复同一 session 成功。隔离配置缺少供应商凭据和第二个模型。真实推理与不同模型切换受阻，模型切换及同名供应商区分有 fixture 覆盖。 |
| T05 | PASS | 真实 Codex 查询目录与原生历史，重复导入返回同一工作话题。断开隔离桌面的连接器后，已读取历史仍显示并标为带时间的离线缓存。自动化覆盖游标、旧节点、跨项目及个人范围过滤。DSH 目录未列出尚无成功轮次的临时会话，见 T04。 |
| T06 | PASS | `connector-recovery` 使用两个独立 ACP fixture 进程，验证同目录串行、独立目录并行、运行中停止、排队取消后无原生提示。 |
| T07 | PASS | 已接收后断线、持久回执查询和重复请求由 `connector-recovery` / `upgrade` 验证，无法核对的结果进入 `uncertain`。 |
| T08 | PASS | `smoke-live` / `smoke-sessions` 真机验证主聊委派、跨侧聊查旧任务、原会话继续。更换执行 Bot 和交接走 `workbench` / `upgrade` fixture。 |
| T09 | PASS | `workbench` / `upgrade` 验证用户直聊、定向任务通信、协调报告来源和回执。 |
| T10 | PASS | 项目、Bot 设置、运行令牌、撤权及跨项目原生导入由 `project-routing` / `workbench` / `upgrade` 验证。 |
| T11 | PASS | `upgrade` 的双 Bot fixture 验证澄清、转派、接手、交付和独立验收状态。真实双 Bot 推理受 T04 限制。 |
| T12 | PASS | `worktree.test.mjs` 调用 Windows Git，验证普通目录拒绝创建、目标边界、已存在分支、原目录脏文件保留以及新 Bot 继承权限。 |
| T13 | N/A | 本轮未启用空闲休眠。 |
| T14 | PASS | Windows 打包版从真实 Codex App Server 返回两个额度窗口，界面显示数据来源、查询时间、已用百分比及窗口信息。实际断开节点后显示「额度未知」，无查询入口。 |
| T15 | PASS | `home` / `upgrade` / `plugin-maintenance` 覆盖修改冲突、撤权、用户确认和插件兼容、回滚、在途清理与网页工具。 |
| T16 | BLOCKED | HTTP、SSE 和节点重连自动化通过。Windows 打包版实测搜索定位、原生目录、历史、发送、额度和 Worktree 表单。Windows 会话未暴露可操作的原生窗口句柄，托盘关窗和系统选目录尚未完成；创建 Worktree 在真实 Git 上单独验证。 |
| T17 | PASS | 同一适配器契约覆盖官方 Codex、DSH 和已有节点协议，目录与导入分别验证。 |
| T18 | PASS | 类型检查和 47 项测试通过。两项真实 Codex 冒烟通过。Windows x64 桌面打包成功并启动隔离实例，通过已记录的桌面检查。DSH 真实推理与托盘限制分别见 T04、T16。 |

## 运行记录

Windows 环境使用 Node.js 22.22.3、Git 2.54.0.windows.1、Codex 0.171.0-alpha.13.2、Electron 45.4.1。官方 DSH 0.2.2-rc.5 运行于隔离 Node.js 24.22.3。下列日志位于 `%TEMP%\maoqiu-orca-qa-cceacea1`，目录还含测试数据。日志未附带账号凭据或额度数值。

| 命令或检查 | 结果与记录 |
| --- | --- |
| `npm.cmd ci` | 基线安装成功。 |
| `npm.cmd run check`、`npm.cmd test` | `check.log`、`test.log`。基线 46 项通过，升级后 47 项通过。表中按测试文件名关联每项验收。 |
| `node scripts/smoke-live.ts` | `smoke-live.log`。真实 Codex 委派、回帖、同一线程续问、工具调用、授权材料读取、官方目录与重复导入。 |
| `node scripts/smoke-sessions.ts` | `smoke-sessions.log`。真实 Codex 独立话题、历史读取、服务重启后续问、分支及原生归档与恢复。 |
| `node connector/native-smoke.ts connector/config.example.json dsh-local --inspect-models`，另对隔离官方 ACP 运行新建、重启、续接及提示 | `dsh.log`。原生握手、模型目录和同一会话恢复通过。所用配置只列出一个模型，缺少 DeepSeek 服务凭据，供应商拒绝推理。 |
| `$env:MAOQIU_PACKAGE_OUT='E:/xiaomaoqiu/dist/orca-upgrade'` 后运行 `npm.cmd run package:desktop` | `package.log`。原版桌面运行期间锁定默认输出目录，改用独立目录打包并启动。发行件为 `dist/orca-upgrade/Xiaomaoqiu-win32-x64/Xiaomaoqiu.exe`，含 MIT 声明。 |
| Playwright 通过 CDP 检查打包后的 Electron | `desktop.log`、`desktop-native.log`、`desktop-offline.log`、`desktop-search.png`、`desktop-worktree.png`。首次打开 Agent 设置发现 Windows PATH 某个 DSH 候选不可读取，修复后重包通过。测试会话实际收到 Codex 回复并读到原生历史，断开独立连接器后仍可查看离线缓存。测试过程未取得可验证的原生窗口关窗回执。 |
| `git diff --check`、`git status --short --branch`、`git rev-list --left-right --count HEAD...origin/main` | 差异格式检查通过。提交前本地与远端 `main` 均指向基线，新旧桌面包的运行时文件已对照核实。 |

## 数据与回退

SQLite 版本无需迁移。按[备份与恢复说明](sessions.md#升级与恢复)停机备份，再更换桌面二进制即可。需要回退可切回先前工作台版本，并保留相同版本的数据库。新 Worktree 是真实 Git 工作树，保留的文件和提交通过 Git 检查处理。切回旧版本会失去新版界面入口及排队取消能力。
