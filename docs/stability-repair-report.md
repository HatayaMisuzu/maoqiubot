# 小毛球工作台稳定性修复与验收

> **历史验收快照**：本文档记录对应阶段完成时的基线与实测结果，不再随后续改动重写；现行架构、接口与操作说明请以 [docs/README.md](README.md) 及各专题文档为准。

2026-11-26 · Windows 11 x64（22631）· Node.js 22.22.3 · npm 12.0.2 · Electron 45.4.1

## 基线与交付范围

起始分支为 `main`，工作区干净，`HEAD` 与 `origin/main` 均为 `bdc23ce6b46f9f2aad0f6ee768c2ce7f8c11ebf7`。隔离 worktree 从该提交冷安装并运行，类型检查通过，Node 47 项通过。GitHub 同一提交的 [Windows CI](https://github.com/HatayaMisuzu/maoqiubot/actions/runs/45755295898) 同样通过。iSH/Alpine 的 43/47 属于先前报告的另一环境。本轮针对缺陷重建 fixture，原报告的 `/tmp/audit/*` 脚本未提供。

基线浏览器实际复现了附件等待期间切换会话导致发送目标变化，以及带属性 Markdown 围栏导致渲染超时。三工作 Bot 加主控的请求计数如下。启动阶段仅计活跃、归档或删除列表请求；事件样本为正在阅读主聊时新建另一条主控侧聊。

| 相同场景 | 基线 | 修复版 |
| --- | ---: | ---: |
| 启动时的会话列表 GET | 12 | 4 |
| 新建侧聊事件触发的会话列表 GET | 12 | 1 |
| 该事件触发的所有 API GET | 16 | 1 |

## 验收矩阵

**证据**中，浏览器和协议 fixture 均在隔离工作台中使用合成会话及凭据。真实原生和桌面验证单列。标记 `PARTIAL` 的行列出了尚未实测的分支或环境限制。

| 编号 | 状态 | 问题、修改与证据 |
| --- | --- | --- |
| T01 | FIXED/PASS | `web-demo/chat.js` 在首次异步操作前固定发送路由。基线误投，修复后延迟附件并切换主聊到侧聊，持久消息进入主聊，侧聊草稿保留。见 `e2e/workbench.spec.mjs`。 |
| T02 | FIXED/PASS | 新草稿以实例和项目为键，首次消息与话题创建原子提交。真实浏览器切换到毛球之家和另一 Bot 草稿，原生指令仍带原实例、项目和模型，页面保留新草稿。 |
| T03 | FIXED/PASS | 发送期间冻结原草稿编辑，重试复用消息、建话题和附件 ID。浏览器模拟服务器成功但响应丢失，仅产生一条消息和一个话题。延迟上传用例同时验证重复 Enter 无第二次派发。 |
| T04 | FIXED/PASS | 草稿附件按项目独立，后端继续核对附件、引用和工作 Bot 权限。浏览器验证跨项目切换、原项目委派、切换后使用原运行的恢复确认及禁用入口。权限断言见 `test/upgrade.test.mjs`、`test/project-routing.test.mjs`。 |
| T05 / H-2 | FIXED/PASS | `server/sessions.ts`、`server/tasks/index.ts`、`connector/store.ts` 区分本地 purge、原生删除和安全解绑。精确解绑回执与连接器本地绑定删除同事务，服务端收到匹配结果才更新目录。v9 保留旧清理记录，所有者可逐条处理。fixture 检查释放前不可导入、非原范围不可导入及不可放弃待核对释放。真实 Codex 走完软删、清理、解绑、连接器重启和同 ID 导入，并重新读到实际回复。 |
| T06 / M-6 | FIXED/PASS | `server/chat/approval.ts`、`server/chat/tools.ts`、`server/plugins/host.ts` 和插件界面把代码与网络授权交给用户，并绑定摘要、操作、差异、能力及宿主状态。测试拒绝模型布尔值、普通审批和失效审批。独立验证更新、回滚和在途调用。外部 JavaScript 以宿主权限执行。 |
| T07 | FIXED/PASS | 本地 `markdown-it` 解析代码围栏、表格和列表。浏览器重开历史验证未闭合围栏、属性、危险 HTML/URL；流式使用纯文本，正式消息落盘后渲染。 |
| T08 | FIXED/PASS | `npm run test:e2e` 在 Windows CI 安装 Chromium 并执行。测试断言导航、持久消息、节点命令和页面错误，失败时保存合成数据的截图与 trace。 |
| T09 | FIXED/PASS | 浏览器验证主聊、侧聊、原生首轮模型、任务卡精确跳转、归档恢复、禁用及排队取消。Node 任务复用、等待输入和插件审批用例继续覆盖服务端。 |
| T10 / H-1 | PARTIAL | `connector/index.ts` 将可变 prepare 放在现有工作区队列并允许队列取消，获得锁后才发 `accepted`。前端按队列、原生执行、取消和待核对显示阶段，排队时间不计入原生 RPC 超时。队列 fixture 和浏览器取消覆盖已执行。超时按实际原生 RPC 生效，未设整个复合 prepare 的独立总时限。 |
| T11 / M-2 | PARTIAL | `connector/adapters/codex.ts` 等待已获原生 ID 的回合结果，完成先到可保存结果，无可靠身份仍待核对。`test/codex-turn-recovery.test.mjs` 覆盖完成早于 ACK、已知 ID 的超时及无 ID 的超时。真实进程重启恢复由 DSH fixture 和 Codex 冒烟另测。 |
| T12 / M-9 | NOT_REPRODUCED | `connector/index.ts` 为每个实例合并在途启动，旧适配器回调受实例与代际约束。重启 fixture 覆盖停止旧进程、恢复与不重放；基线未复现重复原生进程。 |
| T13 / L-13 | FIXED/PASS | `connector/store.ts` 保存内容摘要和必要路由。工作区、profile、操作与请求内容参与计算，短期令牌值排除。旧无摘要命令保留原记录，冲突不覆盖其本地回执。命令重放、迁移和冲突测试见 `test/connector-recovery.test.mjs` 与 `test/upgrade.test.mjs`。 |
| T14 / M-1 | FIXED/PASS | 统一 `cancelling` 时通信签发范围、授权校验和清理。`test/upgrade.test.mjs` 覆盖期限、权限、撤权、解绑及终态，原生终态仍走节点协议。 |
| T15 / M-3 | FIXED/PASS | `server/home/spaces.ts` 在结构变更写入前核对每个受影响条目的 revision，缺失或陈旧拒绝整批。`test/home.test.mjs` 验证布局恢复、条目保留、冲突和原子性。 |
| T16 / M-5 | FIXED/PASS | `connector/grant-files.ts` 写入当前用户专用目录。Windows 用 `icacls` 检查合成凭据文件，继承权限仅含当前用户、Administrators 与 SYSTEM。测试正常清除、过期遗留、并行进程和未知文件保护。旧版散落目录缺少持有者标记，保留原状。 |
| T17 / L-3 | FIXED/PASS | `POST /grants` 仅首次返回明文，幂等墓碑拒绝再次取回。迁移和 `scripts/backup.ts` 处理已知旧缓存，测试保留 requestId 且合成明文未出现在新备份数据库。已有旧备份可能仍含明文。 |
| T18 / M-7 | FIXED/PASS | 网页请求和搜索共用明显凭据筛查，读取前与每一跳核对地址；公开正常链接可继续访问。受控代理和合成 URL 用例验证，外泄机制为静态风险，未向真实站点发送测试秘密。 |
| T19 / M-8 | FIXED/PASS | `server/plugins/http.ts` 的 `privateLan` 专用于私有地址，公共 API 使用 HTTPS 独立权限。LAN/公网、DNS、重定向、代理和 SearXNG 测试见 `test/upgrade.test.mjs`，未取得原 39 项脚本。旧公网 SearXNG 迁移见 `plugins/README.md`。 |
| T20 / L-4 | DESIGN_RETAINED | `server/chat/tools.ts` 中主控读取个人资料保留所有者权限。ACL 用例覆盖个人/项目、获授权原件、Bot 运行和撤权，当前路径未发现越权。 |
| T21 / L-6 | FIXED/PASS | `sharePersonal` 控制个人历史与记忆，用户本轮显式附加文件由 `shareAttachments` 控制，项目资料仍按自身授权。配置组合通过真实本地 HTTP 接收的合成模型请求核对。 |
| T22 | FIXED/PASS | `web-demo/app.js` 按事件范围合并刷新，归档按需，历史页按消息 ID 合并。浏览器计数见上表，另验证断线追加消息和保留草稿。 |
| T23 / M-4 | FIXED/PASS | `server/index.ts` 对非法 Origin 返回 400，对 opaque/跨源返回 403。`test/workbench.test.mjs` 以实际 HTTP 请求核对。 |
| T24 / L-1 | FIXED/PASS | `connector/rpc.ts` 过滤影响原生 Node 启动的宿主覆盖环境变量。测试检查污染过滤及普通环境保留，实际官方 Codex 与 DSH 入口均启动。 |
| T25 / L-2 | FIXED/PASS | 幂等签名按 query 键排序，保留重复键顺序和旧无 query 签名。HTTP 测试覆盖同请求重试和语义冲突。 |
| T26 / L-5 | DESIGN_RETAINED | 保留 `BEGIN IMMEDIATE` 单层事务。核对路由和数据 helper，空间恢复冲突测试验证整批回滚。 |
| T27 / L-7 | DESIGN_RETAINED | 当前与历史均按版本来源授权检查。`test/home.test.mjs` 验证被撤销或未分享的原件和历史内容不对受邀端开放。 |
| T28 / L-8 | FIXED/PASS | `chat_delta` 仍为临时事件。浏览器验证断线清空预览、恢复持久记录、按当前线程和待处理消息过滤迟到的 delta。 |
| T29 / L-9 | FIXED/PASS | `connector/adapters/dsh.ts` 在终态和错误释放取消/接受追踪。`test/dsh-models.test.mjs` 及连接器重启 fixture 覆盖原生模型准备、取消与断线。 |
| T30 / L-10 | FIXED/PASS | 超过 24 MiB 先完整回送 413 再关闭连接。HTTP 验证状态、响应体和新连接仍可用。 |
| T31 / L-11 | FIXED/PASS | `server/chat/index.ts` 重复成功读取持久回执，只读失败最多重试一次，写入不重做。`test/chat-budget.test.mjs` 断言审批、硬限、真正只创建一条事项，以及重启回执恢复。 |
| T32 / L-12 | FIXED/PASS | 协调白名单使用实际 `utility_clock`，其余仍受协调模式和范围约束。项目协调 fixture 检查事实读取、交接目标与通信回执。 |
| T33 | FIXED/PASS | 真实 `scripts/smoke-sessions.ts` 和 `scripts/smoke-live.ts` 校验官方 Codex 多轮、原生 ID、目录和历史、重启续接、分支、归档及恢复，均退出 0。 |
| T34 | PARTIAL | 官方 DSH ACP 握手和目录真实返回 5 个模型。单次短推理返回 `Insufficient Balance`。重启后打开同一 session ID 并从 DeepSeek 官方 V4 Flash 切换到 DeepSeek 账号 V4.1 Flash，已核对模型状态。补充额度后复测一条短推理和同 ID 后续回复。 |
| T35 | PARTIAL | 真实主控选择 Codex、触发用户审批并执行，检查授权的测试文件和结果，随后从另一侧聊检索并续接同一原生目标。双 Bot 交接的主体、taskId/runId、转达、证据验收由 fixture 覆盖，真实 DSH 交接需先通过 T34 推理。 |
| T36 | PARTIAL | 真实 Electron 源码启动与渲染，窗口关闭后同一主进程继续运行，重复启动退出并唤回原窗口。附件与 Git Worktree 分别打开 Windows 文件、目录选择器，均正常取消。通知区域菜单的唤回和退出、关窗时实际进行中任务的继续未实测。 |
| T37 | FIXED/PASS | 临时 v1 主库和连接器库升级后可重复打开，旧附件、映射与检索保留。备份恢复到新目录，损坏附件和已有目标目录被拒绝。既有 ACL、实际 Git Worktree、插件、API Bot 与适配器用例保留。 |
| T38 | FIXED/PASS（本机） | `npm run check`、`npm test`（56 通过、0 失败、0 跳过）、`npm run test:e2e`（Edge 158.0.4370.45，12 通过）及 Git 差异检查通过。日志路径见下。远端检查按其对应的 `main` 提交核对。 |
| T39 | FIXED/PASS | 独立 Windows x64 包与 87 个源码运行文件逐字节一致，另核对 37 个生产依赖版本及其 37 份许可证文件、Electron/Chromium 许可、离线 Markdown 模块。未发现用户数据库、`.local.json`、`.env`、项目测试目录或 Playwright 开发依赖随包。实际启动该 EXE，主题切换、命令面板和检查器通过，渲染器与控制台错误均为零。 |

## 备份、升级与回退

工作台数据库升至 v9，连接器数据库升至 v2。旧连接器可继续原有协议，安全解绑需要连接器声明新能力。已清理的原生绑定由所有者在该 Bot 的回收站逐条核对、解绑。收到确认后仍限定原账号、工作区、项目和实例。持久回执用于连接重连时核对结果。

迁移真实数据前，先在运行完成后退出当前工作台，使用 `npm run backup -- save` 和 `--offline` 将主库、附件及对应连接器状态保存到新目录。涉及访问设置的备份须保存在私有位置。需要回退时，使用升级前的备份执行 `npm run backup -- restore` 到另一个新目录，旧版经独立 `MAOQIU_DATA` 和连接器配置启动。新版数据库不会直接交给旧版打开。详见 [会话与升级](sessions.md)。

Markdown 增加生产依赖 `markdown-it@15.0.3`（MIT），浏览器模块和许可证随桌面包分发。`@playwright/test@1.65.1` 为开发依赖。运行时代码以 `65bcc45886f039ea0459f7bd417a683f51cb270f` 为准，改动清单见该提交。验收报告单独提交。Windows 工作流按 `main` 的完整交付提交运行。 [运行时代码改动](https://github.com/HatayaMisuzu/maoqiubot/commit/65bcc45886f039ea0459f7bd417a683f51cb270f) · [Windows 工作流](https://github.com/HatayaMisuzu/maoqiubot/actions/workflows/check.yml?query=branch%3Amain)

## 桌面与发行件

源码启动和真实模型冒烟均使用隔离数据和配置。独立发行目录为 `E:\xiaomaoqiu\dist\stability-20261126\Xiaomaoqiu-win32-x64`，入口为 `Xiaomaoqiu.exe`。保留整个目录运行，现有发行目录保持原样。通知区域菜单尚需在 Windows 任务栏打开「打开小毛球」并实际执行「退出工作台」补验。

本机核对日志位于 `%TEMP%\maoqiu-stability-final-node.log`、`%TEMP%\maoqiu-stability-final-e2e2.log`、`%TEMP%\maoqiu-stability-packaging.log` 和 `%TEMP%\maoqiu-stability-live-release.log`。测试日志、临时工作目录及发行包均在 Git 之外。
