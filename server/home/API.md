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

预览和应用均检查 `expectedRevision`，过期时响应中的 `current` 给出当前版本。新集合、页面或块需要在同批后续操作中引用时，自行指定稳定 ID。应用后用响应中的 `pageId` 打开 `GET /spaces/:id/pages/:pageId`。已有值的字段改变类型时，`updateField` 须带 `migration: {entryId: newValue}`。可同时传 `entryRevisions: {entryId: revision}`，防止转换覆盖刚被编辑的条目。

`POST /spaces/:id/restore` 默认使用 `scope: 'layout'`，保留当前集合字段与条目。`scope: 'structure'` 会采用历史字段定义。先传 `mode: 'preview'` 查看 `conflicts`，再通过 `migrations: {entryId: {fieldId: newValue}}` 提交需要转换的值，并使用 `mode: 'apply'` 应用。未解决的冲突返回 409。

### 访问范围、原件与修订

| 调用 | 约定 |
| --- | --- |
| `POST /grants`、`DELETE /grants/:id` | 所有者以 `{projectId,expiresInDays?}` 发放项目邀请，默认 30 天，可设为 1 至 365 天。受邀端使用 Bearer 令牌读写指定项目。删除邀请后令牌失效。 |
| `POST /projects/:id/workspaces` | `{instanceId,workspaceRef,allowAgentAccess,agentPermission?}` 配置执行实例。运行权限可选 `read`（默认）、`append`、`manage`，只用于绑定项目，最长 24 小时。关闭授权、改权限、解除绑定或运行进入终态均会撤销现有运行令牌。解绑使用 `DELETE /projects/:id/workspaces` 并传入 `instanceId`。 |
| `POST /attachments` | 传 `{name,contentType,data,projectId?}`，其中 `data` 为 base64，原件最多 16 MiB。用 `GET /attachments/:id?download=1` 下载原件，`?meta=1` 读取元数据。省略参数继续返回兼容的 JSON 数据。 |
| `POST /submissions` | 个人投递省略项目。留在节点的原件可用 `source.localRef = {nodeId,workspaceRef,path}` 标记，服务仅保存定位描述。 |
| `PATCH /sources/:id`、`PATCH /attachments/:id` | 所有者用 `{projectIds:[...],endpointIds:[...]}` 替换完整授权范围。分享含附件的来源前先授权相关附件。 |
| `GET /search` | 支持 `q`、`projectId`、`sourceId`、`platform`、`from`、`to`、`kind` 和 `scope=personal`。可重复传 `ref` 优先显示明确引用。默认 50 条，`limit` 上限 100，将返回的 `nextCursor` 作为下一次请求的 `cursor`。 |
| `PATCH /records/:id` | 传 `{expectedRevision,body?,extra?,validFrom?,validUntil?,confirmation?,refs?}`。当前读取用 `GET`；显式查历史加 `?history=1`。 |
| `DELETE /records/:id` | JSON 中传 `expectedRevision`。遗忘移除这条提炼的检索入口和简报引用。相同原件、类型与规范化陈述，或同一 `factKey` 的再提取会得到 409。原始来源可继续按原有访问范围查阅。 |
| `GET /spaces/personal`、`POST /spaces` | 读取个人空间，或以 `{projectId?,name,templateSpaceId?}` 新建空间。模板复制页面和字段，重新建立集合与项目绑定。 |
| `GET /modules`、`POST /spaces/:id/changes` | 查询已注册模块。通过 `{op:'toggleModule',type:'source-card',enabled:false}` 停用出处卡片渲染，原件仍可经稳定来源 ID 打开。 |
| `POST /spaces/:id/actions/:actionId` | `writeHandoff` 动作接收 `body`、`refs?`、`sourceId?`、`confirmation?`、`extra?` 和 `requestId?`。版本与未完成事项可填入 `extra.version` 和 `extra.remaining`。来源及上一条交接引用沿用项目权限。 |

项目空间可引用授权给本项目的来源和附件，以及本项目的记录。撤回授权或遗忘记录后，页面与集合停止显示相应引用，原有布局修订和条目的其他值仍可读取。

### 对话与事件

`GET /threads/:id?messageLimit=60` 返回最新一页和 `nextBefore`。用 `GET /threads/:id/messages?before=<nextBefore>&limit=60` 读取此前消息。保留无分页参数的旧快照接口。首次连接可先读取 `GET /events/latest`，载入所需快照，再用 `GET /events?after=<cursor>` 接收更新。断线可用最后接收的事件 ID 续读。
