<div align="center">

<img src="./cmd/lever-desktop/icon.png" alt="Lever Logo" width="112" height="112" />

<h1>Lever</h1>

<p><strong>The Agent-first local AI workbench built for high-concurrency work.</strong></p>

<p>
  Orchestrate native <strong>Codex</strong>, <strong>Claude Code</strong>, <strong>Pi</strong>, <strong>DeepSeek Harness</strong>, <strong>Antigravity</strong>, and <strong>ACP</strong> CLIs —<br />
  with independent parallel Topics, persistent Agents, built-in dev tools, Works, and Automations in one lightweight app.
</p>

<p>
  <a href="LICENCE"><img src="https://img.shields.io/badge/License-Apache%202.0-18181b?style=flat&labelColor=27272a" alt="Apache 2.0 License" /></a>
  <img src="https://img.shields.io/badge/Go-1.27%2B-00ADD8?style=flat&logo=go&logoColor=white&labelColor=27272a" alt="Go 1.27+" />
  <img src="https://img.shields.io/badge/React-19-0ea5e9?style=flat&logo=react&logoColor=white&labelColor=27272a" alt="React 19" />
  <img src="https://img.shields.io/badge/App-Desktop%20%26%20Web-6366f1?style=flat&labelColor=27272a" alt="Desktop and Web" />
  <img src="https://img.shields.io/badge/Protocols-Native%20CLIs%20%C2%B7%20ACP%20%C2%B7%20MCP-10b981?style=flat&labelColor=27272a" alt="Native CLIs, ACP, MCP" />
  <img src="https://img.shields.io/badge/Data-Local--First%20SQLite-f59e0b?style=flat&logo=sqlite&logoColor=white&labelColor=27272a" alt="Local-First SQLite" />
</p>

<p>
  <strong>English</strong> · <a href="README.zh.md">简体中文</a>
</p>

<p>
  <a href="#the-idea">The Idea</a> ·
  <a href="#how-lever-differs">How Lever Differs</a> ·
  <a href="#core-capabilities">Capabilities</a> ·
  <a href="#supported-runtimes">Runtimes</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#development">Development</a>
</p>

</div>

---

## The Idea

Early AI tools taught us to work in long, linear chats: explain the background, wait for a partial answer, nudge it three more times, and keep piling new tasks onto the same scrollback—or scatter work across dozens of disposable windows you quickly lose track of.

**That rhythm no longer matches how modern Agents work.** As Agents get dramatically better at understanding human intent, a single task rarely needs ten rounds of conversational alignment. Most pieces of work are naturally independent—you state the goal, let the Agent run, and only step in when you want to refine or verify.

Lever flips the default interaction model from **continuous chat first** to **independent Topics first, continuous chat as support**:

> **Weakly coupled across Topics + Strongly continuous within each Topic = High concurrency.**

```text
One Agent · One Chat Timeline
├── Main Chat         ──► Continuous alignment & quick back-and-forth
├── Topic A (running) ──► [Worktree A · Codex]       Refactor auth flow    ──► Deep follow-ups & Diff review in side pane
├── Topic B (running) ──► [Worktree B · Claude Code] Fix mobile layout     ──► DOM element picked from Workspace Browser
└── Topic C (waiting) ──► [Default Scope · Pi]       Draft release notes   ──► Queued follow-up ready on completion
```

- **Weak coupling across Topics:** Every Topic lives on the same Chat timeline as a live summary and inherits the Agent's persistent identity, directories, and Skills—so you keep the full picture in one place without Topics blocking each other or polluting each other's context window.
- **Strong continuity within each Topic:** Open any Topic in the side pane whenever a task *does* need deep iteration. Each Topic owns an isolated Session with its own runtime, model, worktree directory group, draft, queue, and unread state.
- **High concurrency by default:** Run five Topics and a main Chat simultaneously under one Agent—then review their files, diffs, terminals, and live web previews right beside the conversation.

## How Lever Differs

Many local multi-CLI tools already let you drive coding CLIs without vendor lock-in. Lever stands out in **how work is organized, parallelized, and verified**:

