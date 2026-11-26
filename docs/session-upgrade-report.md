# 会话升级验收报告

验收日期为 2026-11-26。起始版本为 `3e637c251ae3d2f6f9e72a7663d1c0effa68c2ca`。源码、迁移、测试和这份报告一并提交，交付提交可用 `git log -1 -- docs/session-upgrade-report.md` 查询。

## 验收结果

| 编号 | 结果 | 已核对的证据及限制 |
| --- | --- | --- |
| T01 | 通过 | 真实 v6 备份数据库副本升级至 v7，打开两次得到同一主聊 ID，已有会话 ID 及消息、任务、运行和实例数保留，SQLite 完整性与外键检查通过。空库测试同时启动四个 Node 进程，得到同一个主聊。 |
| T02 | 通过，仓库测试 | 主聊使用模型输入额度挑选近期原文与旧消息摘要，保留当前用户正文。摘要记录压缩到的消息 ID，原文通过消息接口分页。测试覆盖持久摘要和人格读取，独立于执行模型的主聊 ID 由数据库约束与重开测试验证。 |
| T03 | 通过，仓库测试 | 中文片段检索、独立侧聊、外部模型范围、项目隔离、归档检索、重置和删除边界。旧消息仍可由所有者导出。 |
| T04 | 通过，真实 Codex | 同一工作区建立直聊 A、委派 B、独立 C 三个原生 ID。追加到 B 后仍使用原 ID，原生历史包含新回复。见 `scripts/smoke-sessions.ts`。 |
| T05 | 通过，真实 Codex | `scripts/smoke-live.ts` 跑通同会话多轮、跨聊天查询已完成任务和同数据源外部会话幂等导入。服务和连接器重启后，从另一条侧聊继续任务 B，工作话题和原生 ID 保持一致，原生回复包含用户接管后新增的内容。 |
| T06 | 通过，本机与仓库测试 | 路由测试发现并复用现有目录、登记项目、隔离资料权限，且仅在显式许可的根目录创建新工作区。握手拒绝原生运行身份变化，连接器拒绝不匹配的工作目录或 profile。Codex 同工作区新目标使用新原生会话。 |
| T07 | 通过，仓库测试 | 控制、挂起、断线、送达待核对、命令去重、按任务投递及同节点相同工作目录串行均覆盖。并发测试启动真实连接器进程，使用测试 ACP 服务观测两次 prompt 的顺序和次数。不同节点的工作目录各自管理。 |
| T08 | 部分真实验证 | 官方 DSH ACP 创建会话、读取模型及工作区会话目录、重启后恢复原 ID 均实测。握手未宣告原生 fork、archive、delete 或只读历史回放。两次推理均返回 `Insufficient Balance`。API 工作 Bot 经过本机真实兼容 HTTP 请求验证，模型端为测试服务。 |
| T09 | 通过，仓库测试 | 用户保存的名称、描述、启用及使用范围跨节点重连保留。后端核查个人/项目白名单、派发、直聊和再次发送，原有运行回执继续接收。 |
| T10 | 通过，真实 Codex 与仓库测试 | 真实 fork、archive、unarchive 收到回执，恢复使用原绑定。源码测试覆盖软删除、恢复、永久删除前检查、保留独立快照。Codex 在本机未提供原生永久删除能力。外部会话缺失而连接器无法确认删除时，需由所有者核对后标记失效。 |
| T11 | 通过，仓库测试 | 已有或新目标使用独立快照。预览无创建和调用副作用，首次明确发送时带入，附件权限逐项复核，来源清理后快照可用；跨项目仅所有者可确认转移符合规则的原文。 |
| T12 | 通过，真实 Codex 与仓库测试 | 25 个已启用 Skill 的末尾项仍可搜索。真实 Codex 通过已配置的本机代理主动读取公开站点，收到 HTTP 200，回复含实际页面标题和来源。普通问候直接回复。直连时的保留地址仍被插件拒绝。 |
| T13 | 通过，仓库测试 | 现版源码、相对路径、多文件修订、差异与并发版本校验经过 HTTP 测试，启用和回滚复用插件宿主。扩展代码按现有本机信任授权执行；宿主目前没有可用于运行未经审查代码的隔离环境，静态验证与实际调用各自记录结果。 |
| T14 | 通过，仓库测试 | 次数随工具调用增加，初始预算可按会话或本轮调整；硬限暂停，续行保留已完成结果；实际重启后读取已有回执，未取得持久回执的操作待核对。审批沿用原有确认机制。 |
| T15 | 通过，实际浏览器 | Windows Edge 1440×900 和 390×844 检查立绘和面板、主/侧聊、联系人、延迟创建、分享、归档恢复、Bot 设置和预算暂停。联系人列表隔离，切回工作 Bot 恢复上次查看的话题。主聊预算、上下文重置与指定消息删除均复核了写入结果。小屏侧栏及键盘退出通过检查，无横向溢出和浏览器控制台错误。浏览器使用隔离数据。 |
| T16 | 通过，仓库全量回归 | `npm.cmd run check`、`npm.cmd test`（46 项全部通过）、`git diff --check` 均通过，保留原有回归断言。 |

