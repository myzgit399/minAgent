# minAgent 功能总结

本文按仓库当前代码整理，覆盖 minAgent 的内核能力、桌面端、xGrok 集成、模型接入、消息网关、安全机制与扩展体系。文中的命令和路径都能在代码或仓库文档里找到对应实现。

## 目录

- [1. 项目定位](#1-项目定位)
- [2. 快速开始](#2-快速开始)
- [3. 核心 Agent 能力](#3-核心-agent-能力)
- [4. 自动化与并行](#4-自动化与并行)
- [5. 桌面端](#5-桌面端)
- [6. xGrok 集成](#6-xgrok-集成)
- [7. 模型与提供商](#7-模型与提供商)
- [8. 消息网关与多端接入](#8-消息网关与多端接入)
- [9. 安全与权限](#9-安全与权限)
- [10. 扩展体系](#10-扩展体系)
- [11. 部署与更新](#11-部署与更新)
- [12. 代码结构](#12-代码结构)
- [13. 质量保障](#13-质量保障)
- [14. 当前边界](#14-当前边界)

## 1. 项目定位

minAgent 是一个本地优先的通用 Agent 平台，由三部分组成：

- **Agent 内核**：Python 3.14 实现的推理循环、工具系统、技能、记忆、网关和多平台适配。
- **桌面端**：Electron 44 + React 19 的原生应用，复用同一份配置、会话、键值和技能。
- **grok-engine**：随仓库分发的 Grok Build Rust 引擎源码（Apache-2.0），供桌面端的 xGrok 标签页使用。

内核、CLI、TUI、桌面端、浏览器工作区和消息平台共享同一套会话与配置。你可以在 CLI 里开始一段对话，在桌面端继续，在 Telegram 里收到定时任务的结果。

数据目录沿用 `HERMES_HOME`：Linux/macOS 为 `~/.hermes`，Windows 为 `%LOCALAPPDATA%\hermes`。

## 2. 快速开始

```powershell
# Windows：准备 Python 运行时、工具链和技能
.\setup-hermes.ps1

# 安装 JS 工作区依赖（仓库根目录）
pnpm install --frozen-lockfile

# 启动桌面端开发环境
cd apps/desktop
pnpm run dev
```

常用命令：

| 命令 | 作用 |
| --- | --- |
| `hermes` | 交互式 CLI |
| `hermes setup` | 完整配置向导 |
| `hermes model` | 选择提供商和模型 |
| `hermes tools` | 启用/禁用工具与工具集 |
| `hermes gateway` | 启动消息网关 |
| `hermes desktop` | 构建并启动桌面端 |
| `hermes webapp` | 在浏览器中打开桌面工作区 |
| `hermes doctor` | 环境诊断 |

源码目录里也可以直接运行 `python run_agent.py`。

## 3. 核心 Agent 能力

### 3.1 工具与工具集

工具按工具集组织，可按平台、会话或权限模式启用。内置工具集包括：

| 工具集 | 代表工具 |
| --- | --- |
| 网络 | `web_search`、`web_extract`、`x_search` |
| 文件 | `read_file`、`write_file`、`patch`、`search_files` |
| 终端 | `terminal`、`process_manage` |
| 浏览器 | `browser_exec`、`browser_cdp`、`browser_dialog`、`browser_vault` |
| 视觉与生成 | `vision_analyze`、`image_generate`、`video_generate` |
| 技能 | `skills_list`、`skill_view`、`skill_manage` |
| 记忆与检索 | `memory`、`session_search` |
| 协作 | `delegate_task`、`clarify`、`send_message` |
| 自动化 | `cronjob_manage`、`execute_code` |
| 任务板 | `kanban_create`、`kanban_complete`、`kanban_block` 等 |
| 桌面控制 | `computer_use`、`focus_pane`、`open_preview`、`read_window_below` |

工具注册表负责参数校验、结果截断与落盘、路径安全性检查、危险命令审批和工具搜索。

### 3.2 技能系统

技能是按需加载的知识文档，遵循渐进式披露，兼容 agentskills.io 开放标准。

- 内置技能覆盖 Apple 生态、创意、DevOps、邮件、媒体、笔记、生产力、研究、社交媒体、软件开发等分类。
- 可选技能包（`optional-skills/`）可按需安装。
- 技能中心支持从 GitHub、skills.sh、ClawHub 和官方目录检索与安装。
- Agent 能在完成复杂任务后自行创建技能，并在使用中修订。
- 技能可打包成技能束，用一条斜杠命令同时启用多个技能。

### 3.3 记忆与上下文

- `MEMORY.md` 与 `USER.md` 保存长期偏好、项目背景和环境知识。
- 会话库支持 FTS5 全文检索，并通过 LLM 摘要做跨会话回溯。
- 上下文文件自动发现：`.hermes.md`、`AGENTS.md`、`CLAUDE.md`、`SOUL.md`、`.cursorrules`。
- `@` 引用可把文件、目录、Git diff 和 URL 直接注入消息。
- 支持外部记忆提供方（Honcho、Mem0、Hindsight、Supermemory 等）。
- Starmap 视图把已学到的知识点画成带时间轴的星图，便于回看成长轨迹。

### 3.4 检查点与回滚

修改文件前自动生成工作区快照，出错时可用 `/rollback` 回到之前的检查点。检查点带保留策略和清理任务，避免无限增长。

## 4. 自动化与并行

- **定时任务**：自然语言或 cron 表达式创建，结果可投递到任意消息平台，支持暂停、恢复、编辑和手动触发。
- **子代理委派**：`delegate_task` 启动隔离上下文的子代理，默认并发 3 个，可单独限制工具集和终端会话。
- **代码执行**：`execute_code` 在沙箱里运行 Python 脚本，通过 RPC 调用 Agent 工具，把多步流程压缩成一轮。
- **事件钩子**：网关钩子处理日志、告警和 webhook；插件钩子可拦截工具调用、采集指标和做护栏检查。
- **目标与循环**：Goals、Loops、Heartbeat 让 Agent 能围绕长期目标反复推进，并按心跳检查外部状态。
- **批处理**：对成百上千条提示并行运行，输出 ShareGPT 格式轨迹，用于评测或训练数据生成。

## 5. 桌面端

桌面端把 Agent 的全部能力放进一个原生窗口，并额外提供工作区管理。

### 5.1 聊天与工作区

- 流式回复、实时工具活动、结构化工具摘要、思考过程展示。
- 多标签工作区：每个标签有独立的会话、模型、目录和预览。
- 右侧栏：文件树、Git 变更审阅（含 churn 图和提交栏）、终端、浏览器、文件预览、网页预览和 Artifact 预览。
- 预览面板支持网页标注、控制台输出、脚本运行和独立弹出窗口。
- 输入区支持图片粘贴、`@` 引用、斜杠命令补全、多行编辑，以及 `/queue` 队列与中途 steer。
- 支持审批卡片、会话回滚和会话导入。

### 5.2 管理界面

| 页面 | 作用 |
| --- | --- |
| Command Center | 集中管理全部会话：搜索、查看运行状态与日志、删除（带确认） |
| Capabilities | 浏览并启用技能与工具集 |
| Agents | 查看子代理树、实时进度和耗时 |
| Artifacts | 浏览生成的文件、图片和交付物 |
| Cron | 创建和管理定时任务，支持蓝图模板 |
| Profiles | 多套隔离配置，各自拥有模型、密钥、人格、主题和语言 |
| Messaging | 配置消息平台、凭据、白名单和配对 |
| Webhooks | 创建和管理入站 webhook |
| Settings | 提供商、模型、密钥、记忆、委派路由、计费、网络与隐私 |
| Session Import | 从其他 Agent 工具导入历史会话 |

### 5.3 桌面增强

- 9 种界面语言：英语、简体中文、繁体中文、日语、阿拉伯语、俄语、法语、德语、西班牙语。
- 主题与皮肤系统，支持跟随系统明暗、VS Code 配色和用户自定义主题。
- 语音输入、语音回复、唤醒词和实时语音会话。
- 宠物系统、成就系统和 HUD 浮层。
- macOS 截图快捷键：同时按左右 Command 键，把前台窗口附加到最近使用的输入框。
- 本地与远程连接：本机后端、SSH 远程、自建网关、Hermes Cloud，切换时保留前台视图和后台任务。
- 内置更新器，支持 canary 与 stable 通道。

## 6. xGrok 集成

xGrok 是 minAgent 桌面端独有的标签页，把完整的 Grok Build TUI 嵌入应用。

- 入口在侧边栏的「编程」面板，点击 `+ xGrok` 新建一个会话。
- 通过伪终端（node-pty / ConPTY）运行真正的 `grok` 可执行文件，用 xterm.js 渲染，保留完整 TUI 行为：工具调用、审批、斜杠菜单、计划模式、子代理、历史和真彩色。
- 每个标签保存自己的模型和工作目录，可多开，默认续接上一段 grok 会话；从「+ xGrok」新建时使用全新会话。
- 模型选择器直接嵌在 TUI 输入框右侧，模型列表以 minAgent 的 `config.yaml` 提供商目录为准，并自动镜像到 `~/.grok/config.toml` 的 `[model.*]` 段，保证两边可选模型一致。
- 每个模型可单独开关代理；切换模型通过 `/model` 注入正在运行的 TUI，代理路径变化时重启 PTY 并续接当前会话。
- 可执行文件按以下顺序解析：应用内置 `resources/grok/grok.exe` → 开发目录 `native/grok/grok.exe` → `~/.grok/bin/grok.exe` → PATH。
- 另有一条进程内 FFI 路径（`xai_grok_ffi.dll` + koffi），提供无界面的单轮调用；交互式标签页使用 PTY 路径。

`grok-engine/` 保存 Grok Build 的 Rust 源码，构建方式见 [grok-engine/README.md](grok-engine/README.md)：

```powershell
cargo build -p xai-grok-ffi --release
cargo build -p xai-grok-pager-bin --release
```

构建产物（`xai_grok_ffi.dll`、`grok.exe`）体积较大，已在 `.gitignore` 中排除，需要本地构建或从官方安装复制。

## 7. 模型与提供商

`config.yaml` 预置了三个国内可直连的提供商，默认使用 ModelScope：

| 提供商 | 接入点 | 密钥变量 | 默认模型 |
| --- | --- | --- | --- |
| ModelScope | `api-inference.modelscope.cn/v1` | `MODELSCOPE_KEY` | `Qwen/Qwen3.5-35B-A3B` |
| DeepSeek | `api.deepseek.com/v1` | `DEEPSEEK_API_KEY` | `deepseek-flash` |
| 阿里云百炼 | `dashscope.aliyuncs.com/compatible-mode/v1` | `ALI_KEY` | `qwen3.6-plus` |

同时支持任何 OpenAI 兼容端点、Nous Portal、OpenRouter、Anthropic、OpenAI、Gemini、xAI、本地模型（Ollama、llama.cpp、vLLM 等）。

围绕模型的能力：

- 按任务分配模型：主对话、子代理、压缩、视觉、标题生成可各用一套。
- 提供商路由：按成本、速度、质量排序，支持白名单、黑名单和优先级。
- 故障转移：主模型报错时自动切到备用提供商。
- 凭据池：同一提供商配置多个密钥，限流或失败时自动轮换。
- 提示缓存、上下文压缩和微压缩，降低长会话成本。

## 8. 消息网关与多端接入

一个网关进程同时服务 CLI、桌面端、浏览器工作区和 30 余种消息平台，包括 Telegram、Discord、Slack、WhatsApp、Signal、Matrix、飞书、钉钉、企业微信、QQ、LINE、Mattermost、Teams、邮件、SMS、IRC、ntfy、Home Assistant 等。

网关能力：

- 每个平台独立配置凭据、白名单、配对和审批策略。
- 语音消息转写、图片与文件收发、富文本卡片。
- 跨平台会话连续性：同一段对话可在不同平台继续。
- 群聊与 Bot：网关托管的群聊在桌面端关闭后继续运行，支持多机器成员、授权、停止、重试和附件。
- Webhook 入站：外部系统可触发 Agent 任务。
- API Server：以 OpenAI 兼容接口暴露 Agent，供 Open WebUI、LobeChat、LibreChat 等前端接入。
- ACP：在 VS Code、Zed、JetBrains 中直接使用，工具活动、文件 diff 和终端命令在编辑器内渲染。

## 9. 安全与权限

- **审批模式**：`approvals.mode` 支持 `smart`（默认，辅助模型判断风险）、`manual`（每次询问）和 `off`（直接执行）。
- **危险命令识别**：解析 shell 命令、管道、包装器和 Windows 特例，命中规则时强制审批；`approvals.deny` 可配置无条件拦截规则，`--yolo` 也不会绕过。
- **拒绝熔断**：同一操作被连续拒绝达到阈值后，Agent 会停止重试并要求人工处理。
- **凭证保险库**：本地加密存储，可对接 1Password、Bitwarden 或自定义命令；支持系统钥匙串。
- **网络隔离**：egress 代理与 Iron Proxy 方案，限制 Agent 的出站访问。
- **执行环境隔离**：终端后端支持 local、Docker、SSH、Modal、Daytona、Vercel Sandbox，以及插件提供的 Singularity/Apptainer。
- **工具护栏**：路径穿越防护、符号链接检查、输出截断、自仓库保护、技能凭据扫描。
- **可审计**：审批记录、工具调用日志、会话请求转储和用量统计。

## 10. 扩展体系

- **插件**：三类插件（通用工具/钩子、记忆提供方、上下文引擎），内置浏览器、计算机使用、Kanban、记忆、模型提供商、平台适配、图像/视频生成、安全指引、成就等插件。
- **插件目录**：在线浏览、安装、更新插件；桌面端插件 SDK 可注册页面、侧边栏入口、面板和命令。
- **MCP**：stdio 与 HTTP 传输，支持 OAuth、按服务器过滤工具、采样和健康检查。
- **技能中心**：从多个来源检索、安装和同步技能，带来源校验和锁文件。
- **语言包与皮肤**：界面语言、CLI 皮肤、桌面主题均可扩展。
- **钩子**：生命周期钩子与观察者钩子，可在工具执行前后介入。

## 11. 部署与更新

- **Windows 原生**：PowerShell 安装脚本，无需 WSL；也支持 WSL2。
- **macOS / Linux**：安装脚本、源码构建、DMG/zip、AppImage/deb/rpm。
- **容器**：Dockerfile 与 docker-compose，支持无头部署。
- **Nix**：flake 提供开发环境和打包。
- **Termux**：aarch64 APT 仓库。
- **浏览器工作区**：`hermes webapp` 在 `127.0.0.1:9120` 提供与桌面端同源的工作区，可加登录网关后暴露到局域网。
- **更新**：`hermes update` 更新源码托管安装；桌面端通过 electron-updater 或 MSIX 更新。

## 12. 代码结构

| 目录 | 内容 |
| --- | --- |
| `agent/` | 推理循环、工具调度、上下文与状态管理 |
| `hermes_agent/`、`hermes_platform/` | Agent 运行时与平台抽象 |
| `hermes_cli/` | CLI 子命令、安装器、更新器、诊断 |
| `gateway/`、`tui_gateway/` | 消息网关与 JSON-RPC/WebSocket 网关 |
| `acp_adapter/` | ACP 编辑器集成 |
| `tools/` | 全部工具实现（终端、浏览器、文件、记忆、委派等） |
| `skills/`、`optional-skills/` | 内置与可选技能 |
| `plugins/`、`optional-mcps/`、`plugin-catalog/` | 内置插件、MCP 预设与插件目录 |
| `ui-tui/`、`web/` | 终端 UI 与 Web 仪表盘 |
| `apps/desktop/` | Electron 桌面端（主进程、渲染进程、测试） |
| `grok-engine/` | Grok Build Rust 引擎源码 |
| `tests/`、`tests-js/`、`apps/desktop/e2e/` | Python、JS 与端到端测试 |
| `website/docs/` | 完整使用文档 |

## 13. 质量保障

```bash
just check              # 全部阻塞性检查
just check-js           # JS 工作区检查
pnpm -r check           # 各 JS 包检查
pytest                  # Python 测试
cd apps/desktop && pnpm run test        # 桌面端单元测试
cd apps/desktop && pnpm run typecheck   # 类型检查
cd apps/desktop && pnpm run lint        # ESLint
cd apps/desktop && pnpm run test:e2e    # Playwright 端到端测试
```

仓库另外带有 ruff、ESLint、Prettier、lefthook 和 CI 工作流。

## 14. 当前边界

- 品牌替换是渐进的：桌面产品名、安装包和部分文案已改为 minAgent，内部包名、CLI 名称 `hermes`、数据目录 `~/.hermes` 和文档仍沿用 Hermes。
- 大型二进制不入库：`apps/desktop/native/grok/grok.exe`、`apps/desktop/native/xgrok/xai_grok_ffi.dll` 和 koffi 需要本地构建或复制。
- `grok-engine` 构建需要系统安装 `protoc`，仓库内的 `bin/` 为空。
- xGrok 标签页只在桌面端可用，浏览器工作区会提示该功能仅限桌面端。
- 桌面端的远程模式以网关为执行边界：工具、终端和文件操作都发生在远程主机上。
