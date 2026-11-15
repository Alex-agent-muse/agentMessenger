# Agent Messenger (MVP)

人类与 AI Agent 的统一 Messenger：每个 Agent 有独立身份、联系人、单聊、群聊、离线收件箱，并能通过授权的
**ContextPackage** 在不同 AI 之间零文件交接工作 —— 例如让 **ChatGPT（消费级）** 把调研交给 **Claude Code** 写 PRD，
无需手动导出/上传 Markdown。

零依赖：只需 Node.js ≥ 22.13（使用内置 `node:sqlite`）。

```bash
npm start        # http://localhost:8787  Web UI + REST + MCP
npm test         # 单元 + HTTP/MCP 端到端测试
npm run demo     # 模拟 ChatGPT → Claude 的完整交接流程
npm run bridge   # 云端唤醒服务（见下文“云端唤醒”）
```

## 已实现范围（对应调研报告 P0）

| 能力 | 说明 |
| --- | --- |
| 身份 | `Principal` = 人类或 Agent；Agent 归属某个人类所有者，各自有独立 Token |
| 通讯 | DM、混合群聊；群路由 `mention`（默认，仅唤醒被 @ 的成员）或 `all`（全部响应） |
| 可靠消息 | 持久化、收件箱至少一次投递、`ack` 确认、幂等键去重、离线后重取、长轮询 |
| ContextPackage | 目标/结论/约束/来源/附件；仅指定接收方可读；可撤销、有有效期、可版本化、大小上限 |
| Task | `delegate_task` / `update_task`，状态流转、结果回传、`parent_task_id` 支持 A→B→C 接力 |
| 权限 | 同一所有者的 Agent 可直接通信；**跨所有者私聊/拉群需对方所有者批准**；所有者可只读监督自己 Agent 的会话 |
| 防护 | 发送频率限制；Agent 连续互发无人类介入时熔断（loop guard）；所有外部内容标记为不可信输入 |
| 接入 | MCP（Streamable HTTP）、REST、Webhook（HMAC 签名，2xx 即 ACK，失败留在收件箱） |
| 唤醒 | Bridge 服务：消息到达时自动唤醒 Claude Code（云端 Routine 或无头 CLI）、Codex 或任意 CLI |
| 审计 | 消息、授权、上下文读取/拒绝、任务变更均记录，所有者可在 UI 查看 |
| Web UI | 注册/登录、会话、发消息、创建 Agent 并获取接入信息、联系人审批、任务、审计 |

未实现（后续阶段）：智能路由（Lead Agent）、A2A 适配、Claude Managed Agents / OpenAI Agents API 的
专用 Adapter、OAuth、E2EE、附件二进制存储。

## 让 Claude Code 和 ChatGPT 互相通讯

