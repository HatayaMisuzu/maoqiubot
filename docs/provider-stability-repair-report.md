# Codex 供应商切换与桌面发行验收

2026-11-28 · `main` · Windows x64 · Node.js 22.22.3 · npm 12.0.2 · Electron 45.4.1 · Playwright Chromium，设置专项另用 Edge 复验

起始提交为 `e6e538582ee968b43e9639babf0063d4d1460818`，开工时与远端 `main` 一致，工作区干净。修复与发行源码提交为 `fd9e94d0095949e104051716ad926f5f55e8cde0`。修复提交相对基线涉及 39 个文件，增加 2,184 行、删除 535 行。本报告另行提交，桌面发行包以修复提交为基准。

## R01–R07

| 项目 | 状态 | 修复与实测 |
| --- | --- | --- |
| R01 重复应用 | FIXED/PASS | `desktop/connector-settings.cjs` 和 `desktop/main.cjs` 在停机前核对有效模式和身份。同配置直接返回，外部账号或供应商变化走实际身份探测。SQLite 回归覆盖无话题、活跃话题、已归档话题和清除缓存后仍绑定的话题，检查配置字节、状态和范围。Windows EXE 验证同模式按钮禁用与 IPC 无操作。 |
| R02 生命周期 | FIXED/PASS | `connector-maintenance.cjs`、`main.cjs` 和 `server/api/nodes.ts` 在停机前暂停本机派发，停机后重新检查队列。连接器在原生操作仍活跃时拒绝退出，确认停止后才启动新进程。回归覆盖迟到 prepare、旧进程未退出、启动失败、写入失败及确认期间变化。预览包复现 Electron 空闲退出超时，修复后在真实 EXE 中完成两次模式切换和重连。 |
| R03 文件与数据库恢复 | FIXED/PASS | `codex-switch-recovery.cjs` 使用同权限的原配置硬链接与 SQLite 提交标记核对切换进度。测试覆盖事务开始、更新和提交错误，在真实隔离子进程中分别于配置替换后、提交前及提交后退出。两次运行恢复均得到一致的配置、绑定和话题状态。恢复记录损坏或配置事后被手工修改时保留现场并隔离本机连接器。 |
| R04 原生话题范围 | FIXED/PASS（隔离集成） | 基线实际使用实例当前范围解释目录和解绑，并漏算清除缓存后的未解绑话题。主库 v11 增加 `threads.nativeRuntimeScopeId`，`server/tasks/index.ts`、`server/api/nodes.ts` 与 `connector/store.ts` 按绑定来源处理派发、目录、历史、导入、分支和解除。SQLite + WebSocket 测试以 A/B 两个范围使用同名会话 ID，覆盖项目隔离、重登、迟到或范围不符的回执、A→B→A 和原范围解除。 |
| R05 重连状态 | FIXED/PASS | `web-demo/connector-connection.js` 以本次连接器代次、服务端登记、目标实例在线及已核对运行范围显示结果。Playwright 覆盖慢连接、超时、旧心跳、旧代次、离线、登记失败、提前退出、取消和关闭页面。 |
| R06 Hermes 发现 | FIXED/PASS | `desktop/hermes-discovery.cjs` 列出候选，用户可以单独发起 ACP 握手并手动添加。测试覆盖首次、后装、重复扫描、多个候选、路径带空格、无启动器、坏启动器和自定义 JSON。隔离 Windows 配置使用官方 Hermes v0.23.4 实际完成 ACP 初始化。日用迁移目录中的启动器仍失败。 |
| R07 桌面发行 | FIXED/PASS | `scripts/package-desktop.mjs` 校验资源和真实路径，暂存通过后归档旧包。8 个发行测试覆盖同名、路径重叠/联接、资源缺失、归档及发布失败、旧 EXE 占用、跨盘错误及完整副本。另实际验证过 E: 到 C: 的跨盘归档，正式包已在 Windows 实际启动。 |

