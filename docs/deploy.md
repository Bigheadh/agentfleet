# 容器化与一键部署（Hub）

AgentFleet Hub 仅负责任务调度、状态存储（SQLite）和密文转发，**资源占用极低**（1 核 / 256–512MB 内存即可稳定运行）。`fleetd` 节点守护进程直接运行在你平时写代码的 Mac / Linux / WSL 机器上，主动连向 Hub，节点不需要公网 IP。

## 方式一：局域网 / Tailscale（零成本，推荐个人自用）

在家里电脑、NAS、树莓派或任何运行 Docker 的机器上：

```bash
git clone https://github.com/Bigheadh/agentfleet.git
cd agentfleet
cp .env.example .env
# 在 .env 中设置你的局域网或 Tailscale 地址，例如：
# AGENTFLEET_PUBLIC_URL=http://100.64.0.10:8787

docker compose up -d
```

查看首次启动生成的配对二维码与节点加入命令：

```bash
docker compose logs hub
```

## 方式二：公网 VPS + Caddy 自动 HTTPS

如果你希望不装 Tailscale 也能公网直连，只需一台最基础的 VPS 和一个解析到该 VPS IP 的域名（开放 80 / 443 端口）：

```bash
git clone https://github.com/Bigheadh/agentfleet.git
cd agentfleet
cp .env.example .env
```

编辑 `.env`：

```dotenv
AGENTFLEET_DOMAIN=hub.example.com
AGENTFLEET_PUBLIC_URL=https://hub.example.com
# 只监听本机回环，对外仅由 Caddy 暴露 80/443
AGENTFLEET_BIND=127.0.0.1:8787:8787
```

一键启动（Caddy 会自动申请并续期 Let's Encrypt HTTPS 证书，原生代理 WebSocket）：

```bash
docker compose --profile tls up -d
```

## 方式三：直接跑单容器（无需克隆仓库）

镜像由 GitHub Actions 自动构建并发布到 GHCR（支持 `linux/amd64` 和 `linux/arm64`）：

```bash
docker run -d --name agentfleet-hub --restart unless-stopped \
  -p 8787:8787 \
  -v agentfleet-data:/data \
  -e AGENTFLEET_PUBLIC_URL=http://<你的IP或Tailscale主机名>:8787 \
  ghcr.io/bigheadh/agentfleet-hub:latest
```

> 如需从源码本地构建镜像而不是拉取 GHCR，运行 `docker compose up -d --build`。

## 常用运维命令

```bash
# 生成新的手机配对二维码（10 分钟有效，一次性）
docker compose exec hub agentfleet-hub pair

# 生成新的节点加入令牌（1 小时有效）
docker compose exec hub agentfleet-hub join-token

# 查看已配对设备 / 吊销设备 / 导出审计日志
docker compose exec hub agentfleet-hub devices
docker compose exec hub agentfleet-hub revoke <deviceId>
docker compose exec hub agentfleet-hub audit --limit 100 --json

# 升级到最新镜像
docker compose pull && docker compose up -d

# 备份数据库（SQLite WAL 模式下建议先停容器或用 sqlite3 .backup）
docker compose stop hub
docker run --rm -v agentfleet_hub_data:/data -v "$PWD":/backup alpine \
  cp /data/hub.db /backup/hub-backup.db
docker compose start hub
```

## 推送通知与安全选项

在 `.env` 中直接配置即可（详见 [docs/notifications.md](notifications.md) 与 [docs/e2ee.md](e2ee.md)）：

- `AGENTFLEET_NTFY_URL` / `AGENTFLEET_NTFY_TOKEN`：自托管 ntfy 推送
- `AGENTFLEET_WEBHOOK_URL`：Webhook 推送
- `AGENTFLEET_PUSH_REDACT=1`：通知正文隐藏任务详情
- `AGENTFLEET_EXPO_PUSH=0`：彻底禁用 Expo 推送通道
