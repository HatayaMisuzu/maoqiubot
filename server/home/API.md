# 毛球之家公共 API

在运行服务的机器上，从仓库根目录打开 PowerShell。下面的调用使用默认地址和数据目录。设置过端口或 `MAOQIU_DATA` 时对应调整。工作台页面、获准的外部 Agent 和这些示例使用同一组路由。

```powershell
$base = 'http://127.0.0.1:4317/api/v1'
$token = (Get-Content -Raw -LiteralPath .\data\access.local.json | ConvertFrom-Json).ownerToken
if ($env:OWNER_TOKEN) { $token = $env:OWNER_TOKEN }
$headers = @{ Authorization = "Bearer $token" }
function Write-Maoqiu($path, $payload, $method = 'POST') {
    $json = ConvertTo-Json -InputObject $payload -Depth 15 -Compress
    Invoke-RestMethod -Uri "$base$path" -Method $method -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($json))
}
function Read-Maoqiu($path) {
    Invoke-RestMethod -Uri "$base$path" -Method Get -Headers $headers
}

$project = Write-Maoqiu '/projects' @{ name = '毕设观测'; binding = 'observations' }
$pidRef = $project.id
$submission = @{
    requestId = [guid]::NewGuid().ToString()
    projectId = $pidRef
    source = @{ title = '导师原话'; text = '先核对 R 波段'; author = '导师'; platform = '会议笔记' }
    records = @(@{ type = 'requirement'; body = '先核对 R 波段'; confirmation = 'user' })
}
$receipt = Write-Maoqiu '/submissions' $submission
$handoff = Write-Maoqiu "/projects/$pidRef/records" @{
    type = 'handoff'; body = '已核对 R 波段，下一轮处理 B 波段'
    sourceId = $receipt.sourceId; refs = @($receipt.records[0].id)
    extra = @{ version = 'r3'; verified = @('R 波段条目完整'); remaining = @('核对 B 波段'); nextSteps = @('取 B 波段原件') }
}
$brief = Read-Maoqiu "/projects/$pidRef/brief"
$brief.openItems
```

网络重试时原样重发同一个 `$submission`。同一个调用端和请求键返回原收据，改变内容重用此键将得到 HTTP 409。简报中的 `pendingVerification` 是尚待核验的验收条件，`claimedVerification` 是 Agent 或外部端提交的自述，`verified` 保留所有者确认或工作台检查的来源和依据。审阅后仍可在 `latestWork` 中查看同一轮的版本和成果引用。下一次交接可以在 `refs` 里引用上一次交接 ID，保留整条时间线，并让最新简报采用接手后的停点。

### 编辑首页并恢复布局

```powershell
$space = Read-Maoqiu "/spaces/$($project.spaceId)"
$page = $space.structure.pages[0]
$collection = $space.structure.collections[0]
$block = $page.blocks | Where-Object type -eq 'collection' | Select-Object -First 1
$change = @{
    expectedRevision = $space.revision; mode = 'preview'
    operations = @(
        @{ op = 'updatePage'; pageId = $page.id; title = '导师要求与处理进度'; columns = 2 },
        @{ op = 'addField'; collectionId = $collection.id; field = @{ id = 'band'; name = '波段'; type = 'select'; options = @('R','B') } },
        @{ op = 'updateBlock'; pageId = $page.id; blockId = $block.id; block = @{ config = @{ collectionId = $collection.id; view = 'table'; groupBy = 'band' } } },
        @{ op = 'addBlock'; pageId = $page.id; block = @{ type = 'source-card'; title = '观测原话'; config = @{ sourceId = $receipt.sourceId }; actions = @(@{ id = 'inspect-source'; type = 'openSource'; label = '查看出处' }) } }
    )
}
$preview = Write-Maoqiu "/spaces/$($space.id)/changes" $change
$change.mode = 'apply'
$applied = Write-Maoqiu "/spaces/$($space.id)/changes" $change
$entryPath = "/collections/$($collection.id)/entries"
$entry = Write-Maoqiu $entryPath @{ values = @{ title = '观测记录 01'; band = 'R' } }
$byBand = Read-Maoqiu "${entryPath}?blockId=$($block.id)"
$origin = Write-Maoqiu "/spaces/$($space.id)/actions/inspect-source" @{}
$restored = Write-Maoqiu "/spaces/$($space.id)/restore" @{ expectedRevision = $applied.revision; targetRevision = $space.revision }
(Read-Maoqiu $entryPath).items[0].values
```

