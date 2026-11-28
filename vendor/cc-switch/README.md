# 外接 Agent 管理的上游源码

构建脚本从 CC Switch v4.0.43 发布提交 `754fed72d428c66c1e6ed45f38601ac25ded90c6`
取得源码并应用本目录的 `maoqiu.patch`。原生配置写入、应用清单、供应商表单、授权中心、
MCP、Skills、原生插件、提示词、会话读取及用量界面仍由上游实现。
开发机无需另外安装 CC Switch。

在 Windows x64 的 MSVC Developer Prompt 中安装 Node.js、pnpm 和 Rust 后运行
`node scripts/build-agent-manager.mjs`。脚本在 `build/.agent-manager-work` 中使用上游 Cargo 和 pnpm 锁文件
（切换版本前会先回退已有补丁），把 `agent-manager.exe`、`LICENSE-CC-Switch.txt` 与完整依赖许可清单
`THIRD_PARTY_NOTICES-agent-manager.txt` 一并输出到 `build/agent-manager`，供 `npm run package:desktop`
随最新桌面包校验并打包进 `dist/Xiaomaoqiu-win32-x64/resources/agent-manager/`。

小毛球从桌面设置打开管理窗口。后台把自己的数据写到 Electron 提供的目录。
打开某个已绑定工作 Bot 的配置时，进程收到该实例使用的原生配置目录。
已有配置与账户数据仍归各 Agent。小毛球关闭后，管理进程的父进程管道断开，它也随之退出。

补丁集中处理宿主生命周期、独立数据目录、原生配置路径对齐、现有配置卡预览与导入、
禁用本地代理接管、自动更新、独立托盘、云同步和会话删除。升级上游时核对这些改动以及
各 Agent 的原生文件协议，再更新固定提交和补丁。