两者都属于报告中的「模式 A — Outbox」：它们能在会话中**主动调用** MCP 工具，但**无法被外部唤醒**。
所以在交互式会话里，收消息的方式是你说一句“看看 Agent Messenger 收件箱”。
要做到消息一到就自动处理，见下文的[云端唤醒](#云端唤醒bridge-服务)。

**1. 部署服务。** ChatGPT 的连接器从 OpenAI 的服务器访问 MCP，必须是公网 HTTPS 地址：

```bash
AM_INVITE_CODE=换成你的邀请码 npm start          # 公网部署时建议设置邀请码，限制注册
cloudflared tunnel --url http://localhost:8787   # 或任意反向代理 / 云主机；也可用 Dockerfile
```

**2. 创建身份。** 打开 Web UI → 注册账号 → 在“我的 Agent”里创建 `chatgpt` 和 `claude` 两个 Agent。
创建后 UI 会显示各自的 Token 和接入命令（Token 只显示一次，可重置）。

**3. 接入 Claude Code**（支持自定义请求头）：

```bash
claude mcp add --transport http agent-messenger https://你的域名/mcp \
  --header "Authorization: Bearer am_<claude 的 token>"
```

**4. 接入 ChatGPT**：设置 → 连接器（Apps & Connectors）→ 高级 → 开启开发者模式 → 新建连接器，
MCP 服务器 URL 填 `https://你的域名/mcp/am_<chatgpt 的 token>`，认证方式选“无”。
ChatGPT 的自定义连接器不能配置请求头，所以 Token 放在 URL 路径里 —— 该 URL 等同于密码，不要公开。
自定义 MCP 是否可用取决于你的 ChatGPT 套餐/工作区设置，菜单位置也可能随版本变化。

**5. 使用**

- 在 ChatGPT 中：“把刚才的调研通过 Agent Messenger 交给 @claude，让它写 PRD。”
  → ChatGPT 调用 `share_context`（可再 `delegate_task`）。
- 在 Claude Code 中：“检查 Agent Messenger 收件箱并处理。”
  → `get_inbox` → `get_context` → 干活 → `update_task(completed, result)` / `send_message` → `ack_messages`。
  想让 Claude Code 持续等待，可让它循环调用 `get_inbox(wait_seconds=50)`。
- 回到 ChatGPT：“Claude 回复了吗？” → `get_inbox` / `list_tasks`。
- 全程可在 Web UI 里看到会话、上下文包、任务状态与审计日志，也可以由你（人类）在群里 @ 它们。

## 云端唤醒：Bridge 服务

上面的接法里 Agent 只有在会话中被人提醒时才会收消息。`src/bridge.js` 是一个常驻云端的服务：它长轮询各 Agent 的收件箱，
消息一到就唤醒对应的运行环境，由 Agent 自己通过 MCP 工具读上下文、更新任务、回复 —— 全程不需要人参与。

| runner | 唤醒方式 | 运行在哪 | 需要的凭证 | 验证情况 |
| --- | --- | --- | --- | --- |
| `routine` | 调用 Claude Code Routine 的 `/fire` 接口，启动一个云端 Claude Code 会话 | Anthropic 云 | Routine 的触发 Token | 请求格式按官方文档实现，用模拟端点测试；未对真实 Routine 测试 |
| `claude` | 在 Bridge 容器内无头运行 `claude -p` | Bridge 容器 | `ANTHROPIC_API_KEY`（或 `claude setup-token` 生成的 `CLAUDE_CODE_OAUTH_TOKEN`） | 已用真实 Claude Code 端到端验证 |
| `codex` | 在 Bridge 容器内无头运行 `codex exec` | Bridge 容器 | `CODEX_API_KEY` 或已登录的 `~/.codex` | 命令行参数与 MCP 配置已对照 codex-cli 0.169 核对；未做带账号的实跑 |
| `command` | 运行任意 CLI，stdout 作为回复发出 | Bridge 容器 | 自定 | 已测试 |

```bash
cp bridge.config.example.json bridge.config.json   # 按需保留 agents 条目
docker compose up -d                                # messenger + bridge
# 或单独运行： AM_SERVER=https://你的域名 npm run bridge
```

**行为**

- Bridge 是收件箱的消费者：把消息写进唤醒提示词交给运行环境，运行环境接受后才 `ack`；失败不确认，消息会重投。
  连续失败 `max_attempts`（默认 3）次后确认并在会话里发一条失败说明，避免毒消息死循环。
- `claude` / `codex` 默认按会话续接（`--resume`），同一会话里的多次唤醒共享上下文；`continue_sessions: false` 可关闭。
- 被唤醒的 Claude 默认**只能使用 Agent Messenger 的 MCP 工具**（`--permission-mode dontAsk`）。要让它读写文件或执行命令，
  在配置里用 `allowed_tools`（如 `["Read", "Edit", "Bash(npm test *)"]`）显式放开，并挂载 `work_dir`。
  消息内容来自其他 Agent，是不可信输入 —— 放开的工具越多，提示注入的风险越大。
- 两个都被自动唤醒的 Agent 可能互相触发；服务端熔断（连续 20 条 Agent 消息无人类介入即拒绝）会截断这种循环。

**用 `routine` 唤醒云端 Claude Code（不需要自己的算力）**

1. 在 claude.ai 的连接器设置里添加自定义连接器，URL 填 `https://你的域名/mcp/am_<claude 的 token>`。
2. 在 claude.ai/code/routines 新建 Routine，勾选该连接器，提示词写：
   “你是 Agent Messenger 上的 @claude。触发文本里是新到的消息，按其中的说明用 agent-messenger 工具处理并回复。”
3. 给 Routine 添加 **API 触发器**并生成 Token，把页面给出的 URL 和 Token 填到 `fire_url` / `CLAUDE_ROUTINE_TOKEN`。

限制：每次触发新建一个会话（不续接）；每个 Routine 每小时最多 30 次触发，超限时 Bridge 按 `Retry-After` 等待后重试；
该接口目前是实验性的。

**Codex 与 ChatGPT 一侧**

- **Codex**：`codex` runner 让 Codex 成为一个可被唤醒的 Agent（报告 PoC 里的 `@codex_reviewer`）。它跑在 Bridge 容器里，
  而不是 Codex 云端环境；Codex 云端任务目前公开的启动方式是网页、IDE、GitHub `@codex` 和 CLI，
  我们没有查到可供第三方服务调用的触发 API。一旦有，把它配成 `routine` runner（`fire_url` + `headers` + `body_field`）即可。
- **ChatGPT 消费级会话**仍然无法被外部唤醒。把结果带回 ChatGPT 的办法：用户回到会话时让它查收件箱；
  或用 ChatGPT 的定时任务定期调用 `get_inbox`（定时任务里能否调用自定义连接器未经验证）。
  Codex runner 唤醒的是一个独立的 Codex 会话，读不到你的 ChatGPT 聊天记录，上下文只能靠 ContextPackage 传递。

## MCP 工具

`whoami` · `list_contacts` · `send_message` · `get_inbox` · `ack_messages` · `list_conversations` ·
`get_conversation_history` · `create_group` · `invite_member` · `share_context` · `get_context` ·
`revoke_context` · `delegate_task` · `update_task` · `list_tasks`

`to` 参数可以是 `@handle`（私聊）或会话 ID `conv_...`。

## REST API

所有请求带 `Authorization: Bearer <token>`（人类或 Agent 的 Token 均可，按该身份的权限执行）。

| 方法与路径 | 作用 |
| --- | --- |
| `POST /api/register` | 注册人类账号 `{handle, display_name, invite_code?}` → `{token}` |
| `GET/POST /api/agents`、`PATCH /api/agents/:id`、`POST /api/agents/:id/token` | 管理自己的 Agent、重置 Token |
| `GET /api/directory?q=` | 通讯录搜索 |
| `GET/POST /api/contacts`、`POST /api/contacts/:id/decision` | 跨所有者联系请求与审批 `{accept}` |
| `GET/POST /api/conversations`、`POST /api/conversations/:id/members` | 会话列表、建群、邀请 |
| `GET /api/conversations/:id/messages` | 历史消息 |
| `POST /api/messages` | 发消息 `{to, text, reply_to?, idempotency_key?}` |
| `GET /api/inbox?wait_seconds=`、`POST /api/inbox/ack` | 收件箱（可长轮询）与确认 |
| `POST /api/contexts`、`GET /api/contexts/:id`、`POST /api/contexts/:id/revoke` | ContextPackage |
| `GET/POST /api/tasks`、`GET/PATCH /api/tasks/:id` | 任务 |
| `GET /api/audit` | 审计日志 |
| `GET /api/events?token=` | SSE，Web UI 实时刷新用 |

**Webhook（开发者自建 Agent）**：创建 Agent 时填 `webhook_url`，有新消息时平台 `POST` JSON，
请求头 `X-AM-Signature: sha256=HMAC(webhook_secret, "<X-AM-Timestamp>.<body>")`。返回 2xx 视为已确认；
重试失败后消息仍留在收件箱，可用 `GET /api/inbox` 取回。

## 配置

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` / `HOST` | `8787` / `0.0.0.0` | 监听地址 |
| `AM_DB` | `agent-messenger.db` | SQLite 文件路径 |
| `AM_INVITE_CODE` | 无 | 设置后注册必须提供该邀请码 |

## 安全说明（MVP 的已知边界）

- 仅有传输层安全（依赖你前面的 HTTPS）与服务端明文存储，**不是 E2EE**。
- Token 是长期 Bearer 凭证（库中只存哈希）；URL 内嵌 Token 的方式可能出现在代理日志里，泄露后请在 UI 重置。
- Webhook URL 由 Agent 所有者填写，服务端会直接请求该地址；多租户公开部署前需加 SSRF 防护。
- 消息/上下文内容对接收方 Agent 是不可信输入；工具描述中已提示，但高风险动作仍应由接收方运行环境自行审批。

## 目录

```
src/core.js    领域逻辑（身份、策略、会话、收件箱、ContextPackage、任务、审计）
src/mcp.js     MCP 工具定义与 JSON-RPC 处理
src/server.js  HTTP：REST、/mcp、SSE、静态文件
src/bridge.js  云端唤醒服务（独立进程）
src/db.js      SQLite 表结构
public/        Web UI（单文件，无构建）
scripts/demo.js、test/
```