预览和应用均检查 `expectedRevision`，过期时响应中的 `current` 给出当前版本。新集合、页面或块需要在同批后续操作中引用时，自行指定稳定 ID。应用后用响应中的 `pageId` 打开 `GET /spaces/:id/pages/:pageId`。已有值的字段改变类型或收敛单选选项导致受影响条目需要转换时，`updateField` **必须同时传** `migration: {entryId: newValue}` 与对应受影响条目的 `entryRevisions: {entryId: revision}`（缺少版本号校验会拒绝迁移，防止覆盖刚被编辑的条目）。

`POST /spaces/:id/restore` 默认使用 `scope: 'layout'`，保留当前集合字段与条目。`scope: 'structure'` 会采用历史字段定义。先传 `mode: 'preview'` 查看 `conflicts`，存在冲突时**必须同时提交** `migrations: {entryId: {fieldId: newValue}}` 与 `entryRevisions: {entryId: revision}` 并使用 `mode: 'apply'` 应用。未解决的冲突或过期版本号会返回 409。

所有有权限读取的项目或个人空间列表可通过 `GET /spaces` 读取（其中条目均经过项目读取权限过滤）。

### 访问范围、原件与修订

| 调用 | 约定 |
| --- | --- |
| `POST /grants`、`DELETE /grants/:id` | 所有者以 `{projectId,expiresInDays?,requestId?}` 发放项目邀请，默认 30 天，可设为 1 至 365 天。授权令牌仅在首次签发响应中返回；服务端在请求幂等表中将该结果脱敏记录为 `{_sensitiveResult:'grant-token'}`，以同一 `requestId` 重试会返回 **HTTP 409**，须更换新 `requestId` 重新签发。删除邀请后令牌失效。 |
| `POST /projects/:id/workspaces` | `{instanceId,workspaceRef,allowAgentAccess,agentPermission?}` 配置执行实例。运行权限可选 `read`（默认）、`append`、`manage`，只用于绑定项目，最长 24 小时。关闭授权、改权限、解除绑定或运行进入终态均会撤销现有运行令牌。解绑使用 `DELETE /projects/:id/workspaces` 并传入 `instanceId`。 |
| `POST /attachments` | 传 `{name,contentType,data,projectId?}`，其中 `data` 为 base64，原件最多 16 MiB。用 `GET /attachments/:id?download=1` 下载原件，`?meta=1` 读取元数据。省略参数继续返回兼容的 JSON 数据。 |
| `POST /submissions` | 个人投递省略项目。留在节点的原件可用 `source.localRef = {nodeId,workspaceRef,path}` 标记，服务仅保存定位描述。 |
| `PATCH /sources/:id`、`PATCH /attachments/:id` | 所有者用 `{projectIds:[...],endpointIds:[...]}` 替换完整授权范围。分享含附件的来源前先授权相关附件。 |
| `GET /search` | 支持 `q`、`projectId`、`sourceId`、`platform`、`from`、`to`、`kind` 和 `scope=personal`。可重复传 `ref` 优先显示明确引用。默认 50 条，`limit` 上限 100，将返回的 `nextCursor` 作为下一次请求的 `cursor`。 |
| `PATCH /records/:id` | 传 `{expectedRevision,body?,extra?,validFrom?,validUntil?,confirmation?,refs?}`。所有者还可在项目中设置 `shareDerived` 与 `independentKnowledge`。当前读取用 `GET`，查历史加 `?history=1`。 |
| `DELETE /records/:id` | JSON 中传 `expectedRevision`。遗忘从检索、简报和自动召回排除记录，并使相关主聊摘要失效。相同原件、类型与规范化陈述，或同一 `factKey` 的再提取会得到 409。原始来源可继续按原有访问范围查阅。 |
| `GET /spaces/personal`、`POST /spaces` | 读取个人空间，或以 `{projectId?,name,templateSpaceId?}` 新建空间。模板复制页面和字段，重新建立集合与项目绑定。 |
| `GET /modules`、`POST /spaces/:id/changes` | 查询已注册模块。通过 `{op:'toggleModule',type:'source-card',enabled:false}` 停用出处卡片渲染，原件仍可经稳定来源 ID 打开。 |
| `POST /spaces/:id/actions/:actionId` | `writeHandoff` 动作接收 `body`、`refs?`、`sourceId?`、`confirmation?`、`extra?` 和 `requestId?`。版本与未完成事项可填入 `extra.version` 和 `extra.remaining`。来源及上一条交接引用沿用项目权限。 |

