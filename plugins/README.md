# 插件与 Skill

插件目录根部放置 `plugin.json`。SDK v1 的类型见 [插件契约](../contracts/plugin.ts)。已有完整示例可导入 [Pi 纯计算工具包装](examples/pi-unit-conversion/)。

| 项目 | 行为 |
| --- | --- |
| 清单 | 填写 `id`、`name`、`version`、`hostApi: 1`、`description` 和 `capabilities`。可选字段含 `entry`、`skills`、`requires`、`configSchema` 和 `httpTools`。 |
| 代码入口 | ESM 导出 `activate(ctx)`，可选 `deactivate()`、`test(config,input,signal)`。Node 22 可直接加载可擦除语法的 TypeScript。扩展随包提供自己的文件，宿主导入时不会执行包管理器脚本。 |
| 工具 | `registerTool` 接受 JSON Schema、`risk` 和执行函数。调用名为 `plugin_id__tool_name`。用 `ctx.signal` 取消长任务。声明 `confirm` 的工具收到本机所有者显式批准后执行。 |
| 模型和事件 | `registerProvider` 可添加主聊文本模型。支持 `tool.finished`、`task.communication` 和 `task.delivery`，只发送事件 ID、范围标识和状态。单个扩展的监听错误会记录在扩展列表。 |
| Skill | 符合 Agent Skills 的目录可直接导入，`name` 应与目录名一致。Pi 包可用 `package.json` 的 `pi.skills` 声明路径。支持按项目启用，按 ID 读取正文以及 `references/`、`assets/` 的文本。 [Agent Skills 规范](https://agentskills.io/specification) |
| 版本 | 本机目录、ZIP 或带完整 SHA 的 GitHub 源码进入待审查状态。审查来源、差异和权限后再启用。更新失败沿用旧版本。回滚须审查目标版本。 |

Skill 只提供模型可读取的文档，声明式 API 工具按清单定义的参数访问固定服务，可执行 JavaScript 扩展则在工作台宿主进程中运行并继承其本机权限。版本摘要变化后，代码执行和网络能力需要重新分别确认。静态检查只检查格式与语法，不代表代码安全，插件系统也不隔离任意 Node.js 代码。

在「主聊工具权限」打开生成扩展开关，再说「请草拟一个叫 metric-convert 的插件。提供只读工具，输入整数米数，输出厘米。先生成草稿」。批准生成后，在「插件与 Skill」查看源文件和能力，运行「静态验证」，审查并启用，再在主聊说「用新插件把 9 米换成厘米」。修改后用同一插件 ID 和新版本重复流程。可从审查页导出 ZIP；非 `web` 插件可在「测试」表单填写 JSON 参数直接调用 `test(config, input, signal)`。

静态验证检查清单、Schema、JS/TS 语法和 Skill 元数据。功能验证可在隔离工作台启用后，实际调用工具并核对记录。所有者批准的代码与工作台进程共享本机权限。外部代码停用后，注册项会立即注销，进程级副作用需要重启清理。使用 `MAOQIU_SAFE_PLUGINS=1` 启动可暂停所有外部扩展。`MAOQIU_PLUGIN_KEY_*` 密钥环境变量仅在扩展与声明式业务 API 运行时读取，已从本机 Codex 主聊与连接器/工作 Bot 子进程环境中自动剥离。

## 声明式业务 API

在「添加声明式 API」填写清单。以下示例从环境变量读取认证，仅返回指定字段，分别映射白名单路径参数和查询参数。

```json
{
  "id": "inventory",
  "name": "库存查询",
  "version": "1.0.0",
  "hostApi": 1,
  "description": "按 SKU 查询自有库存 API",
  "capabilities": ["tools", "network.api"],
  "httpTools": [{
    "name": "lookup",
    "description": "读取指定 SKU 的库存",
    "endpoint": "https://inventory.example.com/v1",
    "method": "GET",
    "path": "/items/{sku}",
    "parameters": {
      "type": "object",
      "properties": {"sku": {"type": "string", "maxLength": 40}},
      "required": ["sku"],
      "additionalProperties": false
    },
    "keyEnv": "MAOQIU_PLUGIN_KEY_INVENTORY",
    "outputPath": ["stock"]
  }]
}
```

自建内网 API 可声明 `privateLan: true` 并填写实际私网地址。此选项只接受私网 DNS/IP，旧配置若指向公网服务会在请求时明确报错。迁移时关闭 `privateLan`，并为公网 API 使用 HTTPS。业务 API 无自动重定向。写方法需逐次确认。支持固定字段的 JSON 正文和 `Bearer` 认证。

## 上游接口边界

- Pi 扩展包装示例桥接 `registerTool` 、普通 JSON Schema、`execute` 和文本结果。带 Pi UI、事件、命令、会话、模型状态或依赖的扩展需要单独编写适配。 [Pi 扩展文档](https://github.com/earendil-works/pi/blob/faac585884ae2c013a6b1400f3e9e77f10b34bac/packages/coding-agent/docs/extensions.md)
- DSH 标准 Skill 可导入。运行时继续使用官方 ACP 连接器。Cordis 服务、profile、patch 与插件使用 DSH 自己的宿主。 [DSH 架构](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/docs/architecture.md)