| Dimension | Conventional Multi-Agent Patterns | How Lever Works |
| :--- | :--- | :--- |
| **Conversation rhythm** | One bloated linear chat, or dozens of disconnected per-branch threads | **Independent Topics first, continuous Chat as backbone** — weakly coupled parallel Topics inside a unified timeline, with deep side-pane continuity |
| **Top-level unit** | Repo-folder windows, disposable threads, or async team tickets | **Persistent Agents** — define multi-repo **Scopes**, named Git **worktree groups**, native instructions, **Skills**, **Delegations**, and saved layouts once |
| **Execution control** | Wait for completion or hard-abort | **Steer, Queue, Pause & Resume** — guide active turns, stack or promote queued messages into Topics, and survive window closes or backend restarts |
| **Runtimes & accounts** | Single login per CLI, or locked to one runtime per thread | **Multi-account native CLIs** *(e.g. personal + work)*, mid-session runtime switching with history handoff, `/compare` across Agents & **Codex App / Claude Code** continuation |
| **Verification loop** | Jump between chat, IDE, terminal, and external browser | **Built-in local workbench** — Monaco **Files** + 25+ previews, turn & Git **Diffs** with inline feedback, persistent **PTY Terminals**, and a DOM-picking **Workspace Browser** |
| **Beyond reactive chat** | Prompt-only sessions, or heavy cloud/server boards | **Personal local work hub** — block **Notes**, Kanban **Board** synced with **GitHub** & **Lark Todos**, scheduled/event **Automations**, and **Lark Bot** in a single **Go + native WebView + SQLite** app |

## Core Capabilities

### Parallel Topics & Live Execution Control
- **Mixed Chat + Topic timeline:** Stay in a continuous main Chat when exploring together, or send any message as an independent **Topic** when you want parallel execution. Topics show compact live summaries inline and expand in the side pane with separate drafts, queues, and unread markers.
- **Steer, Queue, Pause & Resume:** While a turn is running, steer it in flight (<kbd>Enter</kbd>) or queue follow-up turns (<kbd>⌘/Ctrl</kbd>+<kbd>Enter</kbd>). Edit queued messages, move them into the active turn, or promote a queued main-chat message into its own Topic. Supported runtimes also let you **Pause & Resume** replies while keeping generated output intact.
- **Process-isolated turns:** Every turn executes in an isolated provider host process. Closing the desktop window or restarting the Go backend never kills running Agents—reopen Lever to reconnect straight to live output and pending approvals.
- **Rich composer:** Live Markdown formatting, `@` references (files, chats/topics, Agents, notes, work items), `/` commands & Skills, and drag-and-drop / paste attachments.

### Persistent Agents, Multi-Account & Native Interop
- **Configure once, launch Topics instantly:** Give each Agent its own multi-directory **Scope**, reusable Git **worktree directory groups** (locked per Topic on first send), default runtime/model/permissions, native system instructions, **Skills**, and one-level MCP **Delegations**.
- **Multiple accounts & live runtime handoff:** Run separate personal and work logins for the same CLI side by side. Switch runtimes mid-session and Lever creates a native session on the target runtime with conversation history handed over automatically.
- **Multi-Agent `/compare` & native continuity:** Type `/compare` to send the same prompt to multiple Agents simultaneously (using their own Scopes or a shared Scope). Open **Agents → Recent** to inspect and continue local **Codex App** or **Claude Code** sessions directly, and monitor active subscription usage windows in the navigation rail.

### Integrated Local Workbench
- **Workspace Browser** *(Desktop)*: Open local dev servers or websites right beside your conversation. Click **Select an element** to drop a DOM selector and visible text straight into a Chat or Topic draft, or attach a visible-area screenshot. Includes device viewports, zoom, floating/pop-out windows, DevTools, macOS per-page light/dark mode, and per-Agent isolated login profiles (persisted across restarts on macOS 14+).
- **HTML files in Chat:** A standalone local HTML link or a single sent HTML attachment opens inline. Click a link in a sentence or to a specific section to expand it in place. The preview header has icon buttons for **Quick preview**, **Open in web tab**, and copying the file path. On desktop, **Open in system browser** opens the original file directly from disk without a Lever URL or browser pairing. In the web app, choose **Download original HTML file** instead. Embed relative images when sharing a report as a single attachment.
- **Files & 25+ Format Previews:** Browse and search across multi-root Scopes (`.gitignore`-aware), edit UTF-8 files in **Monaco** with 500 ms autosave and disk-conflict protection, and preview images, audio/video, PDF, Mermaid, Office documents, Jupyter notebooks, archives, and SQLite tables in place.
- **Turn & Git Diff with Inline Feedback:** Review latest-turn Codex patches or read-only Git snapshots, uncommitted/staged changes, commits, and branch diffs (unified or side-by-side). Select line numbers and click **Discuss selection** to send an immutable code snippet back to the originating Topic.
- **Persistent PTY Terminals & Saved Layouts:** Open multiple local shells that survive tab switches and page refreshes. Drag tabs freely across split panes—each Agent remembers its own workspace layout, in English or Simplified Chinese, across Light, Dark, and System themes.

