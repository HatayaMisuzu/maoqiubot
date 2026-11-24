# 小毛球 Bot 工作台

这是 Windows 个人桌面工作台。后端、毛球之家和附件共用一份 SQLite 数据目录。工作 Bot 在配置的机器和工作区运行，桌面界面通过本机 HTTP 和 SSE 接口访问工作台。

## Windows 桌面版

在项目目录下使用 [Xiaomaoqiu.exe](dist/Xiaomaoqiu-win32-x64/Xiaomaoqiu.exe) 打开桌面窗口。复制时保留同一文件夹内的运行库和资源。关闭窗口会收进系统托盘，正在运行的任务会继续执行。从托盘菜单可重新打开或退出工作台。

分发目录位于项目的 `dist` 中时，桌面版沿用项目的 `data` 文件夹和连接器配置。移到别处后，默认使用应用的用户数据目录。可以通过 `MAOQIU_DATA` 显式指定已有数据目录，通过 `MAOQIU_CONNECTOR_CONFIG` 指定连接器 JSON。切换启动方式前应先退出使用同一数据目录的旧进程。

### 源码启动与打包

需要 Node.js 22.18 或更新版本。DSH 桌面版的官方启动器使用它自带的运行环境。

```powershell
Set-Location E:\xiaomaoqiu
npm.cmd ci
npm.cmd run desktop
npm.cmd run package:desktop
```

桌面首次启动会在 PATH 和常用安装目录查找官方执行入口。非标准 DSH 安装位置可在「Agent 设置」填写官方 `dsh.cmd` 的绝对路径，或在启动前设置 `MAOQIU_DSH_EXECUTABLE`。保存后点「测试连接」应用配置并查看各实例握手。托盘菜单也可重启连接器。有运行已送达时，工作台会提示等待或先停止该运行。实际推理还取决于原生账号与额度。

桌面配置默认保存到数据目录的 `desktop-connector.json`。高级配置仍可使用 `connector/config.local.json` 或 `MAOQIU_CONNECTOR_CONFIG`。相对工作区路径以连接器的工作目录为准。

给其他前端或脚本测试接口时，使用 `npm.cmd run local` 启动本机 HTTP 服务和连接器，默认端口为 4317。仅需后端时可运行 `npm.cmd start`。

## 项目、话题和模型

1. 在毛球之家创建项目，选择「绑定工作区」，核对执行实例、profile 与工作目录。资料目录备注只用于记录。项目可绑定多个实例，每个实例有自己的工作目录和原生会话。
2. 在项目中打开小毛球话题，发出委派，或直接创建 Codex、DSH 工作话题。任务卡打开同一个工作话题。换 Agent 或执行目录时创建新话题，并在同一项目接续资料和交接。
3. 在工作话题顶部选择下一轮模型，也可以在委派时选择首轮模型。默认沿用目标 Agent 当前会话的模型。DSH 的「读取会话模型」只打开原生会话和读取模型目录。提交委派时复用预读的同一会话，实际发送前由 DSH 确认切换。同名模型按供应方区分。Codex 的可选模型由官方 App Server 提供。
4. 项目实例绑定默认仅收到本轮消息及明确选中的材料。开启资料访问后，工作台会附上当前有效的项目约束与交接，并发放单次运行令牌。可选只读、追加或管理，默认只读。令牌最长有效 24 小时，运行进入终态、送达待核对、撤销授权或解绑后即失效。
5. 毛球之家可从时间线选择「带入工作话题」，在目标项目的已绑定实例中选择接手的 Agent，并勾选要转交的原件附件。用户发送后才启动新原生会话。接续交接可记录新的成果版本和未完成事项，项目简报展示当前验收依据和待核验项。
6. 停止请求在有原生执行证据时发给原运行。尚未发出的运行可撤掉待发指令。原生进程退出后，连接器会重启实例。无法核对原生结果时保留「送达待核对」，等待新的证据或人工处理。挂起的下一轮输入需明确继续发送。
7. 「执行结束」「成果已提交」和「验收通过」分别显示。有交付条件时，可在工作话题逐项填写核对依据。Agent 自报的检查结果会显示在项目简报的待核验材料中。

