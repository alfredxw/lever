# 插件清单

插件清单声明插件的能力。内置插件、本地目录和 Git 仓库安装共用安装记录和启停机制。外部插件可声明 Provider、`poll-stdio-v1` 事件源，或声明一个个人消息渠道。内置插件还可以声明 Works 的任务来源和内置事件源。

## 包结构

仓库的 `internal/plugin/builtin/` 为每个内置插件提供独立的目录和 `lever-plugin.json`。GitHub、Lark Todos 和 Lark Bot 的适配器也在各自目录。Provider 插件通过清单引用 `internal/provider/` 的运行时驱动。内置清单随 Lever 编译进可执行文件。

本地安装选择包含清单的目录。Lever 保存清单快照并引用该目录，不复制或删除源文件。

在 **插件 → 安装插件 → Git 仓库** 中填写 HTTPS 或 SSH 仓库地址。私有仓库沿用运行 Lever 的机器上已有的 Git 凭据。一个仓库可提供多个插件，填写包含 `lever-plugin.json` 的子目录即可单独安装。仓库应包含可直接使用的插件文件和正确的可执行位，预览阶段仅读取文件。

```text
example-agent/
├── lever-plugin.json
└── bin/
    └── example-agent
```

```json
{
  "manifestVersion": 1,
  "id": "example.agent",
  "name": "Example Agent",
  "version": "1.0.0",
  "description": "A coding agent using ACP",
  "contributes": {
    "providers": [
      {
        "id": "agent",
        "name": "Example Agent",
        "driver": "acp",
        "command": "bin/example-agent",
        "args": ["--acp"]
      }
    ]
  }
}
```

`command` 可以是 PATH 中的程序名、绝对路径或插件目录内的相对路径。相对路径解析后必须留在插件目录内。参数逐项原样传递，不展开 Shell 表达式。运行时的工作目录是会话的主 Scope 目录，不是插件目录。

## 字段

| 字段 | 含义 |
| --- | --- |
| `manifestVersion` | 当前为 `1` |
| `id` | 发布者定义的 ID，支持小写字母、数字、点、下划线和连字符，最多 128 字符；`lever.` 为内置命名空间 |
| `name` | 显示名称，最多 100 字符 |
| `version` | 显示版本，最多 100 字符 |
| `description` | 可选说明，最多 1000 字符 |
| `contributes.providers` | 最多 32 个 Provider 贡献，贡献 ID 在同一插件内唯一 |
| `contributes.taskSources` | 内置任务来源。每项包含 `id` 和 `name`，由宿主注册读取适配器 |
| `contributes.channels` | 内置渠道使用 `id`、`name`；本地个人渠道还须指定 `driver: "personal-stdio-v1"` 和包内相对可执行文件 `command`，不能混合声明 Provider 或事件源 |
| `contributes.eventSources` | 内置事件源使用 `id`、`name`、`fields`；外部事件源（最多 32 个）须从包目录安装，指定 `driver: "poll-stdio-v1"`、包内相对可执行文件 `command` 与最多 32 个字段（`kind` 为 `text` 或 `secret`，`secret` 不能设 `default`） |
| Provider 的 `driver` | `codex`、`claude`、`pi`、`antigravity` 或 `acp` |
| Provider 的 `command` | 可执行程序。ACP 必填；其他适配器留空时查找托管安装或本机对应 CLI |
| Provider 的 `args` | ACP 的启动参数数组；原生适配器自行构造协议参数 |

清单最多 256 KiB。未知字段、未知贡献类型和未知 driver 均被拒绝。安装只登记贡献，不执行安装脚本或自动登录。

## 安装与会话身份

个人渠道需要包含可执行文件的本地目录或 Git 包。扫码或恢复监听时启动程序，每个安装和登录会话使用独立的私有数据目录。只安装可信的可执行程序，它与其他本地进程一样具备本机用户权限。宿主提供固定配置页、按账号/Agent 隔离的 Chat（默认单 Chat 按 Topic 分组：每个 Agent 共用 1 个渠道 Chat，每段连续飞书私聊、群主聊天或话题建为独立 Topic；也可切换为多 Chat 按飞书会话拆分，每个飞书私聊或群聊各自对应 1 个 Chat）、仅本人指令路由和持久投递记录，不加载第三方前端脚本。