### Works, Automations, Skills & Plugins
- **Works (Notes + Board + Sync):** Draft rich block **Notes** with inline tasks and `@Agent` handovers, track progress on a customizable Kanban **Board** with saved views, and auto-sync **GitHub Issues/PRs** and **Lark Todos** straight into dispatchable work items.
- **Automations:** Let Agents start work on their own—on flexible schedules (once, daily, weekdays, weekly, monthly, interval) or incoming events (**IMAP Mail** and custom **Webhooks** with Bearer auth and `Idempotency-Key`), routing results into fresh Topics, existing Chats, or Board items.
- **Skills & Extensible Plugins:** Discover, filter, and toggle Skills across Lever-managed, user, and Scope directories per Agent (with built-in editing for Lever-managed `SKILL.md`). Install Runtime, Task Source, Event Source, or Personal Channel plugins—including built-in **Lark Bot**—from Git repositories (with version pinning, update previews, and one-click rollback) or local directories.

## Supported Runtimes

Lever orchestrates the CLIs already installed on your machine—reusing your existing logins, subscriptions, and configurations without modifying global CLI files.

| Runtime | Integration | Highlights | Executable Override |
| :--- | :--- | :--- | :--- |
| **Codex** | Native (`app-server`) | Multi-account, Steer, Pause/Resume, Skills, Fast, Codex App continuity | `LEVER_CODEX_PATH` |
| **Claude Code** | Native (`stream-json`) | Multi-account, Steer, Pause/Resume, Skills, Fast, Desktop/CLI continuity | `LEVER_CLAUDE_PATH` |
| **Pi** | Native RPC | Multi-account, Steer, Skills, per-run Lever tools, scoped history CLI | `LEVER_PI_PATH` |
| **Antigravity** | Local `agy` / Managed ACP | Local CLI Steer (`agy acp` 1.5.0+); managed connections negotiate independently | `LEVER_ANTIGRAVITY_PATH` |
| **DeepSeek Harness** | Built-in ACP (`dsh`) | Auto-detects CLI and macOS desktop app (`/Applications`) | `LEVER_DSH_PATH` |
| **Custom ACP** | Generic ACP v1 | Any ACP executable & args, or packaged plugin (`lever-plugin.json`) | Custom command |

> [!TIP]
> Alongside the 6 runtime plugins above, Lever ships with built-in **GitHub**, **Lark Todos**, **IMAP Mail**, and **Lark Bot** plugins—all managed under **Plugins** in the sidebar.

<details>
<summary><strong>Runtime setup tips, native app continuity & local CLI</strong></summary>