v11 仅在旧连接器能提供匹配实例、工作区、会话 ID 和原运行身份的持久映射时补录旧 Codex 绑定。缺少证据的绑定维持待核对，保留工作台消息，并保留相关会话 ID 的占用约束。清除缓存但尚未解除的绑定计入切换影响，原始状态保留。切回原范围后仍须核对原生映射和能力，已失效话题通过替代话题继续。隔离测试验证了在原身份下安全解除原绑定，真实双账号切换与原会话续接受凭据限制。

## 自动验证

| 命令 | 原始基线 | 修复后 |
| --- | --- | --- |
| `npm.cmd run check` | 退出 0 | 退出 0 |
| `npm.cmd test` | 退出 0，76 通过 | 退出 0，92 通过，0 失败，0 跳过 |
| `npm.cmd run test:e2e` | 退出 0，18 通过 | 退出 0，26 通过，0 失败，0 跳过 |
| `git diff --check` 及暂存区检查 | 干净 | 退出 0 |

基线与修复日志位于 `%TEMP%/maoqiu-20261128-baseline-*.log` 和 `%TEMP%/maoqiu-20261128-final-source-*.log`。相关回归见 `test/provider-switch-recovery.test.mjs`、`test/audit-regressions.test.mjs`、`test/connector-recovery.test.mjs`、`test/upgrade.test.mjs`、`test/hermes.test.mjs`、`test/package-desktop.test.mjs` 及 `e2e/desktop-flows.spec.mjs`。候选全量运行曾有两处失败，分别为旧迁移测试夹具残留 v11 字段和 DSH 旧回执缺少范围信息，两处修复后复跑通过。独立服务端启动实测也确认，存在中断记录时，本机连接器登记会被拒绝，恢复文件仍保留。

全量用例覆盖主聊和侧聊、审批、附件和项目隔离、工作 Bot 委派与直聊、准备队列与取消、回执恢复、毛球之家授权与交接、API Bot、插件以及数据库备份与升级。协作和推理测试使用隔离夹具。

## 原生运行验证

| Agent | 本机验证 | 阻塞项 |
| --- | --- | --- |
| Codex CLI 0.171.0-alpha.13.2 | 隔离 profile 中 `official` 与 `native` 均完成真实 App Server 初始化 | 未提供获准的隔离 ChatGPT 登录或第二供应商，真实账号登记、切换、推理及续接阻塞 |
| DSH | 隔离官方 `dsh --profile acp` 成功握手并返回当前模型和 1 个模型选项 | 未用真实凭据或额度进行推理和续接 |
| Hermes v0.23.4 | 官方运行时在隔离 AppData、Hermes 配置和工作区完成 ACP 初始化 | 迁移目录中的日用启动器仍握手失败，云推理未验证 |

## Windows 发行

`npm.cmd run package:desktop` 退出 0。沿用 `build/agent-manager/` 内的 Windows x64 组件，发行脚本验证了组件与第三方许可文件。正式包入口为 `E:/xiaomaoqiu/dist/Xiaomaoqiu-win32-x64/Xiaomaoqiu.exe`，`dist/` 中只有此完整包。原包归档于 `E:/xiaomaoqiu/backups/desktop-packages/Xiaomaoqiu-win32-x64-20261128-204023/`。另核对了 100 个应用运行文件和锁文件列出的 37 个生产依赖。打包和清单检查日志位于 `build/r07-final-package.log`、`build/r07-final-inventory.log`。

正式 EXE 在隔离数据、profile 和工作区中启动。用合成 Codex stdio 验证原模式无操作、供应商模式切换、新代次握手、故意登录失败时显示已保存但连接失败，以及显式重连。验证了关闭窗口后驻留托盘、同一 profile 再次启动时恢复窗口和正常退出。托盘菜单点击未单独验证。日志位于 `build/r07-final-exe.log`，退出码 0。

## 升级与回退

首次运行 v11 前建议先停机备份数据库、附件和连接器本地库。需要回退时，退出工作台和外接管理窗口，将归档的完整旧包复制到独立目录，并使用升级前备份。旧版不支持已升级至 v11 的数据库。若切换记录无法自动核对，保留 `desktop-connector.json`、`desktop-connector.json.codex-switch.json` 和同目录的切换 `.old` 文件，核对手工改动后从同一数据目录重新启动桌面工作台。
