<p align="center">
  <img src="./cmd/lever-desktop/icon.png" alt="Lever Logo" width="128" height="128">
</p>

<h1 align="center">Lever</h1>

<p align="center">
  <strong>以 Agent 为中心的本机 AI 工作台</strong>
</p>

<p align="center">
  连接 Codex、Claude Code、Pi、DeepSeek Harness、Antigravity 和 ACP 运行时，在同一个工作区管理对话、文件、代码变更与终端。
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong>
</p>

<p align="center">
  <a href="#核心能力">核心能力</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#运行时与插件">运行时与插件</a> ·
  <a href="#开发">开发</a>
</p>

## 为什么选择 Lever

Lever 把 Agent 配置、连续对话、独立话题和本地项目操作放进同一个工作区。为每个 Agent 配置工作目录、指令、Skills 和协作对象，再围绕它开展工作、跟进执行并审阅结果。

模型和工具执行由原生运行时负责，Lever 沿用 CLI 的配置与登录凭据。你可以在 Web UI 或桌面应用中使用同一套工作流，同时查看文件、检查变更和操作终端。

## 核心能力

- **工作区浏览器** 从桌面工作区的地球图标或分栏的 `+` 菜单打开网址和本地开发服务。点「选择元素」再点网页，确认后引用进入 Chat 或 Topic 草稿。相机把可见区域作为图片附件加入草稿。工具栏支持悬浮浏览、独立预览窗口、设备视口、缩放、强制刷新和开发者工具。每个 Agent 的浏览器标签和独立窗口共享登录态，清除 Cookie 或缓存只作用于这个 Agent 的浏览器。macOS 支持按网页选择浅色或深色外观，macOS 14 起可跨重启保留独立浏览器配置。网页版从同一入口在新标签页打开网址。
- **Agent 配置与协作**：为 Agent 设置多个 Scope 目录、默认运行时、模型、权限、指令和 Skills；通过 Delegations 配置可委派的 Agent。
- **原生运行时**：内置 Codex、Claude Code、Pi、DeepSeek Harness、Antigravity 和 ACP 插件，支持运行时与模型选择、推理强度，以及运行时提供的 Fast 档位。
- **Chat 与 Topic**：在同一个 Chat 中结合连续聊天与独立话题。多个话题可以并行执行，各自保存上下文、草稿、队列和未读状态。
- **执行控制**：查看流式回复、工具轨迹、计划、审批与问题；在运行中追加输入、排队后续消息，或停止对应会话。
- **文件与终端**：浏览和搜索 Scope 内的文件，编辑文本并自动保存，预览图片、音视频、PDF、Markdown 和文档，引用文件与上传图片；打开多个本机交互式终端，刷新或短暂断线后接回正在运行的 Shell。
- **变更审阅**：查看每轮执行的变更快照、未提交改动、提交与分支差异；将选中的代码变更引用回原对话。
- **可调整的工作区**：拖动标签排序或移动到另一分区，调整分区宽度，折叠导航与侧栏；按 Agent 保留工作区布局。
- **Web 与桌面**：共用应用服务和数据格式，支持简体中文、英语，以及跟随系统、浅色和深色主题。

## Chat 与 Topic

Chat 是可见的对话容器，Session 是运行时执行与上下文的单位。普通消息复用 Chat 的主 Session，每个 Topic 使用独立 Session；停止、审批和模型切换只影响对应会话。

主聊天与多个 Topic 可以同时工作。默认共享 Agent 的 Scope 目录，文件改动相互可见。Topic 在主聊天中显示摘要，点击后在侧栏查看、回复或引用消息，各话题的草稿和未读状态独立保留。

单击 Chat 或 Topic 时，同一分栏会复用斜体标题的预览标签。开始回复、添加附件或回答提问后，标签自动保留。只想持续查看进度时，双击标签或在右键菜单选择 **保留标签页**。

在 Agent 的 **Profile → Scope → 管理目录组和 worktree** 中，按仓库添加 worktree，再把要一起使用的目录保存为一个组。组中未指定 worktree 的仓库使用默认 Scope。新建 Topic 或派发任务时可以选择目录组。Topic 在首发时保存工作目录，后续消息、Files、Diff 和 Terminal 都使用这份目录配置。

