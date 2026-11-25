# Changelog

Lever 仅在此记录用户有明确感知的重大功能、重要不兼容或数据变更、安全更新，以及影响核心流程的关键修复。完整记录可查看 Git 提交历史。

`Unreleased` 以最近一个已发布版本为基线，只描述升级用户最终可感知的净变化，不记录内部重构、测试、文案、细节 UI 调整或未发布中间格式。

格式参考 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)。

## [Unreleased]

### 修复

- Windows 上即使进程的 PATH 尚未更新，也能识别已写入系统或用户 PATH 的 Antigravity CLI 等本地运行时。
- 本机 agy 登录会在新进程中验证凭据和模型访问，登录失败时提示具体原因。

## [0.1.0] - 2026-11-25

### 简要说明

- 桌面端和 Web 端提供本机 AI 工作台，支持会话草稿、并行讨论、排队、运行中纠偏和暂停后继续。
- 支持在同一工作区使用 Codex、Claude Code、Pi 等运行时，并按会话切换运行时和账号。
- 集成文件编辑与预览、Git 差异行内审阅和持久终端。桌面端支持按 Agent 隔离工作区浏览器的登录态。
- Works 集成笔记、看板和外部任务同步，支持定时和事件驱动的自动化。Skills 可按 Agent 启停。
- Android 可以通过自托管 Hub 配对执行设备，接续共享会话。首批内测提供 macOS Apple Silicon、Windows x64、Android 和 Linux Hub 安装产物。
