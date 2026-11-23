# Changelog

Lever 仅在此记录用户有明确感知的重大功能、重要不兼容或数据变更、安全更新，以及影响核心流程的关键修复。完整记录可查看 Git 提交历史。

`Unreleased` 以最近一个已发布版本为基线，只描述升级用户最终可感知的净变化，不记录内部重构、测试、文案、细节 UI 调整或未发布中间格式。

格式参考 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)。

## [Unreleased]

### 新增

- 新增自托管 Hub 和手机控制端，可在局域网直连执行设备，离开 Wi-Fi 后接续共享会话，并从锁屏通知进入审批或查看结果。

- 提供桌面端与 Web 端本机 AI 工作台，支持持久化 Agent、主聊天与并行 Topic 混合时间线，以及运行中纠偏（Steer）、消息排队、暂停/继续与停止、`/after` 前置依赖编排和进程隔离后台运行。
- 统一编排 Codex、Claude Code、Pi、Antigravity、DeepSeek Harness 与自定义 ACP 运行时，支持同 CLI 多账号、会话内热切运行时、`/compare` 多 Agent 对比、多目录 Scope 与 Git worktree 目录组，以及 Codex App 与 Claude Code 原生会话续聊。
- 内置一体化本机工作台，包含 Monaco 文件编辑与 25+ 格式预览、聊天内联 HTML 与本机文件只读预览、顶栏 Git 状态与可划行反馈的 Diff 审阅、持久 PTY 终端，以及桌面端工作区浏览器（支持元素拾取、截图与按 Agent 隔离登录态）。
- 提供 Works（块笔记、支持截止日期与 Agent 队列总控的工作项看板，以及 GitHub 与 Lark Todos 同步）和多目标自动化，支持定时触发、IMAP 邮件、Webhook 与外部轮询事件源，并集中浏览产出流与执行详情。
- 支持跨运行时 Skills 发现、按 Agent 启停、Git 订阅与本地修改保护，以及通过 Git 或本地目录管理运行时、任务源、事件源与个人消息渠道（含内置 Lark Bot）插件。