适配器将账号凭据写入 `LEVER_CHANNEL_HOME`，将可跨登录复用的运行环境写入 `LEVER_CHANNEL_CACHE`。退出登录会删除该会话目录，卸载会同时删除缓存。适配器首次准备依赖时可发送 `{"event":"connecting","phase":"preparing"}`，宿主会显示准备状态，并允许用户取消。

每条个人渠道路由可跟随 Agent Profile，或选择该渠道专用的运行时和模型。同一路由的别名共用模型。保存后受理的新指令采用当时的选择和渠道提示词，已有话题也可继续。最近受理分别显示执行结果、原消息表情和最终回发的投递状态。

个人渠道的 Chat 可以在 Lever 续聊。Lever 发起的轮次保留在同一会话历史里，不会自动回发到原渠道；如果渠道轮次还在执行，新消息会按顺序排队。

一个插件可以贡献多个 Provider。每个贡献可以建立多个配置实例。聊天保存配置实例 ID，原生会话属于该实例。

插件安装 ID 与清单中的发布 ID 分开。卸载保留安装记录、连接和聊天历史，同时停用相应运行时。重新安装同一个发布 ID 会生成新的安装 ID。用户可为这次安装添加连接，旧聊天切换到新连接时通过历史交接继续。

内置插件可以停用。停用或卸载提供 Provider 的插件前，先处理这些 Provider 中正在运行、结果未知或排队的任务。每个配置实例保留自己的开关设置。

外部插件拥有其声明的程序和参数。内置适配器允许为新配置指定本机程序。配置建立后只能修改名称和开关；更换执行程序、参数或配置目录需要新建配置，避免误用旧原生会话。

### 更新与回退

- **Git 仓库**在安装时记录仓库、子目录、分支和确切的 commit。留空分支会跟踪安装时的默认分支，选择标签或完整 commit 会固定版本。已固定的安装可通过 **选择版本** 切换到另一分支、标签或 commit。
- 打开插件页会检查分支，结果缓存 15 分钟。**检查更新** 可立即刷新。只有插件子目录的 Git tree 发生变化才提示可更新，版本号相同时用短 commit 区分。
- **预览更新** 展示目标包、启动命令和能力变化。确认时切换到预览过的文件。断网后仍可使用已装版本，详情页可 **回退到上一版**。回退只切换包，插件写入的账号和业务数据沿用当前内容。
- 更新与回退共用安装 ID。兼容的 Provider 连接可以续用原生会话，已连接的个人渠道按保存的账号和路由恢复监听。存在未完成执行、排队任务、配对或正在发送的回执时，先完成这些操作再重试。已使用的 Provider 贡献变更驱动、入口或参数时，预览会列出受影响的连接，需要通过新安装和新连接交接会话。
- **本地目录**在详情页使用 **重新读取清单**，目录内的程序由开发者维护。内置插件随 Lever 发版。直接通过 API 登记清单的安装没有可检查的仓库来源。

## 外部事件源（`poll-stdio-v1`）

外部插件可在 `contributes.eventSources` 中声明 `driver: "poll-stdio-v1"` 和包内相对路径 `command`，通过本地目录或 Git 仓库安装后出现在 **自动化 → 事件触发 → 事件类型** 中。

```json
{
  "manifestVersion": 1,
  "id": "example.alerts",
  "name": "Build Alerts",
  "version": "1.0.0",
  "contributes": {
    "eventSources": [
      {
        "id": "build-failed",
        "name": "Build failed",
        "driver": "poll-stdio-v1",
        "command": "bin/poll",
        "fields": [
          { "id": "endpoint", "label": "API URL", "kind": "text", "required": true },
          { "id": "token", "label": "API token", "kind": "secret", "required": true }
        ]
      }
    ]
  }
}
```