Agent 的指令、Skills 和 Delegations 在下一轮执行时生效。已有会话保留自己的运行时、模型、权限和工作目录；修改 Agent 默认设置只影响新会话。切换运行时会为当前会话建立目标运行时的原生会话，并携带该会话历史。

在 Chat 输入 `/compare`，可以让多位 Agent 回答同一条消息。默认使用**各自 Scope**。选择**共用当前 Scope**时，所有参与者使用当前 Chat 的工作目录；没有主会话时，使用发起 Agent 的默认 Scope。共用目录不会创建独立的 worktree，有写权限的 Agent 可以修改同一份文件。

<details>
<summary>输入、附件与消息队列</summary>

- 点击输入框的 **Chat / Topic** 切换模式，也可使用 `/chat`、`/topic` 和 `/model`。
- 输入 `@` 引用当前会话工作目录中的文件，输入 `/` 选择命令或当前运行时的 Skills。引用随草稿和消息保留；点击文件引用会在对侧分栏的 Files 标签中打开文件。
- 输入框支持 Markdown 即时排版、文件选择、拖入、粘贴和图片预览。每条消息最多 8 个附件、合计 20 MiB，单张图片最多 5 MiB。
- **Enter** 发送消息，**Shift+Enter** 换行。执行中，**Enter** 默认将消息追加到当前轮（Steer），**⌘/Ctrl+Enter** 将这条消息排到下一轮（Queue）。在 **设置 → 通用 → 运行中发送** 可交换两种动作。若发送键设为 **⌘/Ctrl+Enter**，按 **⌘/Ctrl+Shift+Enter** 执行另一种动作。
- 在同一运行时切换模型后，**Steer** 会将消息交给当前轮，所选模型成为该会话下一轮的默认值。等待审批、回答问题、切换运行时或切换权限时使用 **Queue**。支持 Steer 的运行时可以将排队消息追加到当前轮。也可以编辑、移除排队消息，或将主聊天里的排队消息改为独立 Topic。
- 停止或失败只暂停当前 Session 的队列。重启后端时，正在执行的 Session 保留原有队列，当前轮完成后会继续处理。其他已暂停的队列可点击 **继续队列** 恢复。

</details>

## 快速开始

需要 Go 1.27.3、Node.js 24 和 pnpm 11；仓库固定的 pnpm 版本为 11.15.1。先安装并登录需要使用的运行时 CLI，Lever 沿用其配置和凭据。

以下命令在仓库根目录执行。

### 运行 Web UI

```sh
make build
./bin/lever
```

打开终端打印的完整本机链接。首次链接用于配对，配对后 token 会从地址栏清除。默认地址为 `127.0.0.1:4778`，当前仅支持本机访问。

### 运行桌面应用

```sh
make desktop
./bin/desktop/Lever
```

### 第一次使用

1. 打开 **设置 → 运行时**。在 **本机发现** 中选择要使用的 CLI，或点击 **添加连接** 配置其他账号或命令。
2. 首次接入后，可以直接使用初始 Agent **Lever**，也可以创建自己的 Agent。在 Profile 中选择连接、模型和权限，并指定 Scope 目录。Codex 和 Claude Code 默认加载用户目录和所有 Scope 目录中的 Skills。
3. 打开 Chat 发送消息。需要独立上下文时切换为 Topic。通过 Files、Diff 和 Terminal 查看或操作项目。

桌面端可以使用系统文件夹选择器添加多个 Scope 目录；浏览器端手动输入路径。Profile 的 Model 可以留空，在聊天输入框中选择模型。

Web 与桌面共用数据格式，同一数据目录由一个后端进程持有。数据默认保存在系统用户配置目录下的 `Lever`，可通过 `--data-dir /path/to/data` 或 `LEVER_DATA_DIR` 指定其他目录。

关闭窗口或退出桌面时，正在执行的 Agent 会在后台继续。重新打开 Lever 后，可以在原 Chat 或 Topic 查看进度、处理审批和查看结果。需要终止执行时，在原对话中点击 **停止**。桌面关闭后，后台会在任务全部结束时退出。

每一轮的 provider 由独立进程持有。重启 Go 后端期间，运行时继续执行，输出和原有审批保留在同一轮。重新打开原数据目录后即可查看输出、答复审批或停止任务。机器重启或执行进程丢失时，未确认的结果显示为 **结果待确认**。

## 运行时与插件

