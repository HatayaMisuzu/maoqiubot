# 文档与架构索引

本目录汇集小毛球 Bot 工作台的核心设计说明、接口契约与阶段验收快照。

## 现行说明与契约

| 文档 | 内容说明 |
| --- | --- |
| [项目总览与启动指南](../README.md) | 本地启动、Windows 桌面打包、主聊与工作区功能、脚本与环境变量 |
| [会话、原生连接器与 Bot 设置](sessions.md) | 主/侧聊与工作话题、Codex/DSH/Hermes/API 工作 Bot 能力矩阵、SQLite 数据与 HTTP 协议 |
| [第三阶段能力与接口指南](phase3.md) | 外部模型协议、协调模式、记忆候选、事项提醒、插件与审批接口 |
| [毛球之家公共 API](../server/home/API.md) | 项目/个人资料投递、检索分页、空间编辑/恢复、项目授权与 Bot 通信接口 |
| [DSH 官方 ACP 接入](../connector/DSH.md) | DSH `dsh --profile acp` 配置、`MAOQIU_DSH_EXECUTABLE`、OpenCode Go / Console 说明与排错 |
| [Hermes Agent 接入](../connector/HERMES.md) | `hermes acp` 配置、`HERMES_HOME` 与连接超时排查 |
| [插件与 Skill SDK](../plugins/README.md) | 清单格式、`registerTool` / `registerProvider`、声明式业务 API 与权限审计 |
| [网页插件说明](../plugins/web/README.md) | Brave / SearXNG 搜索配置、公开网页读取与代理设置 |
| [外接 Agent 管理组件](../vendor/cc-switch/README.md) | CC Switch v4.0.43 上游固定版本、补丁范围与 Windows 构建方式 |
| [第三方许可证声明](../THIRD_PARTY_NOTICES.md) | 运行时依赖、Electron、Orca 复用代码与 CC Switch 管理组件许可信息 |

## 历史验收快照

以下文档记录对应里程碑完成时的基线、实测环境与验收记录，仅作历史溯源，不再随后续改动重写：

- [Hermes Agent 接入与验收](hermes-integration-report.md)
- [Orca 复用与小毛球升级验收](orca-reuse-report.md)
- [会话升级验收报告](session-upgrade-report.md)
- [工作台稳定性修复与验收](stability-repair-report.md)
- [Codex 供应商切换与桌面发行验收](provider-stability-repair-report.md)

## 运行架构（四进程协同）

```text
+-----------------------------------+      HTTP / SSE / /login (本机 127.0.0.1)
|  desktop/main.cjs (Electron 45)   | -------------------------------------------+
|  系统托盘 · Worktree · IPC 桥接    |                                            v
+-----------------+-----------------+                           +-------------------------------+
                  | 可选管理窗口 (stdio / 独立数据目录)          |  server/index.ts (Node 22)    |
                  v                                             |  HTTP/SSE · web-demo 静态 UI   |
+-----------------------------------+                           |  SQLite workbench.sqlite v11  |
|  agent-manager.exe (CC Switch)    |                           +---------------+---------------+
+-----------------------------------+                                           ^
                                                                                | WebSocket (/api/v1/node)
                                                                +---------------+---------------+
                                                                |  connector/index.ts (Node)    |
                                                                |  本地排队 SQLite node-local v2 |
                                                                |  驱动 Codex / DSH / Hermes     |
                                                                +-------------------------------+
```

- **桌面宿主 (`desktop/`)**：Electron 主进程托管内嵌服务端与本机连接器；打包分发时附带 `agent-manager.exe` 供「Agent 设置 → 外接 Agent 管理」调用。`dist/` 目录仅保留最新完整包 `dist/Xiaomaoqiu-win32-x64/`，旧发行包归档至 `backups/desktop-packages/`，预编译与编译缓存位于 `build/`。直接通过浏览器访问 `npm.cmd run local` / `npm.cmd start` 时，无 Electron IPC，UI 自动降级为「Bot 监控」对话视图。
- **数据与状态**：主库为 `<data>/workbench.sqlite`（当前 `PRAGMA user_version = 11`），连接器状态与本地命令映射保存在 `<data>/node-local`（当前 `PRAGMA user_version = 2`），桌面连接器配置保存在 `<data>/desktop-connector.json`（也可以通过 `MAOQIU_CONNECTOR_CONFIG` 指定自定义文件）。

## 常用环境变量速查

| 变量名 | 用途 |
| --- | --- |
| `MAOQIU_DATA` | 指定工作台 SQLite、附件、模型及插件配置的数据目录（默认 `data/`，打包独立运行时用应用用户目录） |
| `MAOQIU_CONNECTOR_CONFIG` | 指定连接器 JSON 文件路径（覆盖默认的 `<data>/desktop-connector.json` 或示例配置） |
| `MAOQIU_DESKTOP_PROFILE` | 指定 Electron `userData` 目录，用于多实例或隔离测试 |
| `MAOQIU_DSH_EXECUTABLE` | 指定 DSH 官方可执行文件绝对路径（如 `dsh.cmd`） |
| `MAOQIU_CHAT_CODEX` | 覆盖内置 Codex 主聊可执行程序路径（默认 `codex`） |
| `MAOQIU_SAFE_PLUGINS` | 设为 `1` 时暂停加载全部外部扩展代码 |
| `MAOQIU_PACKAGE_OUT` | 覆盖 `npm run package:desktop` 输出目录（默认 `dist/`） |
| `MAOQIU_PACKAGE_ARCHIVE` | 覆盖 `npm run package:desktop` 归档旧包的目录（默认 `backups/desktop-packages/`） |
| `MAOQIU_MODEL_KEY_*` | 在启动环境中为自定义主聊模型提供密钥（不会随连接器传入子 Agent 环境） |
| `MAOQIU_PLUGIN_KEY_*` | 为插件 / 声明式业务 API 提供密钥（从 Codex 主聊与连接器子进程环境中剥离） |
| `OWNER_TOKEN` / `NODE_TOKEN` | 本机脚本调用 HTTP API 或连接器鉴权令牌（默认由 `<data>/access.local.json` 读取） |
