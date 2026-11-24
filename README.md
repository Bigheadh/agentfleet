# AgentFleet

[![CI](https://github.com/Bigheadh/agentfleet/actions/workflows/ci.yml/badge.svg)](https://github.com/Bigheadh/agentfleet/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Bigheadh/agentfleet)](https://github.com/Bigheadh/agentfleet/releases/latest)
[![Docker](https://github.com/Bigheadh/agentfleet/actions/workflows/docker.yml/badge.svg)](https://github.com/Bigheadh/agentfleet/actions/workflows/docker.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

> 用手机调度多台机器上的 coding agent —— 开源、自托管、端到端加密、多 agent。  
> A self-hosted, end-to-end encrypted mobile control plane for coding agents running on your own machines.

**当前版本：v0.1.0（alpha）。** 协议与 API 仍在演进中。

AgentFleet 让你在手机上下发任务给家里、公司或云上的多台开发机。每台机器上的 agent（Codex、Gemini CLI、Claude Code 或任意 ACP agent）在独立的 `git worktree` 中工作；需要审批时手机收到推送通知，完成后直接在手机上看 diff、继续多轮追问、提交 / 推送 / 开 PR。

```text
 手机 App ──HTTPS/WSS (E2EE)──▶ Hub（自托管：调度 / 盲转发 / 推送）◀──WSS（节点主动外连）── fleetd（每台开发机）
    ▲                                        │                                               ├─ codex app-server (原生)
    └──── 推送通知（Expo / ntfy / Webhook）───┘                                               ├─ gemini --acp     (ACP)
                                                                                             ├─ claude-agent-acp (ACP)
                                                                                             └─ 任意 ACP agent   (ACP)
```

## 核心特性

- **多 agent 接入**：ACP（Agent Client Protocol）作为通用层，一个适配器覆盖所有 ACP agent；Codex 走原生 `codex app-server` 获取更深能力。已用真实 Codex、Gemini CLI、Claude Code 跑通完整链路（派发 → 审批 → diff → 提交）。
- **端到端加密（E2EE）**：App ⇄ 节点采用 `X25519 + HKDF-SHA256 + XChaCha20-Poly1305`（Noise IK 风格 `es + ss` 双向认证密钥封装 + 每任务独立 DEK），扫码校验节点公钥、支持节点强制加密与设备白名单。Hub 只做调度与盲转发，看不到提示词、输出、diff 或审批详情（[docs/e2ee.md](docs/e2ee.md)）。
- **推送通知**：审批请求、任务待审阅、任务最终失败时触发推送，点击直达对应任务。支持 **Expo 推送**、可完全自托管的 **ntfy** 与通用 **Webhook**，支持脱敏模式（E2EE 任务自动强制脱敏）（[docs/notifications.md](docs/notifications.md)）。
- **能力感知调度**：按 agent、项目、标签、能力（如 `interactiveApproval`、`multiTurn`）与 E2EE 密钥持有情况筛选节点，按负载、接入层级、偏好打分；排不上队时明确说明原因。
- **节点本地策略为最终权威**：`read / write / exec / danger` 四级风险分级，危险命令（`sudo`、`rm -rf /`、`git push --force` 等）永远不会被规则自动放行，手机端高风险审批需生物识别确认。
- **Worktree 隔离 & 自带凭据**：每个运行使用独立的 `fleet/<id>` 分支与 worktree，不污染主工作区，自动排除 `__pycache__` / `node_modules` 等缓存产物；agent 在你自己的机器上使用你自己的凭据运行，不代管、不共享任何订阅。

---

## 快速开始

### 1. 部署 Hub（推荐 Docker Compose，1 核 256MB 内存即可）

```bash
git clone https://github.com/Bigheadh/agentfleet.git && cd agentfleet
cp .env.example .env
# 局域网 / Tailscale（零成本）：在 .env 设置 AGENTFLEET_PUBLIC_URL=http://<你的IP或Tailscale主机名>:8787
docker compose up -d

# 如部署在公网 VPS 并需要自动 HTTPS（Caddy + Let's Encrypt）：
# 在 .env 设置 AGENTFLEET_DOMAIN 与 AGENTFLEET_PUBLIC_URL=https://<域名>
# docker compose --profile tls up -d
```

查看配对二维码和节点加入命令：

```bash
docker compose logs hub
# 后续随时重新生成：
docker compose exec hub agentfleet-hub pair
docker compose exec hub agentfleet-hub join-token
```

> 也提供预编译镜像 `ghcr.io/bigheadh/agentfleet-hub:latest`（`linux/amd64` / `linux/arm64`）与单文件二进制，详见 [docs/deploy.md](docs/deploy.md)。

### 2. 在开发机上安装并接入节点（`agentfleet-node`）

无需安装 Node / pnpm / Bun，一行脚本自动下载对应平台（Linux / macOS，x64 / arm64）预编译二进制并校验 SHA-256：

```bash
curl -fsSL https://raw.githubusercontent.com/Bigheadh/agentfleet/main/scripts/install.sh | sh
```

加入 Hub、登记项目、查看 E2EE 校验二维码并启动：

```bash
agentfleet-node join <HUB_URL> <JOIN_TOKEN> --name my-macbook
agentfleet-node project add web ~/code/web
agentfleet-node probe          # 检查本机已安装 / 已登录的 agent
agentfleet-node key            # 显示本节点 E2EE 公钥指纹与校验二维码
agentfleet-node start
```

### 3. 连接手机 App

- **真机构建（推荐，支持远程推送）**：使用 Expo EAS 构建自己的 Android APK / iOS 包（配置文件已就绪：[apps/mobile/eas.json](apps/mobile/eas.json)，步骤见 [docs/release.md](docs/release.md)）。
- **本地开发预览**：`pnpm install && cd apps/mobile && pnpm start`（也支持 Web 预览 `pnpm web`）。

打开 App 扫描 Hub 的配对二维码 → 到「节点」页扫码校验节点公钥（开启端到端加密）→ 新建任务即可开始远程调度。

---

## 支持的 Agent

在节点机器上按需安装（使用各自的官方登录或 API 密钥）：

| Agent | 安装命令 | 接入方式 |
|---|---|---|
| Codex | `npm i -g @openai/codex && codex login` | 原生 `codex app-server` |
| Gemini CLI | `npm i -g @google/gemini-cli` | ACP `gemini --acp` |
| Claude Code | `npm i -g @zed-industries/claude-agent-acp`（已内置 SDK CLI） | ACP `claude-agent-acp` |
| Codex（ACP 备用） | `npm i -g @zed-industries/codex-acp` | ACP `codex-acp` |
| 其他 ACP agent | 见各自文档 | 在 `node.yaml` 的 `agents:` 下添加 `acp:<名称>` |

- 节点配置示例：[examples/node.yaml](examples/node.yaml)
- 通过 OpenAI 兼容中转 / 自建网关统一驱动上述 agent：[docs/relay.md](docs/relay.md)

---

## 文档导航

| 文档 | 内容 |
|---|---|
| [docs/deploy.md](docs/deploy.md) | Docker / Docker Compose / Caddy 自动 HTTPS / Tailscale 部署与运维 |
| [docs/e2ee.md](docs/e2ee.md) | 端到端加密协议说明、节点扫码校验、强制加密与设备白名单 |
| [docs/notifications.md](docs/notifications.md) | Expo 推送、自托管 ntfy、Webhook 与脱敏配置 |
| [docs/release.md](docs/release.md) | 预编译二进制一键安装、发版流程与 Expo EAS 真机构建 |
| [docs/relay.md](docs/relay.md) | OpenAI 兼容中转 / 自建网关接入 Codex、Gemini CLI、Claude Code |
| [docs/design.md](docs/design.md) | 架构与协议设计文档 |

---

## 仓库结构与本地开发

需要 Node.js ≥ 22.13、pnpm、git（编译单文件二进制需要 Bun）。

```text
packages/proto    共享协议与 E2EE 加密原语（FleetEvent、能力模型、wire/API schema、X25519/XChaCha20）
packages/hub      Hub 服务端（HTTP + WS、SQLite 存储、调度器、配对、推送通知）
packages/fleetd   节点守护进程（ACP/Codex 适配器、本地策略、git worktree、E2EE runner）
apps/mobile       Expo（React Native）手机 App（支持 iOS / Android / Web）
deploy/           Caddy 自动 HTTPS 反代配置
scripts/          跨平台 Bun 打包脚本（build-release.sh）与一键安装脚本（install.sh）
tests/            端到端测试（含完整 E2EE 盲转发/防伪造/防重放集成测试）
docs/             设计、部署、安全与运维文档
```

```bash
pnpm install
pnpm typecheck
pnpm test                                  # 服务端 + 协议 + 端到端测试
pnpm --filter @agentfleet/mobile test      # 移动端单元测试
pnpm hub start                             # 源码启动 Hub
pnpm fleetd start                          # 源码启动节点守护进程
```

## 当前边界与路线图

- 当前定位为单 Hub、单用户自托管控制面；生产公网部署请配合 HTTPS/WSS（`--profile tls`）或 Tailscale。
- 后续计划：多机并行对比（best-of-N）、定时巡检任务（cron）、多用户与项目级权限。

## License

[Apache-2.0](LICENSE)
