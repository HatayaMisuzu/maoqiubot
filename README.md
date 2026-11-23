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

默认示例指向本机 Codex 和 D 盘安装的 DeepSeek Harness 官方 `dsh.cmd`。如果安装路径或工作目录不同，复制 [连接器示例](connector/config.example.json) 为 `connector/config.local.json` 并修改路径。相对工作区路径以连接器的工作目录为准。

给其他前端或脚本测试接口时，使用 `npm.cmd run local` 启动本机 HTTP 服务和连接器，默认端口为 4317。仅需后端时可运行 `npm.cmd start`。

## 项目、话题和模型

1. 在毛球之家创建项目，选择「绑定工作区」，核对执行实例、profile 与工作目录。资料目录备注只用于记录。项目可绑定多个实例，每个实例有自己的工作目录和原生会话。
2. 在项目中打开小毛球话题，发出委派，或直接创建 Codex、DSH 工作话题。任务卡打开同一个工作话题。换 Agent 或执行目录时创建新话题，并在同一项目接续资料和交接。
3. 在工作话题顶部选择下一轮模型，也可以在委派时选择首轮模型。默认沿用目标 Agent 当前会话的模型。DSH 的「读取会话模型」只打开原生会话和读取模型目录。提交委派时复用预读的同一会话，实际发送前由 DSH 确认切换。同名模型按供应方区分。Codex 的可选模型由官方 App Server 提供。
4. 项目实例绑定默认仅收到本轮消息及显式选中的项目材料。引用须处于目标项目的共享范围。若明确开启项目资料授权，运行中的 Agent 可使用项目 API，运行结束或关闭授权后失效。受邀端只能访问授权项目资料和交接。
5. 毛球之家可从时间线选择「带入工作话题」，在目标项目的已绑定实例中选择接手的 Agent，并勾选要转交的原件附件。用户发送后才启动新原生会话。接续交接可记录新的成果版本和未完成事项，项目简报展示当前验收依据和待核验项。
6. 停止请求在有原生执行证据时发给原运行。尚未发出的运行可撤掉待发指令。原生进程退出后，连接器会重启实例。无法核对原生结果时保留「送达待核对」，等待新的证据或人工处理。挂起的下一轮输入需明确继续发送。

实例 ID 固定对应节点、适配器、工作区和 profile。修改这些绑定时配置新实例 ID。连接器记录工作话题对应的原生会话，控制命令同时校验本次运行。在同一项目登记多个不同工作区时，绑定它们的具体实例。资料可以通过项目 ID 接续，原生消息仍归原来的话题。

## 原生接入

- **Codex** 通过本机官方 CLI 和私有 stdio App Server 使用个人 ChatGPT 登录。主聊和 Codex 的执行入口只接收本机请求。官方 Codex 管理登录并直连 OpenAI，工作台只保存话题与原生运行回执。该个人登录方式适用于本机个人使用。 [Codex App Server 认证文档](https://developers.openai.com/codex/app-server/)
- **DSH** 通过桌面安装包里的官方 `dsh --profile acp` 运行。模型列表和当前模型由该 ACP 会话提供。工作台绑定原生会话 ID，按目标项目与工作区续接。 [DSH 会话模型](connector/DSH.md)
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

备份保存数据库、访问配置及对应的附件原件。续接原生会话还需要同一执行机的连接器状态目录和 Agent 自身的会话存储。已经保存的任务和项目结果可直接读取。

## 验证命令

```powershell
npm.cmd run check
npm.cmd test
node scripts/smoke-live.ts
node connector/native-smoke.ts connector/config.example.json dsh-local --inspect-models
```

本机已验证主聊真实委派 Codex、原生回复、同一原生线程续问、只读查询及项目回填。官方 DSH ACP 实测读取模型及切换 V4.1 Flash，官方供应方此前对实际推理返回余额不足。模拟 ACP 测试覆盖停止时序、原生进程重启和防止重复发送。项目交接与布局恢复通过真实 HTTP 测试，涉及续接目标实例的界面流程使用测试节点。

Windows 打包版已验证从可执行文件打开工作台、连接本机 Codex 与官方 ACP、关窗后继续提供服务，以及重复启动时唤回原窗口。桌面界面也已实测归档、检索和通过系统保存对话框下载原件。
