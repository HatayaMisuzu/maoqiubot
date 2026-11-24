# DSH 官方 ACP 会话

小毛球通过 DeepSeek Harness 官方 `dsh --profile acp` 连接。每个工作话题绑定一个原生会话，绑定时记录执行实例、工作目录及 DSH profile。选择「跟随原生会话」时，小毛球不发送模型覆盖。手动选模型时，DSH 确认该会话的切换后才接收提示。模型名称后的供应方来自 DSH 返回的选项，可以区分同名模型的不同路由。 [ACP 会话配置](https://agentclientprotocol.com/protocol/v1/session-config-options)

DSH 的 `desktop`、`web` 和 `acp` 分别加载各自的 profile。桌面里选择的模型不会为其他 profile 的新会话设定默认值。给工作台使用的 ACP 实例换 DSH home 或启动参数时，请登记新实例 ID，再把它绑定到目标项目和工作区。现有会话继续用原来的实例。 [DSH CLI 文档](https://github.com/deepseek-ai/deepseek-harness/tree/master/apps/cli/reference)

桌面工作台的默认实例 `dsh-local` 使用已安装的官方启动器和 `--profile acp`。在小毛球中选中 DSH 后，可以先点「读取会话模型」，再用下拉菜单指定下一轮模型或沿用原生会话当前值。原生进程退出后，连接器会重启实例并保留会话绑定。当前 ACP 可以恢复会话，但没有按原生轮次查询丢失回执的入口，无法确认的轮次会停在「送达待核对」。 [ACP 会话恢复](https://agentclientprotocol.com/protocol/v1/session-setup) · [ACP 轮次与取消](https://agentclientprotocol.com/protocol/v1/prompt-turn)

```powershell
node connector/native-smoke.ts connector/config.example.json dsh-local --inspect-models
```

启动器路径因安装位置而异。可使用 PATH 或设置 `MAOQIU_DSH_EXECUTABLE` 指向官方启动器。也可在「Agent 设置」保存实际路径后点「测试连接」。更换已绑定实例的执行入口、工作目录或 profile 时，登记新的实例 ID。连接测试确认节点登记和握手。读取模型目录成功后，仍需实际发送一条消息才能验证供应方登录及额度。当前适配器没有可核对的外部 DSH 会话目录，已绑定会话可按 ACP 能力续接。

开启项目资料授权后，工作台在原生任务说明中给出本次运行可用的 `project-api.ts` 调用方式。可使用它向小毛球提交问题、进展、交接与交付。交接发送给指定后续 Bot 前由小毛球核对项目与用户授权，执行方自报检查需由所有者验收。 [项目通信 API](../server/home/API.md)

以下独立配置仅供另有 OpenCode 授权的实例选用。默认桌面启动配置使用上面的官方 ACP 入口。

## 使用 OpenCode Go API key

已在官方 DSH `0.2.2-rc.5` 验证。OpenCode Go 要求 API key 所属工作区具有对应的订阅。DSH 的内置 `opencode-go` 路由会发送每个原生会话对应的会话标识。 [OpenCode 的 API key 和会话要求](https://opencode.ai/docs/console/harnesses/) · [DSH 原生路由测试](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm-pi-ai/tests/adapter.spec.ts)

1. 为 OpenCode Go 实例选择单独的 `DSH_HOME`。在其 `.credentials.yaml` 中配置该工作区的 OpenCode Go API key。凭据只保存在 DSH home 下。 [DSH 凭据格式](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/credentials/credentials-local)

   ```yaml
   version: 1
   refs:
     OPENCODE_GO_API_KEY: "在此填入授权的 OpenCode Go API key"
   ```

2. 复制 `connector/config.example.json` 为 `connector/config.local.json`，在 `instances` 中追加实例。使用真实工作目录和 DSH 启动器路径。

   ```json
   {
     "id": "dsh-go-local",
     "name": "DSH OpenCode Go",
     "adapterKey": "dsh",
     "profileId": "acp-opencode-go",
     "workspaceRef": "E:/xiaomaoqiu",
     "command": "D:/DeepSeekHarness/resources/runtime/cli/bin/dsh.cmd",
     "args": ["--profile", "acp", "--patch", "E:/xiaomaoqiu/connector/dsh-opencode-go.patch.yml"],
     "env": {"DSH_HOME": "C:/Users/Lenovo/.dsh-maoqiu-go"}
   }
   ```

3. 运行 `npm.cmd run local -- connector/config.local.json`。在对应工作话题里点「读取会话模型」，选择 `DeepSeek V4.1 Flash · opencode-go`。首次发送时 DSH 会确认切换。后续可选「跟随原生会话」，同一原生会话会继续使用 DSH 已保存的模型。 [OpenCode Go 模型目录](https://opencode.ai/docs/console/go/)

此 overlay 使用 DSH 内置的 OpenCode Go API 端点及模型目录。它设置 `llm-pi-ai` 的供应方配置，适用于上面的专用实例。目录成功加载只能说明 DSH 已识别供应方和模型，实际推理还需要 OpenCode 接受该工作区的凭据及额度。 [DSH 供应方配置](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/llm/llm-pi-ai)

## 使用 OpenCode Console 官方插件

如果按 OpenCode Console 工作区管理模型和策略，可以为专用 `DSH_HOME` 运行官方 `npx @opencode/console setup deepseek-harness`，在浏览器核对授权码并选择工作区。授权后用该 `DSH_HOME` 启动 `dsh --profile acp`，无需上一节的 `--patch`。插件会应用工作区的模型及工具策略，新会话默认值由该 profile 决定。部署前核对官方页面列出的 DSH 兼容版本。 [OpenCode Console 安装说明](https://opencode.ai/console/integrations/deepseek-harness)

## 检查原生状态

```powershell
node connector/native-smoke.ts connector/config.local.json dsh-go-local --inspect-models
node connector/native-smoke.ts connector/config.local.json dsh-go-local --inspect-models --select-model-index=1 --new-session --inspect-models
node connector/native-smoke.ts connector/config.local.json dsh-go-local '--resume-session=上一步的原生会话ID' --inspect-models
```

选择序号从 0 开始，先核对本次实际模型列表。两次「读取」和单独的切换命令不会向模型发送提示。`--new-session` 让下一条操作创建独立会话。`--resume-session` 验证重新启动后同一个原生会话的当前值。