宿主按轮询周期（默认每分钟，受待处理队列上限背压）在插件目录启动 `command`，并通过标准输入传入单条 JSON 请求（配置与密钥均走 stdin，不放入命令行参数），同时设置 `LEVER_PLUGIN_DIR` 与插件私有缓存目录 `LEVER_EVENT_SOURCE_CACHE`（卸载时清除）：

```json
{
  "protocolVersion": 1,
  "source": "build-failed",
  "automationId": "<automation-id>",
  "config": { "endpoint": "https://api.example.com", "token": "..." },
  "cursor": "",
  "limit": 32
}
```

程序在 12 秒内向标准输出返回单条 JSON（上限 1 MiB）：

```json
{
  "cursor": "2026-11-21T08:00:00Z",
  "more": false,
  "events": [
    { "key": "build-42", "payload": { "status": "failed", "build": 42 } }
  ]
}
```

- 首次轮询传入空 `cursor`；返回非空 `cursor`（最多 1024 字节）后，宿主会在同一数据库事务内保存事件并推进游标。
- 每条事件的 `key` 最多 200 字节用于去重，`payload` 为不超过 16 KiB 的合法 JSON；事件数量不能超过 `limit`。`more: true` 时宿主会立即拉取下一批。
- 退出码非零时，标准错误摘要会显示在该自动化的事件源错误提示中；停用、卸载或更新插件时会取消正在执行的轮询，正在被未归档自动化使用的事件源贡献若在更新中被移除或更换 `driver` 会被阻止。

对于本地脚本、Git hook 等外部推入场景，也可以对自定义 Webhook 自动化直接使用本机 CLI 推送事件（走本机 IPC，无需监听端口或 Bearer Token）：

```sh
lever automations list
echo '{"type":"push","branch":"main"}' | lever automations emit --id '<automation-id>' --key 'commit-abc'
```

## Works 数据来源

### GitHub

内置 GitHub 插件提供仓库的 Issue 和 PR。仓库订阅在 **Works → 来源** 中管理。GitHub 适配器解析仓库身份和 API 响应，Lever 调度同步、保存快照和同步进度，并管理 Agent 分派、验收和 Chat 关联。

订阅创建后立即同步。Lever 后端运行时，每五分钟继续同步。首次读取开放的 Issue 和 PR，后续跟踪更新，包括关闭、合并和重开。暂停仓库或停用插件会暂停同步并保留快照。移除仓库会在看板隐藏其未处理的条目，并保留已关联 Chat 或已标记完成的任务。重新添加同一仓库会恢复原订阅。

本机 GitHub CLI 的登录可用于读取私有仓库。没有凭据时，Lever 以匿名方式读取公开仓库。

### Lark Todos

安装并配置本机 `lark-cli`，然后授权读取待办。

```sh
lark-cli auth login --scope task:task:read
```

在 **Works → 来源 → 添加来源** 中选择 **Lark Todos**。来源名称默认为 **Lark Todos**，可在添加时修改，之后也可在来源详情的 **基本信息** 中重命名。添加后可从 Works 侧栏点开来源，直接修改同步规则。

1. 选择 **全部待办**，或选择 **指定分组** 并打开要订阅的分组。读取分组需要 `lark-cli auth login --scope task:section:read` 授权。
2. 按需设置截止时间、标题包含词、排除词，以及是否同步重复待办。同一字段内的关键词匹配任意一个，排除词优先。
3. 在 **现有待办** 中批量或逐条勾选本次要导入的待办，也可以从 0 项开始。之后可重新勾选已跳过的待办。

开启自动同步后，Lever 每五分钟按已保存的规则同步当前账号负责的未完成待办。切换 CLI 账号或读取失败时，来源保留上次成功同步的结果。缩小范围后，已有本地进度或关联 Chat 的任务仍可查看。

## Lark Bot

1. 在 **插件 → 消息渠道 → Lark Bot** 点击 **新建或选择机器人**。用飞书或 Lark 扫码，或点击 **打开配置链接**。在授权页新建机器人或选择已有机器人，确认后 Lever 会自动连接。也可以点击 **手动输入凭据**，用 App ID 和 App Secret 连接。
2. 机器人连接后，向机器人私聊发送页面上的 `/pair` 命令。如果页面还没有命令，点击 **生成绑定码**。
3. 回到 Lever，选择运行时和工作目录，再点击 **创建 Agent 并绑定**。Lever 创建与机器人同名的 Agent 和专用 Chat。也可以选择 **使用已有 Agent**。

