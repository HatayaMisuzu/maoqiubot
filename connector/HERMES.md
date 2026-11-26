# 接入 Hermes Agent

1. 安装 Nous Research Hermes Agent。在终端运行 `hermes --version` 和 `hermes acp --check` 检查运行时，再在 Hermes 中完成模型供应方配置。账号和模型沿用 Hermes profile。[官方安装说明](https://hermes-agent.nousresearch.com/docs/getting-started/installation)
2. 在工作台打开「Agent 设置 → 新增执行实例」，选择 **Hermes**，填入实例 ID、显示名称、工作区目录和执行入口。可填 PATH 中的 `hermes`，Windows 也可填官方 `hermes.exe` 或 `hermes.cmd` 的完整路径。保存后点「测试连接」。
3. 在 Hermes 工作话题发送消息，或在项目中绑定实例后提交委派。若 Hermes 要求确认模型切换或工具操作，工作台会显示原生授权选项。

连接测试检查 ACP 握手。第一轮回复还需要 Hermes 的模型配置和调用额度。实例的 Profile 绑定标识用于工作台隔离会话。Hermes 的实际配置目录由 `HERMES_HOME` 决定。Windows 原生安装默认使用 `%LOCALAPPDATA%\hermes`，Linux 和 macOS 默认使用 `~/.hermes`。

使用自定义连接器 JSON 时，将下列实例加入 `instances` 并替换工作区路径。需要使用不同的 Hermes profile 时，在各实例的 `env.HERMES_HOME` 指定对应的配置目录，并使用不同的实例 ID 和 Profile 绑定标识。

```json
{
  "id": "hermes-local",
  "name": "Hermes",
  "adapterKey": "hermes",
  "profileId": "default",
  "workspaceRef": "E:/projects/my-workspace",
  "command": "hermes",
  "args": ["acp"]
}
```

「原生目录」只显示 Hermes 返回并属于当前工作区的会话。连接器重启后从该目录核对原生 ID 再续接。Hermes 会从目录隐藏没有消息的会话，因此仅预读了模型的空话题在重启后需要新建。若开启 Git Worktree，可以把它注册为新的 Hermes 执行实例。[Hermes ACP 官方协议说明](https://hermes-agent.nousresearch.com/docs/user-guide/features/acp)

## 连接排查

系统中有同名命令时，以能通过 `hermes --version` 和 `hermes acp --check` 的官方入口为准。如果启动报 `ModuleNotFoundError: No module named 'hermes_cli'`，需要先修复 Hermes 安装，或在实例配置中填写有效的官方启动器完整路径。

「在线 · 已握手」表示协议初始化成功。首次创建会话还会启动 Hermes 网关、读取模型目录并检查模型配置；Hermes 适配器为会话初始化保留 120 秒等待时间。若报 `session/new 等待原生响应超时`，检查 Hermes 自身日志、模型目录网络访问和运行环境。连接测试通过不代表模型推理已经通过。
