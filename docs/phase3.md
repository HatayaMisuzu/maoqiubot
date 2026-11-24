# 小毛球第三阶段

## 升级

Windows 打包产物位于 `dist/Xiaomaoqiu-win32-x64`。退出使用同一数据目录的旧工作台后再打开新版本，SQLite 会在首次打开时迁移到 v6。迁移保留项目、线程、原生会话与资料。升级前可用 `npm run backup -- save <数据目录> <新备份目录> --without-access` 创建快照。恢复到新的数据目录，请勿混用 v5 和 v6 程序。恢复后的外部插件需要重新审查，未发出的确认和在途命令须重新核对。

## 接入模型

「主聊模型 → 添加模型」的示例字段如下。模型 ID 及能力须使用供应方实际支持的值。模型目录不可用时可手填。

| 协议 | Base URL 示例 | 对话路径默认值 | 密钥环境变量示例 |
| --- | --- | --- | --- |
| OpenAI Chat Completions | `https://gateway.example.com/v1` | `/chat/completions` | `MAOQIU_MODEL_KEY_GATEWAY` |
| OpenAI Responses | `https://api.openai.com/v1` | `/responses` | `MAOQIU_MODEL_KEY_OPENAI` |
| Anthropic Messages | `https://api.anthropic.com/v1` | `/messages` | `MAOQIU_MODEL_KEY_ANTHROPIC` |
| Gemini | `https://generativelanguage.googleapis.com/v1beta` | `/models/{model}` | `MAOQIU_MODEL_KEY_GEMINI` |