如果机器人收不到私聊，在 Lark Bot 页面打开 **开发者后台**。确认机器人能力已启用，应用已获得接收私聊和以应用身份发消息的权限，并通过长连接订阅 `im.message.receive_v1`。按租户要求提交发布。如果后台需要长连接在线，可以先在 Lever 连接，再发布事件配置。 [飞书长连接配置](https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-)

Lark Bot 接收绑定用户的私聊文本，沿用 Agent 的运行权限和队列。遇到审批或问题时在 Lever 处理。Chat 会显示回复的投递状态，明确失败时可以单独重试回发。Lever 后端运行时维持长连接，App Secret 保存在本机数据目录的独立凭据文件中。暂停接收允许已接收的消息继续处理。解绑会停止后续收发，并保留已有 Chat。

## 本机检测与配置目录

插件页按能力展示插件图标，支持搜索和状态筛选。插件详情的 **管理连接** 打开对应插件的连接列表。**设置 → 运行时 → 本机发现** 查找已启用插件的本机命令，点击 **使用** 才保存连接。重新检测会保留已有连接的名称和启停状态。Codex 和 Claude Code 的连接可显示原生 CLI 确认的登录状态，其他运行时显示程序检测结果。

本机 Codex、Claude Code 和 Pi 连接沿用各自的 CLI 配置目录。环境变量 `CODEX_HOME`、`CLAUDE_CONFIG_DIR`、`PI_CODING_AGENT_DIR` 分别优先于 `~/.codex`、`~/.claude`、`~/.pi/agent`。在 **添加连接** 中可以选择已有配置目录，也可以让 Lever 为新连接创建独立目录。已有目录支持绝对路径和 `~/`，保存时展开为绝对路径。

指定目录后，登录终端、程序检测、模型发现、技能读取和聊天进程使用同一目录。凭据由原生 CLI 保存。修改连接显示名会保留原生会话绑定。要更换目录，请建立新连接。

## ACP 支持范围

Lever 使用 ACP v1 和 `github.com/coder/acp-go-sdk`。支持 `session/resume` 或 `session/load` 时优先恢复原生会话，历史回放不重复写入新 Run。两者皆无时，新一轮显式交接 Lever 历史，不假称恢复原生会话。连接在任务完成前断开时，结果标记为 `unknown`，不自动重发输入。

支持文本与思考输出、工具进度、计划、原生审批选项、模型及模式选择。图片、内嵌文件和多目录按协商能力启用；不能内嵌文件时使用标准 `resource_link`。运行时声明 HTTP MCP 时直接使用 HTTP，否则通过 ACP 的 stdio MCP 接入相同的每轮工具。Profile 指令作为本轮输入传入。目前不提供客户端文件与终端执行回调，不安装 Agent 技能目录。运行中能原生追加才提供 Steer，否则仅 Queue，详见[运行时能力表](provider-capabilities.md)。登录和工具执行由运行时管理，独立进程本身不是沙箱。

声明 `additionalDirectories` 的运行时通过会话协议接收附加工作目录。仅支持单个工作目录时在主目录启动，Lever 通过上下文或文件链接提供其余目录的路径。跨目录访问由运行时按当前权限处理。

`antigravity` 支持接入本机 `agy`，沿用 CLI 已有的登录和设置。另可在 **设置 → 运行时** 创建独立 ACP 安装，使用单独的账号目录和 Google 登录。两种方式共用 ACP 适配器并按模型读取推理档位。普通模型探测不会弹出浏览器。[接入 Antigravity](../README.zh.md#接入-antigravity)

自定义 UI、`@` 数据源、工具及连接器尚未定义贡献契约。后续能力在 `contributes` 中增加各自的契约和宿主处理，不改变插件安装身份与 Provider 会话归属。