实例 ID 固定对应节点、适配器、工作区和 profile。修改这些绑定时配置新实例 ID。连接器记录工作话题对应的原生会话，控制命令同时校验本次运行。在同一项目登记多个不同工作区时，绑定它们的具体实例。资料可以通过项目 ID 接续，原生消息仍归原来的话题。

主聊可通过顶部「主聊人格」保存或恢复默认，也可编辑数据目录的 `persona.md`，下一轮生效。对话默认加载最近 60 条，可点击「加载更早消息」。

毛球之家支持中文检索分页、来源与附件分享、记录修订和遗忘。页面和集合可通过表单编辑并预览版本变更。恢复空间默认恢复历史页面布局并保留当前集合字段及条目，也可显式转换不兼容的值后恢复历史字段定义。

## 独立主聊与协作

1. 打开「主聊模型」，保留本机 Codex 或添加自己的 OpenAI-compatible Chat Completions 端点。填写 Base URL（例如网关的 `https://example.com/v1`）、模型 ID 和密钥，保存后可测试或读取模型列表，再选「设为主聊」。模型切换从下一轮生效，工作 Bot 保留各自的原生模型。
2. 根据服务能力开启原生工具、JSON Schema、图片或流式接口。文本模型可直接聊天，工具必须由结构化决策或原生函数调用提出，再由本地宿主验证。流式纯文本会实时显示，结构化动作在完整校验后执行。外部模型会收到本轮消息，项目、个人历史与记忆、引用和附件的发送分别由开关控制。
3. 在「主聊权限」开启所需内容管理和空间布局权限。配置可读取的普通文本资料目录及可新建文本的目录。文件工具受目录白名单、扩展名和体积限制；内容管理和目录授权可以撤回。项目的 Bot 工作区绑定继续在毛球之家操作，原生执行审批由用户在工作话题处理。
4. 在个人话题说「请记住，我偏好 Markdown 交付」，另开话题询问此偏好。记忆正文和修订可在毛球之家检索，主聊回复可展开「引用记忆」查看使用的版本。随后可请小毛球读取允许目录中的 `brief.md`。在项目话题中试用「给这个项目创建一个交付页面，并新建一个进展集合」；空间读取、预览、应用均使用实际 Home API。
5. 在同一项目绑定 DSH 与 Codex，按需开启资料访问。先委派 DSH 调研并给出完成标准。工作 Bot 可通过运行令牌提交澄清或交接；用户在主聊明确回复后，可请小毛球转达。验收待处理运行时，已挂起的补充可在工作话题继续发送。DSH 交接入库后明确请小毛球把交接转给 Codex，再在「任务通信」核对两端主体、回执、版本和材料，进入工作话题完成验收。

当前原生协议是本机 Codex 和 OpenAI-compatible Chat Completions。Anthropic Messages 与 Gemini 原生协议需要独立适配器。扩展接入时实现 [ChatProvider](server/chat/provider.ts) 的 `generate`，参照 [Chat Completions 适配器](server/chat/compatible.ts) 做协议、超时和取消转换，并接入模型配置与探测。凭据本机单独保存，或引用 `MAOQIU_MODEL_KEY_*` 环境变量。切换供应方时会清空旧端点密钥，除非明确填写新的密钥。外部模型默认关闭资料共享和各种扩展能力。

小毛球目前可查实例、已绑定会话、任务及通信，执行明确授权的委派、转达、停止、恢复查询、记忆与资料操作。在「Agent 设置」可测试连接、修改实例及重连。原生权限审批、外部原生会话选择、项目解绑和破坏性布局变更通过现有界面操作。公开网页检索、桌面文件打开与自动提醒目前无可用主聊工具。

## 原生接入