先测连接和文本，再按需测试工具、流式、图片与 JSON Schema，最后选为主聊。测试发送固定样本。图片测试验证协议接收及返回文本，图像识别准确率需用业务样本核对。每步接受一个原生工具调用。可开启结构化决策作为兼容路径。在途关闭资料共享或停用模型后，工作台停止后续传输。 [OpenAI 工具协议](https://platform.openai.com/docs/guides/function-calling) · [Anthropic 流式协议](https://docs.anthropic.com/en/docs/build-with-claude/streaming) · [Gemini REST](https://ai.google.dev/api/generate-content)

## 走通一次协调

1. 在毛球之家建项目，绑定两位执行 Bot 并按需开放项目资料。建立一条经所有者确认的项目约束，例如「交付文件放在 release-notes」。
2. 在该项目的主聊话题说「请让 Codex 写本次交付说明。允许根据项目事实答复问题，交付前核对文件路径」。核对并批准操作卡。在工作话题的「协调设置」可修改方式或暂停，转派只开放给明确选定的同项目实例。
3. 工作 Bot 可使用连接器提供的运行通信凭据报告问题和交付。项目已确认事实可以自动转达。需要选择方案、改变范围或批准原生操作时，在工作话题查看原请求，或使用主聊里的回复入口保留关联。无法在当前原生执行中插入的答复等待下一个可发送回合。
4. 核对交付通知中的版本、路径和检查，在任务通信查真实来源和回执，再按验收条件逐项检查。

## API

路径以 `/api/v1` 为前缀。插件、确认、主聊设置和协调授权由本机所有者管理。

| 请求 | 字段或返回 |
| --- | --- |
| `GET /threads/{id}` | `mainChat.pending` 含待确认的工具、参数、确认 ID 和到期时间 |
| `POST /chat/approve` | `messageId`、`approvalId`、布尔 `approved` |
| `GET/POST /chat/models` | 列表／保存、选择、启停或删除配置。连接、能力测试和发现使用 `/chat/models/test`、`/chat/models/capability`、`/chat/models/discover` |
| `GET/POST /chat/plugins` | 列表／`stage`、`stageManifest`、`review`、`validate`、`configure`、`test`、`activate`、`disable`、`export`、`rollback`、`uninstall` |
| `POST /tasks/{id}/coordination` | `coordination` 为 `off`、`notify`、`assist`、`handoff`，另可传 `handoffTargets`、`paused` |
| `POST /runs/{id}/communication` | 使用本运行令牌，提交 `kind`、`text`、稳定 `requestId`。可带 `replyTo`、`refs`、`recipientInstanceId`。交付可附 `version`、`paths`、`completed`、`remaining`、`checks` 和 `risks` |
| `GET/POST /chat/daily` | GET 查询带 `threadId`。POST 写入带 `threadId`、`action` 及所需字段，修改时附 `expectedRevision`。提醒时间用带时区的 ISO 时间 |
| `GET/POST /chat/memory-candidates` | GET 查询带 `threadId`。POST 用 `threadId`、`id` 和 `accept` 或 `reject`，接受前可修改内容和事实键 |

## A–K 落地与范围

| 项目 | 已实现及边界 |
| --- | --- |
| A 自定义模型与 API | 四种模型协议、模型发现及能力探测、授权共享、在途取消。可声明业务 API 的目标地址、方法、参数映射、认证引用与返回字段。 |
| B 插件与 Skill | 公共契约、注册表、来源和版本审查、启停、故障隔离、更新与回滚、标准 Skill 导入。代码草稿先静态验证，经所有者信任后可在隔离数据目录实际测试。外部可信代码与工作台共享进程权限。 |
| C 网页工具 | 独立 Web 插件，Brave 与 SearXNG、有限批次读取、正文与来源、实际资料归档。支持静态 HTML、纯文本和 JSON。 |
| D 自主协同 | 重要事件持久入队，非项目工作可只持通信令牌。限定当前任务、确认事实和指定转派对象，限制协调动作及层数。 |
| E 意图与授权 | 移除自然语言关键词门控。模型按意图和上下文提出操作，宿主依据真实主体、工具参数、权限和所有者确认执行。结果以实际工具回执为据。 |
| F Bot 与工作区管理 | 保留官方连接器，复用健康检查、配置、模型选择和工作区授权。Codex 可查目录、导入与续接。DSH 可续接已绑定会话，其 ACP 当前没有可核对的外部会话目录。 |
| G 记忆与人格 | 复用 Home 记录、版本、检索和遗忘。新增长期记忆候选核对和事实键归一化。候选由用户亲自接受。 |
| H 在途撤权 | 将配置、共享、资料范围和插件版本变化纳入在途检查，阻止模型用旧权限继续发起请求。 |
| I 日常与桌面工具 | 精确基础四则运算、事项和提醒、授权文本与目录操作、工作话题定位、归档。提醒由进程运行时触发，重新启动后补记。 |
| J 交付 | 重要报告、转达和交付可追溯到主体及运行。汇总展示 Bot 自报证据，用户仍可逐条验收。 |
| K 可靠性 | SQLite v6 迁移、备份与恢复测试，保留先前的断线、迟到回执、冻结文本和原生审批行为。备份覆盖插件清单、包和 Skill。外部插件的任意运行数据目录及模型密钥不随备份复制。 |

## 选型与验证

- 参考 Pi 1.6.0 的 `registerTool` 和标准 Skill，复用工具形态并提供可执行包装。实际导入其 `writing-p2-plugins` Skill。探测 `@earendil-works/pi-ai@1.6.0` 后选择直接实现四个协议，避免让 Pi 运行时接管宿主策略和现有会话。 [Pi 固定版本](https://github.com/earendil-works/pi/tree/faac585884ae2c013a6b1400f3e9e77f10b34bac)
- 参考 DSH `dsh-v0.2.3-alpha.2` 的 Cordis 服务和生命周期，探测 `cordis@4.0.0-rc.13` 的 Context 挂载，实际导入 DSH 的 `dsh-doc-writing` Skill。项目保留独立 ACP 进程，并用轻量注册表约束插件贡献。 [DSH 固定版本](https://github.com/deepseek-ai/deepseek-harness/tree/4b399c39a6d1479cd84ca591b4d7c88e24d38a96)
- 新依赖均由锁文件固定。Readability 0.6.0（Apache-2.0）与 linkedom 0.18.15（ISC）提取静态正文。Ajv 8.20.0（MIT）校验 Schema，ipaddr.js 2.5.0（MIT）分类地址，robots-parser 3.1.1（MIT）解释访问规则，yaml 2.9.1（ISC）解析 Skill 元数据，fflate 0.8.3（MIT）读写 ZIP。
- Windows 本机执行 `npm ci`、`npm run check`、`npm test`、`npm run package:desktop`，30 项测试通过。自动化覆盖四种协议的流式工具回环、在途取消、插件与回滚、业务 API、本机 SearXNG 协议 fixture、协调、记忆、事项和恢复。桌面包在隔离数据目录启动，打开模型、权限、插件和毛球之家界面，并激活网页工具。Edge 实测 1200 和 390 像素宽度下的模型、插件、确认卡、事项和项目流程。
- `node scripts/smoke-live.ts` 实际运行官方 Codex 主聊与工作 Bot，验证委派、同一原生会话两轮、旧任务查询、成果入库、主聊计算、读取授权文本和原生会话目录。DSH 0.2.2-rc.5 实际握手、读取模型、建立 ACP 会话并提交提示，推理请求返回 `Insufficient Balance`。
- Brave 未配置实际凭据。测试环境系统 DNS 将公开站点解析到 `198.18.0.0/15`，网页工具按策略拒绝该地址，独立直连尝试也未读取成功。真实公开网页、外部 HTTP 模型供应商、远程 GitHub CI 的执行结果仍待核对。本地协议 fixture 和真实 Codex 冒烟各自独立。