原件授权、派生知识共享和遗忘分别操作。项目空间只引用本项目可见的记录和已授权原件。撤回来源授权后，通过直接引用或经其他记录依赖该来源的派生记录退出项目读取、历史、检索、简报、空间和 Bot 上下文。所有者仍可查看未遗忘的记录。需要保留某个版本的知识时，所有者提交 `{expectedRevision,independentKnowledge:true,shareDerived:true,confirmation:"user"}` 明确确认。再次修改正文时需重新确认该版本；项目成员仍需原件授权才能访问原件。设置 `shareDerived:false` 关闭该记录及依赖它的派生记录的项目共享。

收回附件只改变其访问权；引用该附件的受控通信交接也退出后续项目上下文。页面布局和条目中的其他可见值会保留。撤权、修订和遗忘不会追回已经发送到原生会话或模型服务的内容。暂存待发和断线重发会重新核对材料、版本和授权。发出的内容无法核对时状态为「送达待核对」。

### Bot 通信与原生会话

运行中可使用该运行的项目令牌调用 `POST /runs/:id/communication`。支持 `question`、`progress`、`blocked`、`request`、`handoff` 和 `delivery`，传入 `kind`、`text`、唯一 `requestId`，可加同一工作话题的 `replyTo`、当前项目的生成材料 `refs`。交接或协作请求可指定已绑定的 `recipientInstanceId`，由主聊协调；报告送入后不会自行唤起其他 Bot。交接或交付可附 `version`、`completed`、`remaining`、`paths`、`checks`、`risks`，返回归档记录 ID。宿主从运行绑定生成发送者，报告和路径属于执行方自述。

所有者通过 `GET /tasks/:id/communication` 查询任务关系。可向对应工作话题提交 `{text,replyTo}` 记录直接回应。针对待核对运行，向 `POST /runs/:id/recovery` 提交 `{action:"inspect"}` 请求原节点核对，或用 `{action:"abandon",acknowledge:true,reason}` 停止工作台等待。后者可能留下仍在原生端执行的任务。

本机所有者可以读取 `GET /instances/:id/sessions?projectId=<id>&cursor=<cursor>`。实例须宣告可核对的会话目录。用 `POST /instances/:id/sessions` 提交 `{sessionId,projectId?,title?}`，查询返回的话题等待原生绑定回执。会话已绑定时返回既有话题。工作台继续使用原生线程，历史保留在原客户端。

### 工作台监控与主聊控制端点（本机所有者）

除会话与任务端点外，本机所有者界面还使用以下 `/api/v1` 控制端点：

- `GET /agent-monitor?days=30`：汇总工作 Bot 运行状态、活跃/待核对/最近异常计数及指定天数内已记录的用量（`1..365` 天）。非所有者令牌访问返回 HTTP 403。
- `GET /chat/persona`、`POST /chat/persona`：读取或保存 `persona.md`（或传 `{ reset: true }` 恢复默认人格）。
- `GET /chat/policy`、`POST /chat/policy`：读取或保存主聊外部历史/项目/记忆/附件共享策略、工具预算软硬上限及读写授权目录。
- `POST /chat/cancel`：取消主聊中排队或正在运行的 `{ messageId }` 任务。

### 对话与事件

`GET /threads/:id?messageLimit=60` 返回最新一页和 `nextBefore`。用 `GET /threads/:id/messages?before=<nextBefore>&limit=60` 读取此前消息。保留无分页参数的旧快照接口。首次连接可先读取 `GET /events/latest`，载入所需快照，再用 `GET /events?after=<cursor>` 接收更新。断线可用最后接收的事件 ID 续读。纯文本主聊可产生临时 `chat_delta`，完成后的正式答复从话题消息读取。