- **Codex** 通过本机官方 CLI 和私有 stdio App Server 使用个人 ChatGPT 登录。支持会话目录的实例可在「开始新对话」选择「导入已有会话」，核对本机账号、工作区及 profile 后绑定。原客户端仍占用会话时须先释放。重复导入打开已有话题，既有历史在原客户端查看。 [Codex App Server 认证文档](https://developers.openai.com/codex/app-server/)
- **DSH** 通过桌面安装包里的官方 `dsh --profile acp` 运行。模型目录由 ACP 提供，工作台可续接已绑定的原生会话。当前 DSH 实例没有可核对的外部会话目录。 [DSH 会话模型](connector/DSH.md)
- **Antigravity** 消费版由用户在官方客户端使用。Google 官方明确说明消费版不支持把 CLI 封装进第三方应用。接入 Gemini 或业务版时采用相应的公开 API 和授权流程。 [Antigravity FAQ](https://antigravity.google/docs/faq/)

## HTTP、SSE 和备份

所有者令牌在数据目录的 `access.local.json`。下列请求用本机地址与同一工作台令牌。毛球之家的空间、交接和修订示例见 [项目 API](server/home/API.md)。

```powershell
$base = 'http://127.0.0.1:4317/api/v1'
$auth = @{ Authorization = 'Bearer ' + (Get-Content .\data\access.local.json -Raw | ConvertFrom-Json).ownerToken }
Invoke-RestMethod "$base/instances" -Headers $auth
$thread = Invoke-RestMethod "$base/threads" -Headers $auth -Method Post -ContentType 'application/json' -Body (@{instanceId='codex-local';title='验收';requestId=[guid]::NewGuid().ToString()} | ConvertTo-Json)
$snapshot = Invoke-RestMethod "$base/threads/$($thread.id)" -Headers $auth
curl.exe -N -H "Authorization: $($auth.Authorization)" "$base/events?after=$($snapshot.cursor)"
```

委派用 `POST /tasks`，传入 `requestId`、`originThreadId`、`instanceId`、`goal`，可另带 `projectId`、`attachmentIds`、`materialRefs`、`doneWhen` 和 `modelId`。有项目时先绑定目标执行实例。

需要在派单前读取模型时，先用 `POST /tasks/draft` 传入 `originThreadId`、`instanceId` 和 `projectId`，再对返回的线程 ID 调用 `POST /threads/:id/model` 并提交 `{"prepare":true}`。轮询 `GET /threads/:id` 读取原生模型状态，派单时把同一个线程 ID 作为 `workThreadId` 提交到 `POST /tasks`。已有工作话题可在两轮之间通过模型接口设置下一轮的 `modelId`，或设置 `null` 以沿用原生会话当前模型。`GET /tasks/:id` 读取任务和执行状态。

```powershell
npm.cmd run backup -- save data backups\snapshot
npm.cmd run backup -- restore backups\snapshot restored-data
$env:MAOQIU_DATA = 'restored-data'
npm.cmd start
```

备份保存数据库、自定义人格、对应的附件原件，以及主聊模型和权限设置。模型密钥需在恢复后重新配置。默认包含工作台 owner/node 访问配置，需要重新生成令牌时可用 `--without-access`。升级会自动迁移旧库。工作台恢复使用新的目标目录，并核对数据库、附件长度及内容摘要。

完整停机备份先在桌面托盘退出服务和连接器，再用 `npm.cmd run backup -- save data backups\snapshot --offline --connector data\node-local`。需保留连接器配置副本时加 `--connector-config data\desktop-connector.json`。在线快照恢复后，未确认的运行进入「送达待核对」，不会自动重发旧输入。恢复后的连接器 SQLite 位于 `node-local`，配置副本需核对工作区和实例 ID 后显式选用。续接还需要原执行机保有相应原生会话与 profile。含访问配置的备份须保存在私有目录。

## 验证命令

```powershell
npm.cmd run check
npm.cmd test
node scripts/smoke-live.ts
node connector/native-smoke.ts connector/config.example.json dsh-local --inspect-models
```

测试覆盖本地兼容 HTTP 端点、两个测试节点间的任务通信、项目 ACL、记忆、备份和恢复。本机原生冒烟分别检查 Codex 派单、回复、同一线程续问、只读查询与项目回填，以及 DSH ACP 模型目录。DSH 跨 Bot 交付需要可用的推理额度。真实外部主聊服务应使用用户授权的配置单独测试。

Windows 打包版已验证从可执行文件打开工作台、连接本机 Codex 与官方 ACP、关窗后继续提供服务，以及重复启动时唤回原窗口。桌面界面也已实测归档、检索和通过系统保存对话框下载原件。