## 复测入口

```powershell
npm.cmd run check
npm.cmd test
node scripts/smoke-sessions.ts
node scripts/smoke-live.ts
node connector/native-smoke.ts connector/config.local.json dsh-local --inspect-models
```

两个 Codex 命令使用当前已登录的官方 CLI 和临时工作台目录。会话冒烟会创建独立的原生测试会话。DSH 配置需要填写本机官方入口和工作目录，可用 `--resume-session=<会话ID>` 和 `--inspect-models` 核对重开，在推理额度可用时发送短消息确认实际回复。公开网页复测可先在网页插件中对一个允许读取的公开 URL 运行「连接测试」，再从小毛球主聊请求读取该链接并核对工具卡中的 URL、标题和时间。

手动复测桌面或手机时，使用隔离数据启动应用。点击小毛球，记录固定主聊；新建侧聊输入一条消息，再切回小毛球。切换到另一联系人核对列表，打开新聊观察首次发送前后。通过会话菜单测试归档和恢复，并从任意会话分享两条消息至另一会话。检查目标仅在明确发送时接收引用，且会话中可展开来源。

## 数据升级与回滚

升级前已使用现有备份命令保存实际 v6 数据和本机连接器状态。此次用备份副本验证迁移。SQLite v7 包含固定主聊、会话状态、Bot 用户配置、任务会话关系、原生作用域和工具预算记录。需要退回旧版时，用 `backup restore` 恢复到新目录，将起始提交的旧版程序指向恢复目录，按旧配置重新连接。模型凭据按原配置独立保管。步骤见 [升级与恢复](sessions.md#升级与恢复)。

## 变更文件

- 数据与会话：`server/db/index.ts`、`server/db/sessions.ts`、`server/db/chat-budget.ts`、`server/sessions.ts`、`scripts/backup.ts`。
- 调度、授权与接口：`server/tasks/index.ts`、`server/tasks/bots.ts`、`server/tasks/api-bots.ts`、`server/tasks/workspaces.ts`、`server/index.ts`、`server/api/routes.ts`、`server/api/nodes.ts`。
- 主聊上下文、审批、预算与插件：`server/chat/index.ts`、`server/chat/approval.ts`、`server/chat/budget.ts`、`server/chat/files.ts`、`server/chat/memory.ts`、`server/chat/tools.ts`、`server/plugins/host.ts`。
- 原生协议与连接器：`contracts/node.ts`、`connector/types.ts`、`connector/store.ts`、`connector/index.ts`、`connector/adapters/codex.ts`、`connector/adapters/dsh.ts`。
- 工作台：`web-demo/app.js`、`web-demo/chat.js`、`web-demo/lib.js`、`web-demo/main-settings.js`、`web-demo/style.css`。
- 验收：`scripts/smoke-sessions.ts`、`test/upgrade.test.mjs`、`test/workbench.test.mjs`、`test/connector-recovery.test.mjs`、`test/sessions.test.mjs`、`test/api-bot.test.mjs`、`test/project-routing.test.mjs`、`test/chat-budget.test.mjs`、`test/plugin-maintenance.test.mjs`。
- 说明：`README.md`、`connector/DSH.md`、`docs/sessions.md`、本报告。
