# 使用 OpenAI 兼容中转 / 自建网关

AgentFleet 不代管任何凭据：每个 agent 都在节点本机读取自己的配置和环境变量。下面以一个同时提供
OpenAI（`/v1/responses`、`/v1/chat/completions`）、Anthropic（`/v1/messages`）和 Gemini
（`/v1beta/models/*:generateContent`）协议的中转为例，三个 agent 统一用 GPT 模型（`gpt-6.2-sol`）。

> 把密钥放在节点的环境里（例如 `~/.secrets/llm.env`，权限 600），**不要**写进 `node.yaml` 或提交到仓库。

```bash
# ~/.secrets/llm.env
export AF_LLM_KEY=sk-...
export AF_LLM_BASE=https://relay.example.com/v1
```

## Codex（原生 app-server）

`~/.codex/config.toml`：

```toml
model = "gpt-6.2-sol"
model_provider = "relay"

[model_providers.relay]
name = "relay"
base_url = "https://relay.example.com/v1"
env_key = "AF_LLM_KEY"
wire_api = "responses"
```

使用自定义 provider 时 `codex login status` 会显示 “Not logged in”，fleetd 会识别这种情况，不会把 Codex 当成未登录排除掉。
Linux 上请安装 `bubblewrap`（`apt install bubblewrap`），否则 Codex 的沙箱会失效（fleetd probe 会提示）。

## Gemini CLI（ACP）

```bash
export GEMINI_API_KEY=$AF_LLM_KEY
export GOOGLE_GEMINI_BASE_URL=${AF_LLM_BASE%/v1}   # 不带 /v1
export GEMINI_MODEL=gpt-6.2-sol
```

## Claude Code（ACP，经 claude-agent-acp）

```bash
export ANTHROPIC_BASE_URL=${AF_LLM_BASE%/v1}        # 不带 /v1
export ANTHROPIC_API_KEY=$AF_LLM_KEY
M=gpt-6.2-sol
export ANTHROPIC_MODEL=$M ANTHROPIC_DEFAULT_SONNET_MODEL=$M ANTHROPIC_DEFAULT_OPUS_MODEL=$M \
       ANTHROPIC_DEFAULT_HAIKU_MODEL=$M ANTHROPIC_SMALL_FAST_MODEL=$M
```

claude-agent-acp 只认 Anthropic 官方的模型别名（default / sonnet / opus / haiku），网关模型必须通过
`ANTHROPIC_DEFAULT_*_MODEL` 映射，否则会报 `unknown provider for model claude-sonnet-…`。

## 启动

```bash
. ~/.secrets/llm.env   # 加上面三段 export
agentfleet-node probe
agentfleet-node start
```

## 排障

- **会话或回合一直没有输出**：先用 curl 直接请求中转。Claude Code 遇到 429 会静默退避重试，看起来像“卡住”。
  `session/new` 超过 `AGENTFLEET_ACP_SESSION_TIMEOUT_MS`（默认 120000）会直接失败，不会无限等待。
- 把 fleetd 的日志级别调到 debug 可以看到 agent 的 stderr；包含 `ERROR` / `FATAL` / `panic` 的行会以 warn 级别显示。
- Claude 走网关模型时可能出现 `Error handling notification { method: 'session/update', code: -32602 }`：网关模型没有价格信息，
  claude-agent-acp 发出的 `usage_update.cost` 不符合 ACP schema，该条通知被丢弃（只影响 token 用量显示，不影响任务）。
