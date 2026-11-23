# AgentFleet

> 用手机调度多台机器上的 coding agent —— 开源、自托管、多 agent。
> A self-hosted mobile control plane for coding agents running on your own machines.

**状态：M1 原型（alpha）。** 协议与 API 可能变化。

AgentFleet 让你在手机上下发任务给家里/公司/云上的多台机器，机器上的 agent（Codex、Gemini CLI、Claude Code、任何 ACP agent）在独立的 git worktree 中工作；需要审批时手机收到请求，完成后在手机上看 diff、继续对话、提交 / 推送 / 开 PR。

```
 手机 App ──HTTPS/WS──▶ Hub（自托管，调度+存储） ◀──WS（节点主动外连）── fleetd（每台机器）
                                                                        ├─ codex app-server   (L1 原生)
                                                                        ├─ gemini --acp       (L2 ACP)
                                                                        ├─ claude-agent-acp   (L2 ACP)
                                                                        └─ 任意 ACP agent     (L2 ACP)
```

- **多 agent**：ACP（Agent Client Protocol）作为通用接入层，一个适配器覆盖所有 ACP agent；Codex 走原生 `app-server` 协议获取更深的能力。新增 ACP agent 只需在配置里加一行。
- **能力感知调度**：按 agent / 项目 / 标签 / 能力（如 `interactiveApproval`、`fork`）筛选节点，再按负载、接入层级、偏好打分；排不上队时告诉你原因。
- **节点本地策略是最终权威**：`read/write/exec/danger` 四级风险，规则可自动允许/拒绝，危险命令（`sudo`、`rm -rf /`、`git push --force`…）永远不会被自动放行。手机只会看到需要人工决定的请求。
- **隔离**：每个运行一个 `fleet/<id>` 分支 + worktree，主工作区不受影响。
- **自带凭据**：agent 在你自己的机器上用你自己的登录态运行，AgentFleet 不代理、不共享任何订阅。

## 快速开始

需要 Node.js ≥ 22.13、pnpm、git。

```bash
git clone <this repo> agentfleet && cd agentfleet
pnpm install

# 1) 启动 hub（任意一台手机能访问到的机器；首次启动会打印配对二维码）
pnpm hub start --public-url http://<hub-ip>:8787

# 2) 手机配对：用 App 扫码（或手动输入 Hub 地址 + 配对码）
pnpm hub pair            # 需要时重新生成配对码

# 3) 每台要干活的机器：加入 hub、登记项目、启动守护进程
pnpm hub join-token      # 在 hub 上生成 join token（也可以在 App 的「节点」页生成）
pnpm fleetd join http://<hub-ip>:8787 <JOIN_TOKEN> --name my-macbook
pnpm fleetd project add web ~/code/web
pnpm fleetd probe        # 查看本机已安装 / 已登录的 agent
pnpm fleetd start
```

然后在手机上：新建任务 → 选项目和 agent（或「自动」）→ 等待审批 / 查看实时输出 → 查看 diff → 提交 / 推送 / 开 PR，或继续追问。

安装 agent（任选，需在节点上自行登录）：

| agent | 安装 | 接入 |
|---|---|---|
| Codex | `npm i -g @openai/codex && codex login` | 原生 `codex app-server` |
| Gemini CLI | `npm i -g @google/gemini-cli` | ACP `gemini --acp` |
| Claude Code | `npm i -g @anthropic-ai/claude-code @zed-industries/claude-agent-acp` | ACP `claude-agent-acp` |
| Codex（ACP 备用） | `npm i -g @zed-industries/codex-acp` | ACP `codex-acp` |
| 其他 ACP agent | 见各自文档 | 在 `node.yaml` 的 `agents:` 下添加 `acp:<名字>` |

配置示例见 [examples/node.yaml](examples/node.yaml)；用 OpenAI 兼容中转 / 自建网关驱动三个 agent 见 [docs/relay.md](docs/relay.md)。

## 仓库结构

```
packages/proto    共享协议：FleetEvent、能力模型、hub⇄node 线协议、客户端 API（zod）
packages/hub      Hub：HTTP + WebSocket、SQLite 存储、调度器、配对 / join
packages/fleetd   节点守护进程：ACP 适配器、Codex 适配器、策略、worktree、runner
apps/mobile       Expo（React Native）手机 App
tests/            端到端测试（真实 hub + fleetd + git + mock agent 进程）
docs/design.md    设计文档
```

## 开发

```bash
pnpm typecheck
pnpm test                       # 单元 + 适配器 + 端到端（使用 mock ACP agent / mock codex app-server）
cd apps/mobile && pnpm start    # Expo 开发服务器
```

可选：用 Bun 编译单文件二进制 `pnpm --filter @agentfleet/hub build:bin`、`pnpm --filter @agentfleet/fleetd build:bin`。

## 已知限制（M1）

- **传输安全**：M1 依赖 HTTPS/WSS（请把 hub 放在 TLS 反向代理、Tailscale 或局域网后面）。端到端加密（扫码 Noise 握手，hub 只转发密文）在路线图中。
- **推送通知**：尚未实现（自托管推送网关在路线图中）；App 在前台时通过 WebSocket 实时更新。
- **真实 agent**：已用真实 Codex 0.171 / Gemini CLI 0.70 / Claude Code（claude-agent-acp 0.23）通过 OpenAI 兼容中转跑通完整链路（派发 → 手机审批 → diff → 提交）；单元测试仍使用 mock agent。
- 单 hub、单用户；尚无多用户 / 团队权限。

## License

Apache-2.0