- **Multi-account setup:** Open **Settings → Runtimes → Add connection** to sign in to another Codex or Claude Code account in an isolated profile directory. Executable lookup checks `~/.local/bin` → Homebrew → `/usr/local/bin` → NVM → `PATH`, and respects `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, and `PI_CODING_AGENT_DIR`.
- **Native app continuity:** Open **Agents → Recent** to read and continue local **Codex App** or **Claude Code** sessions. For conversations started in Lever, wait for the active turn to finish before resuming in the native app.
- **Operate modules and communicate from terminals, scripts, or other Agents (JSON):**
  ```sh
  lever agent list --full
  lever providers models --provider codex
  lever chat send --agent '<agent-id>' --operation topic --text 'Summarize progress' --wait
  lever run answer --request '<request-id>' --allow=true
  lever context find --chat '<chat-id>' --query 'architecture decision'
  lever context read --target '<session-id>' # or --target main
  lever automations create --name 'Daily audit' --agent '<agent-id>' --time 09:00 --model '<model>' --permission auto_review --prompt '...'
  lever automations import-codex --dry-run
  lever work-items list && lever notes list && lever events tail --type runs
  ```

</details>

## Quick Start

**Prerequisites:** Go `1.27.3`, Node.js `24`, pnpm `11` *(repository pins `11.15.1`)*, and at least one signed-in runtime CLI.

<table>
<tr>
<td width="50%" valign="top">

**Web UI**

```sh
make build
./bin/lever
```

Open the local URL printed in the terminal (default `127.0.0.1:4778`, loopback-only with one-time pairing token).

</td>
<td width="50%" valign="top">

**Desktop App**

```sh
make desktop
./bin/desktop/Lever
```

Launches the native desktop shell over the same Go backend and SQLite store, adding the Workspace Browser and native folder pickers.

</td>
</tr>
</table>

1. **Connect a CLI:** Open **Settings → Runtimes**, enable a discovered CLI, or click **Add connection** for another account.
2. **Set up an Agent:** Use the default **Lever** Agent or create your own; choose a connection, permissions, and **Scope** directories in **Profile**.
3. **Run in parallel:** Chat continuously or branch off independent **Topics** as work splits up, with **Files**, **Diff**, **Terminal**, and **Browser** right alongside.

> [!NOTE]
> Web and Desktop share one data directory (`<user-config-dir>/Lever`, override via `--data-dir` or `LEVER_DATA_DIR`). Active runs continue in the background after closing the desktop window and survive Go backend restarts.

## Development

| Task | Command | Notes |
| :--- | :--- | :--- |
| **Apply Go changes** *(macOS)* | `./scripts/restart-backend.sh` | Rebuilds Go, restarts the backend, and reopens the desktop with hot reload |
| **Recover the desktop frontend** *(macOS)* | `./scripts/restart-frontend.sh` | Restarts Vite and reloads the open window while the backend and runs continue. Start the desktop with `./scripts/restart-backend.sh` first. |
| **Web hot reload** | `make dev` + `pnpm --dir web dev` | Install deps first (`pnpm --dir web install --frozen-lockfile`); ports `4778` / `5179` |
| **Package desktop** | `make package` | Outputs to `desktop/dist/`; add `TARGETS=darwin/arm64,windows/amd64` for Windows |
| **Regenerate types** | `make generate` | Syncs TypeScript DTOs and desktop bindings from Go |
| **Full verification** | `make test && go vet ./...` | Runs privacy check, Go `-race` tests, web build, and Playwright E2E |

<details>
<summary><strong>Benchmarks, privacy check & live runtime tests</strong></summary>

- **Chat switch benchmark:** `pnpm --dir web build && pnpm --dir web test:e2e chat-switch.spec.ts` (6 Chats × 52 turns; P90 budgets: Chromium 180 ms first open / 100 ms return; WebKit 200 ms / 140 ms).
- **Privacy check:** `make privacy` (or `python3 scripts/privacy_check.py --staged`). Add private terms to `.private-words.txt` (gitignored) or `${XDG_CONFIG_HOME:-~/.config}/lever/private-words.txt`.
- **Live runtime tests** *(opt-in, uses account quota)*:
  ```sh
  LEVER_LIVE_TEST=1 LEVER_LIVE_CODEX_MODEL='<model>' go test ./internal/provider -run TestLiveRuntimes/codex -v -count=1
  LEVER_LIVE_TEST=1 LEVER_LIVE_CLAUDE_MODEL='<model>' go test ./internal/provider -run TestLiveRuntimes/claude -v -count=1
  LEVER_LIVE_TEST=1 go test ./internal/provider -run TestLiveComposer -v -count=1
  ```

</details>

## Documentation & License

- [Design & Architecture *(Chinese)*](docs/design.md) — Agents, Chats, Sessions, execution lifecycle, and module boundaries
- [Plugin Specification *(Chinese)*](docs/plugins.md) — Plugin manifests (`lever-plugin.json`), providers, task/event sources, and channels
- [Multi-Device & Self-Hosted Hub Draft *(Chinese)*](docs/remote-devices.md) — Proposed architecture for remote Hosts, Hub sync, and mobile clients

Lever is licensed under the [Apache License 2.0](LICENCE).