在 **插件** 中按图标浏览、搜索和启停已安装的插件。运行时插件提供接入能力，每种运行时都可以添加多个命名连接。插件详情中的 **管理连接** 会打开 **设置 → 运行时**，并筛选出该插件的连接。

### 配置 Codex 与 Claude Code

默认沿用本机 CLI 的登录状态与配置。CLI 查找优先使用 `~/.local/bin`，随后查找 Homebrew、`/usr/local/bin`、NVM 与继承的 PATH。可通过 `LEVER_CODEX_PATH`、`LEVER_CLAUDE_PATH` 指定可执行文件的绝对路径。

本机连接的配置目录分别遵循 `CODEX_HOME`、`CLAUDE_CONFIG_DIR`，默认使用 `~/.codex`、`~/.claude`。要同时使用个人和工作账号，在 **设置 → 运行时 → 添加连接** 中选择同一类型并命名。**登录另一个账号** 会创建独立目录并打开原生登录终端。已有独立配置时，选择 **使用已有配置目录**。随后可在 Agent Profile 和聊天模型选择器中按连接名切换。

模型选择器显示实际 CLI 版本和路径，可刷新模型目录。模型、推理强度和 Fast 是否可用，以对应运行时返回的能力为准。

### 接入 Antigravity

Lever 自动检测本机 `agy`，沿用其账号、设置与原生会话目录，无需在 Lever 重复登录。尚未登录时，在终端执行 `agy --login`，再刷新模型列表。

需要独立安装和账号时，打开 **设置 → 运行时 → 添加连接**，选择 Antigravity 和托管安装，填写名称后保存。点击 **安装 Antigravity** 和 **使用 Google 登录**。该连接在 Lever 数据目录下独立保存账号。

也可指定已有的 Antigravity ACP 程序，或通过 `LEVER_ANTIGRAVITY_PATH` 覆盖默认程序路径。Antigravity 复用 ACP 适配器，后续输入使用队列，不支持 Fast 和 Steer；图片、多目录与委派按运行时声明的能力启用。

### 接入 Pi 和 DeepSeek Harness

在运行 Lever 的机器上安装 CLI，并在终端完成登录或配置模型的 API 密钥。在 **设置 → 运行时 → 本机发现** 点击对应 CLI 的 **使用**，随后在 Agent Profile 选择该连接。

- Pi 沿用 `PI_CODING_AGENT_DIR` 指定的配置，默认读取 `~/.pi/agent`。可在 **添加连接** 中指定其他可执行文件或配置目录。
- DeepSeek Harness 通过 `dsh --profile acp` 启动。在 macOS 上，Lever 也会检测 `/Applications` 中的 DeepSeek Harness 桌面版。若使用自定义安装位置，在 **添加连接** 中填写程序的绝对路径。

也可通过 `LEVER_PI_PATH` 或 `LEVER_DSH_PATH` 指定默认运行时的可执行文件。

### 从命令行查找对话

Lever 运行时，同一系统用户下的终端、脚本和其他 Agent 可以通过本机 CLI 查询对话，结果为 JSON：

```bash
lever chat list --limit 20
lever context find --chat '<chat-id>' --query '架构决策'
lever context read --target '<session-id>'
```

省略 `--query` 列出该 Chat 的近期 Topic。读取主对话可用 `--chat '<chat-id>' --target main`；翻页时保留相同的 `--target`，并把上一页的 `nextCursor` JSON 原样传给 `--cursor`。连接非默认实例时，使用 `--data-dir` 或 `LEVER_DATA_DIR` 指定其数据目录。

从 Lever 启动的 Pi 会收到查询当前 Chat 的 CLI 命令，无需手动配置 `PATH` 或传 `--chat`。这不会启用需要 MCP 的跨 Chat 引用或委派。

### 接入 ACP 与本地插件

要使用已安装的 ACP 命令，在 **设置 → 运行时 → 添加连接** 中选择 ACP，填写程序和逐项参数。通过对应 CLI 登录后，在 Agent Profile 或模型选择器中选择该连接。

点击 **插件 → 安装插件** 可粘贴 Git 仓库地址，也可选择包含 `lever-plugin.json` 的本地目录。Git 插件支持按子目录安装、预览更新和回退到上一版。本地开发时可在详情页重新读取清单。清单格式和会话身份规则见 [插件说明](docs/plugins.md)。

<details>
<summary>在原生应用中接续会话</summary>

