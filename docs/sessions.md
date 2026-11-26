# 会话、原生连接器与 Bot 设置

## 用工作台聊天

点击小毛球打开固定主聊。个人主聊使用同一身份和人格，切换执行模型不会换话题。侧聊保存独立消息。想从某次讨论接着聊，可以选中原话，点分享并选择新会话。分享只保存一份带来源的资料；下次明确发送消息时才交给目标 Bot。

选择联系人后只看该 Bot 的会话。空白新聊在首次发送时创建；从任务卡进入已有工作话题可以接管同一任务。使用原生历史入口读取工作台外产生的原生消息，离线时仍可查看工作台已经收到的内容。原生历史页展示用户与 Agent 的文本，省略原生命令输出和工具调用。

在工作 Bot 设置中修改名称、自然语言描述、启用状态、直聊、委派以及允许的项目。显示名称可重名，连接器以实例身份路由。项目允许列表为空数组表示没有获准项目，设为 `null` 则沿用既有项目映射。仅限指定项目的 Bot 不能通过个人话题使用。在「主聊模型」保存外部模型后，可将它注册为独立 API 工作 Bot；默认打开直聊，主动委派须另行开启。

小毛球可按描述、真实能力、任务、项目和已绑定会话选择工作 Bot。主聊工具权限中的普通路由开关允许复用已经授予的执行范围。工作区映射默认只关联位置，不授予工作 Bot 读取毛球之家资料的权利。从个人主聊选择另一个项目时，原话附件与显式资料不会自动跨范围跟随。只有已有授权目录才参与目录操作；登记现有目录会复用真实路径。新目录上尚无已登记实例时，需要在 Agent 设置中登记对应实例才能在该处运行。两个节点同名目录的文件各自保存在本机。

## 会话与数据

SQLite 主库升级为版本 7。在迁移事务内，从个人范围中选取最近实际聊过的普通小毛球话题作为主聊。没有候选时新建。已有项目话题保持项目边界。唯一索引保证重复启动只得到一个主聊。所有者可以对选定个人侧聊调用 `setMain` 并提供原主聊 ID 与明确确认，原来的话题保留为侧聊。

重置上下文会更新该话题的消息边界。时间线与导出仍能看到旧原文，模型检索和摘要从新边界开始。个人/项目历史、外部模型分享开关及附件权限限制跨聊检索。消息删除后清除相应消息内容、待确认记忆与旧摘要，重新生成上下文。已经确认的长期记忆可在毛球之家单独修订。

归档会话可恢复。原生归档的提交响应含 `scope: "native_pending"`，以命令及原生回执为准。工作台本地操作返回 `scope: "workbench"`。运行中本地归档保留回执通道。最近删除支持恢复；永久清理前可查看受影响的任务、运行、挂起操作与分享数。仍在执行、待核对或有挂起输入时拒绝永久清理。清理范围是本地聊天缓存。独立任务与交付、分享快照、长期记忆、外部原生数据、备份和导出副本分别管理。

分享支持已经可见且获准的聊天正文与附件。工具结果、内部通信及含复合引用的消息不进入快照。跨项目转移由本机所有者预览并确认，限用户原文和目标仍有权访问的附件。模型工具始终在本身可读范围内操作。

## 原生能力矩阵

| 后端 | 会话权威 | 目录和历史 | 生命周期与执行 |
| --- | --- | --- | --- |
| 本机 Codex App Server | 原生 thread ID | 按账号、profile、cwd 核对目录；绑定后可读原生文本分页 | start/resume、turn、steer/interrupt，以及运行时探测到的 fork/archive/unarchive |
| DSH / ACP v1 | ACP session ID | 只在握手声明 list 时查询对应 cwd 的分页目录；没有只读完整消息回放时显示工作台缓存 | new、声明的 resume/load、prompt、cancel；fork/delete 只按握手声明开放 |
| 独立 API 工作 Bot | 工作台本地话题与消息 | 本地分页；当前请求和获准的近期历史送到选定模型 | 复用模型配置，普通文本生成或模型支持的图片输入；没有原生工作目录、会话 ID 或内部工具 |
| 旧连接器 | 沿用原有绑定 | 未声明的新能力视为不可用 | 保留既有派发与回执协议 |

