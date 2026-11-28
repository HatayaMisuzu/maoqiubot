# 小毛球 Bot 工作台 · 仓库工程规范

## 发行包与构建产物目录规范

1. **`dist/` 单一最新完整包原则**
   - `dist/` 目录下**只保留最新且最全的一份**成品桌面发行包：`dist/Xiaomaoqiu-win32-x64/`。
   - 该目录必须同时包含主程序（`Xiaomaoqiu.exe`）、运行时资源（`resources/app/`）与内置外接 Agent 管理组件（`resources/agent-manager/` 内的 `agent-manager.exe`、`LICENSE-CC-Switch.txt`、`THIRD_PARTY_NOTICES-agent-manager.txt`）。
   - **禁止**在 `dist/` 下保留历史版本目录、按日期命名的子目录（如 `stability-*`、`orca-upgrade`）或编译中间缓存。
2. **旧包留档目录：`backups/desktop-packages/`**
   - 每次通过 `npm run package:desktop` 向默认 `dist/` 生成新包时，脚本会先在 `build/` 临时暂存并校验新包完整性，随后**自动将 `dist/` 内原有的旧包/历史目录迁移留档至 `backups/desktop-packages/`**（按名称或 `<原名>-YYYYMMDD-HHmmss` 命名），保留回退能力，不直接删除。
   - 自定义输出目录应位于 `dist/` 之外，脚本只归档该输出目录里的同名旧包。输出、归档与暂存目录必须相互独立，并使用真实路径。替换前从托盘退出对应工作台并关闭 Agent 管理窗口。
3. **中间构建与预编译目录：`build/`**
   - 外接 Agent 管理组件构建产物位于 `build/agent-manager/`（`agent-manager.exe` 与其许可证/依赖声明）。
   - CC Switch 上游源码、pnpm 与 Rust `target` 编译缓存位于 `build/.agent-manager-work/`。
   - `build/`、`dist/`、`backups/` 均已在 `.gitignore` 中忽略，禁止提交入库。

## 日常修改与验证约定

- 修改代码前先确认工作区状态；未经用户明确要求，不执行 `git commit`、`git push` 或破坏性清理命令。
- 常用验证命令：
  - 类型检查：`npm.cmd run check`
  - 单元测试：`npm.cmd test`
  - 浏览器 E2E：`npm.cmd run test:e2e`
  - 桌面构建与打包：`npm.cmd run build:agent-manager`、`npm.cmd run package:desktop`