打开 **Agents → 最近**，选择一条 Codex App 或 Claude Code 会话。Lever 读取原生历史，发送的文字由原应用在同一条会话中处理。打开的聊天会自动更新已经写入原生历史的消息。

Codex App 会在需要时打开对应会话。macOS 上的 Claude 桌面端 Code 会话也可以从 Lever 唤起。终端中的 Claude Code 需要先打开原会话，并支持接收其他会话的消息。

Lever 保存 CLI 的原生会话 ID，同一运行时内续聊沿用该 ID；主聊天和每个 Topic 分别保存。原生应用能否发现或接续会话，取决于运行时和本机配置。

对于在 Lever 创建的 Chat 和 Topic，等当前执行结束后再在原生应用中续聊。原生应用新增的消息尚不会导入这些 Chat 和 Topic。跨运行时切换会建立目标运行时的新会话。

</details>

## 文件、终端与变更审阅

<details>
<summary>文件编辑与搜索</summary>

Files 支持编辑 Scope 内不超过 2 MiB 的 UTF-8 文本文件。停止输入 500 ms 后自动保存，也可点击保存或按 **⌘/Ctrl+S**。切换文件或标签不会中断保存。保存失败会保留本次打开应用期间的草稿。磁盘文件有冲突时，可下载草稿或重新载入磁盘版本，读取成功后才会丢弃草稿。

点击顶部路径或文件名打开目录树。Markdown 默认预览，源码与预览的选择会保留。目录支持路径筛选；**在文件中搜索** 忽略大小写并遵循 Git 忽略规则，跳过二进制和超过 2 MiB 的文件，点击结果定位到对应行。

Files 按类型预览：图片（PNG/JPEG/GIF/WebP/SVG/AVIF/BMP/ICO/HEIC/HEIF/TIFF，支持缩放与拖动）、音视频、PDF、静态 HTML、Markdown/MDX、Mermaid、CSV/TSV、字体（TTF/OTF/WOFF/WOFF2）、DOCX/XLSX/PPTX、ODT/ODS/ODP、RTF、EPUB、Jupyter Notebook、ZIP/JAR/TAR/GZ/TGZ 目录，以及 SQLite 数据表。文档提供内容预览，复杂排版、图表、公式和动画不保证还原；HTML 不运行脚本或加载外部资源，音视频编码支持取决于浏览器。二进制预览为只读，不支持的文件可从文件操作菜单下载。

文档、压缩包和数据库解析在独立 Worker 中按需加载，单文件上限 50 MiB，超时 30 秒；字体上限 10 MiB，Notebook/RTF 上限 8 MiB。压缩内容另有限制；表格、数据库分页显示，超出文档预览上限会提示截断。图片和音视频通过原始资源接口读取，音视频支持 HTTP Range，不受文本编辑的 2 MiB 限制。

</details>

<details>
<summary>交互式终端</summary>

Terminal 可以打开多个终端，默认在 Agent 的主 Scope 目录启动系统 Shell，支持缩放、中文输入输出、滚动历史和 Ctrl+C。切换标签或 Agent 会保留会话。刷新页面或短暂断线后，可以接回仍在运行的 Shell。关闭终端标签会结束对应 Shell，停止后端会结束它管理的终端。

终端以本机用户权限执行命令。Scope 只决定起始目录，终端不沿用模型的审批或只读策略。

</details>

<details>
<summary>Diff 与轮次变更</summary>

Diff 支持最近一轮、未提交、未暂存、已暂存、单次提交和分支比较，以及统一或并排显示、词级差异、换行和完整上下文。

轮次有可预览的变更时，回复下方会显示文件摘要。打开后可点击或拖选行号，再点击 **反馈这段变更**，将代码、路径和行号追加到原 Chat 或 Topic 的草稿；后续文件修改不会改写已引用的代码。

Codex 的「本轮变更」显示运行时上报的累计补丁。通过 shell 写入的内容可能不会出现在补丁中。同一文件被多个任务交错编辑时，补丁可能包含其他任务中途写入的内容。从 Chat 或 Topic 打开的「最近一轮」仅查询该会话，刷新可查看随后完成的轮次。

依赖 Git 快照的轮次（例如其他运行时的轮次或仅有快照的历史记录）仍可在同一视图中查看执行前后的差异。差异包含未忽略的新文件，也可能包含并发写入；采集不会修改用户的暂存区、HEAD 或工作文件。非 Git 目录支持 Codex 原生补丁。

