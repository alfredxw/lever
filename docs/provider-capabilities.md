# 运行时基础能力与差异

Lever 有五种驱动、六类用户可选连接：DeepSeek Harness 与自定义 ACP 共用 ACP 驱动。下表区分「同一轮追加」「暂停后继续同一轮」和「在同一会话发起下一轮」；三者不可互相替代。

| 连接 | 运行中追加（Steer） | 暂停 / 继续同一轮 | 下一轮上下文 | 文件 / 附加工作目录 | Skills |
| --- | --- | --- | --- | --- | --- |
| Codex | 原生 `turn/steer` | 支持普通回复 | 原生会话 | 文件路径、原生多目录 | 引用、加载、按名称禁用 |
| Claude Code | 原生 `priority: next`，在工具安全点追加，以消息 UUID 回显确认；不中断在途工具 | 支持普通回复 | 原生会话 | 文件路径、原生多目录 | 引用、加载、按名称禁用 |
| Pi | 原生 RPC `steer`，等待本轮消费或扩展处理确认 | 未提供同轮恢复 | 原生会话文件 | 文件路径、附加目录路径提示 | 引用、原生加载、按名称禁用 |
| Antigravity | 本机 `agy acp` 1.5.0+ 支持；后台命令、子代理或其后续回复尚未结束时仍可追加 | 未提供同轮恢复 | 按 ACP 握手 | 文件或原生音频，按握手传入；目录同 ACP | 支持项目及用户 `skills.json`、继承和过滤；显式引用优先使用已确认的原生命令 |
| DeepSeek Harness | 实测 `deepseek-harness-acp` 0.0.1 未声明 Steer，仅 Queue | 未提供同轮恢复 | 按 ACP 握手 | 按 ACP 握手 | 显式引用 |
| 自定义 ACP | 已声明并具备可靠回执的适配器支持；其余仅 Queue | ACP v1 无通用同轮恢复 | 按 ACP 握手 | 按 ACP 握手 | 显式引用 |

所有连接均支持 Queue、停止、Chat / Topic 历史和流式执行记录。**Steer 是给指定的当前轮次补充输入；Queue 是等它结束再开下一轮。** 支持 Steer 的连接启动时，可以先选「当前执行就绪后追加」。消息绑定该轮，原生就绪后才投递；主动 Queue 的消息不会自动变成 Steer。若目标轮在点击前已结束，保留草稿并提示重新选择；已接受但尚未领取或明确拒绝的追加回到普通队列，送达不明则不重发。等待审批、切换连接或权限、引用需要独立授权的 Lever 资源时只能 Queue。模型、推理和 Fast 的更改留给下一轮。

| 无法统一的能力 | 实际边界 |
| --- | --- |
| ACP Steer | 标准 `session/prompt` 不是通用的并发追加接口。独立托管的 AGY 不继承本机 CLI 能力。对 `_session/steering`，要求握手同时声明支持 Steer 和 `promptRequired` 空闲回退；只声明 Steer 的连接仅在已确认实现相同契约的 `codex-acp` 2.4.0+、`claude-agent-acp` 0.65.0+ 启用。不会拿取消后重发冒充 Steer。 |
| Claude 的长工具 | 输入可在执行期间发出，但要等原生安全点消费。Lever 不为加快响应强制取消工具，或把仍归本轮进程所有的前台子代理强行移到后台。 |
| ACP 会话恢复 | 支持 `session/resume` 或 `session/load` 时续接原生会话；两者皆无时创建新会话并显式交接 Lever 历史。已有绑定无法恢复时报错，不静默换会话。 |
| 本机 Antigravity 的 401 | 普通请求因 `UNAUTHENTICATED` 结束，且原生记录能确认本次输入、错误位置和工具状态时，Lever 用新的 `agy` 进程在原会话发一次接续消息，保留同一条 Lever 回复，不重发原请求或附件。这不是 ACP 的同轮恢复接口。若仍需 Google 登录，运行 `agy acp --login` 后在原会话发「继续」。 |
| 附件与多目录 | ACP 声明 `promptCapabilities.audio` 时发送支持格式的原生音频块；否则只发文件引用，不声称模型已听取。本机实测 `agy acp` 1.5.12 声明 `audio: false`，即使支持嵌入一般文件也不会绕过此限制。多目录不受支持时只提供路径，不授予目录访问权。Pi 图像输入取决于所选模型。 |
| 技能策略 | ACP 没有统一的技能目录注入及逐项禁用契约。AGY 的项目清单可发现工作区内的包，不能借 `inherits`、绝对路径或符号链接授权读取其他目录。独立配置的用户清单可以显式指定外部包。 |
| 权限、推理与 Fast | Pi 提供询问、自动接受内置编辑、完全访问三种工具策略，下一轮生效；这不是操作系统沙箱或 AI 审核。监督模式加载失败不会发送提示。Pi 只在模型声明 `priority` 或 `fast` 服务档位时提供 Fast，普通请求不改写档位。AGY 权限预设下轮生效；其他 ACP 按会话声明暴露模式，不能等价映射就不展示。 |
| Lever 工具 | ACP 按握手走 HTTP 或 stdio。Pi 有原生 MCP 注册时用原生服务，否则将**本轮授权**的 MCP 工具注册为 Pi 工具。显式禁用 MCP 或工具时不提供依赖它们的操作；独立的历史 CLI 凭据不能拿来调用这些工具。 |

原生契约：[Google Antigravity ACP](https://antigravity.google/docs/ide/extensions/acp/)、[Pi RPC](https://docs.pi.dev/latest/rpc-commands)、[ACP Prompt Turn](https://agentclientprotocol.com/protocol/prompt-turn)、[Codex ACP steering](https://github.com/agentclientprotocol/codex-acp/blob/main/docs/steering.md)。
