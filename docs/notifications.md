# 推送通知

App 在后台时，hub 会在以下情况推送通知：

| 事件 | 标题 | 优先级 |
|---|---|---|
| agent 请求审批 | `需要审批 · <项目>` | 高（有提示音） |
| 任务完成，待审阅 | `任务待审阅 · <项目>` | 普通 |
| 任务最终失败（不再重试） | `任务失败 · <项目>` | 普通 |

点击通知会直接打开对应任务。节点离线触发的自动重排队不会推送，只有最终失败才推送。

## 通道

三个通道互不影响，可以同时开启；某个通道失败只会记一条日志，不影响 hub 本身。

### 1. Expo 推送（App 内开启，默认可用）

在 App「设置 → 推送通知」里开启。手机会把自己的 Expo push token 注册到 hub，之后 hub 通过 Expo 推送服务 → APNs / FCM 把通知发到手机。

- 自己构建 App 时需要配置 EAS projectId（`app.json` 的 `extra.eas.projectId`）。Android 上的 Expo Go 从 SDK 53 起不再支持远程推送，需要用 development build。
- 通知内容会经过 Expo 和 Apple / Google 的服务器。如果不希望任务内容出现在通知里，用 `--push-redact`（见下）。
- 想彻底关闭：`agentfleet-hub start --no-expo-push`（或设置 `AGENTFLEET_EXPO_PUSH=0`）。

### 2. ntfy（可完全自托管）

[ntfy](https://ntfy.sh) 是开源的推送服务，有 iOS / Android 客户端，可以用公共的 ntfy.sh，也可以自己部署。

```bash
agentfleet-hub start --ntfy-url https://ntfy.sh/<足够长的随机 topic>
# 自建 / 需要鉴权：
AGENTFLEET_NTFY_URL=https://ntfy.example.com/agentfleet AGENTFLEET_NTFY_TOKEN=tk_... agentfleet-hub start
```

在 ntfy App 里订阅同一个 topic 即可收到通知。点击通知会打开 `agentfleet://tasks/<id>`（需要已安装 AgentFleet App）。

> 公共 ntfy.sh 上的 topic 名就相当于密码，请使用足够长的随机字符串，或者自建 ntfy 并开启鉴权。

### 3. Webhook

```bash
agentfleet-hub start --webhook-url https://example.com/hook
```

每条通知都会以 JSON POST 发出：

```json
{
  "source": "agentfleet",
  "kind": "approval",
  "title": "需要审批 · web",
  "body": "修复登录 bug\n[exec] python3 test_calc.py",
  "data": { "kind": "approval", "taskId": "…", "runId": "…" },
  "priority": "high"
}
```

可以用它桥接到 Bark、Gotify、Slack、飞书、企业微信等。

## 隐藏详情

`--push-redact`（或设置 `AGENTFLEET_PUSH_REDACT=1`）开启后，所有通道的通知正文都只显示通用文案（如「有一个操作等待你审批」），不包含任务标题、命令或文件名；标题里仍会显示项目名。

## API

- `GET /api/me` → `push: { expoEnabled, registered, channels }`
- `POST /api/devices/me/push`，body 为 `{ "expoPushToken": "ExponentPushToken[…]" | null }`（传 `null` 表示注销）
- 通知附带的 `data` 格式为 `{ kind: "approval" | "review" | "failed", taskId, runId? }`

Expo 返回 `DeviceNotRegistered` 时，hub 会自动删除对应的 token。