</details>

## 开发

### 桌面热更新

在 macOS 上运行：

```sh
./scripts/restart-desktop.sh
```

脚本先安装前端依赖并编译 Go，再替换目标数据目录的桌面窗口和后端。正在运行的 provider 会继续执行，新窗口会接回同一轮任务和待审批请求。首次从旧版升级时，脚本会等旧版已启动的任务结束，原窗口在此期间仍可审批。前端由本机 Vite 提供热更新。

脚本支持 `--data-dir`、`--listen` 和 `LEVER_DATA_DIR`。开发模式通过后端转发前端资源和 HMR，保持 API、配对与页面设置同源。

### 浏览器热更新

先安装前端依赖：

```sh
pnpm --dir web install --frozen-lockfile
```

在两个终端分别运行：

```sh
make dev
```

```sh
pnpm --dir web dev
```

打开后端打印的 **Lever:** 链接（端口 4778），或 **Development:** 链接（端口 5179）。两种入口共用本机后端，开发构建不依赖 `web/dist`。

### 构建桌面包

```sh
make package
# 同时构建 Windows 可执行文件
make package TARGETS=darwin/arm64,windows/amd64
```

产物位于 `desktop/dist/`，默认目标为 macOS Apple Silicon。macOS 使用本地 ad hoc 签名；上述命令跳过 DMG 和 Windows 安装器。正式发布需要配置签名、公证，并完成目标平台实机验证。

### 验证改动

```sh
make privacy
pnpm --dir web install --frozen-lockfile
pnpm --dir web exec playwright install chromium
make test
go vet ./...
```

`make test` 运行隐私检查、Go 竞态检查、前端生产构建和 Playwright 端到端测试。集成测试通过真实 HTTP、SQLite 和 CLI 协议夹具验证会话、审批、取消、委派及文件边界。夹具不调用真实模型。

用以下命令单独运行 Chat 切换基准。

```sh
pnpm --dir web build
pnpm --dir web test:e2e chat-switch.spec.ts
```

基准使用 6 个各有 52 轮历史的 Chat 和固定的历史响应，测量从标签页收到点击事件到最新消息可见的时间。Chromium 的 P90 上限为首次打开 180 ms、切回已加载 Chat 100 ms。安装 Playwright WebKit 后，可给测试命令加上 `--browser=webkit`，对应上限为 200 ms 和 140 ms。终端显示 P90，Playwright 报告附有各次切换的耗时。

隐私检查需要 Python 3，默认扫描已跟踪文件和未被忽略的新文件的路径与文本内容，检查本机用户路径、私网 IPv4、非示例邮箱、内网 URL 和常见密钥格式。检查暂存区的实际内容时，运行 `python3 scripts/privacy_check.py --staged`。输出只包含文件位置和问题类型。

将公司名称、内部域名、内部项目名和其他私人词条写入 `.private-words.txt`，每行一项，`#` 开头的行作为注释。该文件已被 Git 忽略；也可将词条放入 `${XDG_CONFIG_HOME:-~/.config}/lever/private-words.txt`，在多个工作区复用。公司专有词检查依赖这些本机词条。

修改 Go DTO 或桌面绑定后，重新生成类型：

```sh
make generate
```

<details>
<summary>真实运行时验证</summary>

真实运行时测试需要显式启用，会使用已登录账户的模型额度。将 `<available-model>` 替换为账号可用的模型：

```sh
LEVER_LIVE_TEST=1 LEVER_LIVE_CODEX_MODEL='<available-model>' \
	go test ./internal/provider -run TestLiveRuntimes/codex -v -count=1

LEVER_LIVE_TEST=1 LEVER_LIVE_CLAUDE_MODEL='<available-model>' \
	go test ./internal/provider -run TestLiveRuntimes/claude -v -count=1

# 模型目录、图片与 Fast 的联合验证
LEVER_LIVE_TEST=1 go test ./internal/provider -run TestLiveComposer -v -count=1
```

</details>

## 更多文档

- [设计文档](docs/design.md)：Agent、Chat、Session、执行生命周期与应用架构。
- [插件说明](docs/plugins.md)：插件清单、Provider 配置和 ACP 支持范围。

## 许可证

本项目采用 [Apache License 2.0](LICENCE)。