Codex 的本地能力探测与绑定读取通过官方 stdio 接口完成。原生目录支持不等于外部客户端已经释放写入占用。ACP 的 list 与 delete 由协议握手字段声明，fork 属于需要单独协商的扩展。[ACP 目录](https://agentclientprotocol.com/protocol/v1/session-list) · [ACP 删除语义](https://agentclientprotocol.com/protocol/v1/session-delete) · [ACP fork 草案](https://agentclientprotocol.com/rfds/session-fork)

## HTTP / 节点协议

下列路径使用 `/api/v1` 前缀，写请求可以提供稳定的顶层 `requestId`。来源与工作话题关联到任务，运行和命令保持各自的 ID。

| 请求 | 用途 |
| --- | --- |
| GET /threads/main | 返回固定主聊行 |
| GET /threads?instanceId=…&state=active&limit=40&offset=0 | 按 Bot、状态、最近活动分页；状态也可为 archived、deleted |
| POST /threads | 无首条消息时沿用原有建话题接口。携带 `firstMessage` 时，在同一事务创建话题、保存消息并返回 `{thread,receipt}` |
| GET /threads/:id/messages、GET /threads/:id/export | 分页工作台时间线与导出可见文本 |
| GET /threads/:id/native?before=… | 已绑定原生文本历史；返回 items 和 nextBefore。没有能力或实例离线时返回错误 |
| POST /threads/:id/share | 可选 `messageIds`，指定 `targetThreadId` 或 `newThread`。预览用 `preview:true`，跨范围提交另带 `confirmCrossProject:true` |
| GET /threads/:id/impact、POST /threads/:id/lifecycle | 查影响，执行 rename/archive/restore/delete/purge/reset/deleteMessage/fork；`purge` 需先软删并明确确认 |
| POST /threads/:id/lifecycle，action=deleteNative | 仅能力支持时可用。需先软删、提供实际 sessionId 和 confirm=true，并核对所有关联运行 |
| POST /threads/:id/lifecycle，action=markInvalid/replaceNative | 人工核对失效原因和原生 ID，保留旧绑定及替代关系。在替代话题首次发言时才启动运行 |
| GET 或 POST /instances/:id/settings | 读取或持久化用户覆盖配置；重连不会清除 |
| POST /instances/api | 从已有外部模型 ID 幂等注册工作 Bot；模型访问凭据仍使用原有本机配置 |
| POST /tasks | 支持新建任务、指定已有工作话题或精确继续 taskId，可保存 routeReason |
| POST /chat/continue | 本机所有者在当前策略硬限内恢复 budget_paused 的同一 messageId，保留已经使用的次数与工具结果 |
| GET 或 POST /threads/:id/budget | 设置小毛球会话的 `toolBudget: {softLimit,hardLimit}`，用 null 恢复继承。发送消息时可在请求中带 `toolBudget` 覆盖单轮 |

原生读历史使用 `read_history/history` 查询帧。分支和原生归档类变更复用有持久回执的 prepare 命令，携带来源话题、来源 session ID 和操作。连接器核对本地绑定后才调用原生方法。提交后中断且无法核对时进入 uncertain。

主聊工具次数由工作台记录。可在聊天的「会话」菜单中设置起始次数和硬限，两项均受工作台全局硬限约束。软预算会随任务进展增加；审批前的提议不计入已执行次数。连续失败、重复操作与送达待核对会停止自动执行。真实原生 Agent 内部调用次数与费用由该服务管理。

## 升级与恢复

退出指向实际数据目录的旧实例，再用仓库备份命令保存数据库、附件及连接器状态。示例命令采用尚不存在的目标目录。

```powershell
npm.cmd run backup -- save data backups/before-session-v7 --offline --connector data/node-local --connector-config data/desktop-connector.json
npm.cmd run backup -- restore backups/before-session-v7 backups/restored-v6
```

恢复时选用与备份兼容的程序版本，将其数据目录指向恢复出的新目录，再核对原生连接器配置。独立保存模型密钥或重新配置环境变量，既有备份机制不会复制本机模型密钥文件。切勿用旧版程序直接打开 v7 原库。
