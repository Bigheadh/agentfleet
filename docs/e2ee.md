# 端到端加密（E2EE）

启用端到端加密后，Hub 只负责调度与盲转发密文：即使 Hub 服务器被攻破、数据库被拷贝或反向代理被监听，攻击者也**看不到也无法篡改**：

- 任务标题与提示词（`title`、`prompt`）
- 后续追问输入（`run.input`）
- Agent 的所有输出、推理过程、工具命令/输出、文件 diff 和日志（`run.event`）
- 审批请求详情（命令、路径、diff）和你的审批决定（`run.approval`）

Hub 仅能看到调度与状态机所需的最小元数据：项目名、任务状态、优先级、节点/agent 约束、事件序号与最小路由提示（如 `hint: "approval.requested"`，用于触发已隐藏详情的推送通知）。

## 加密协议（v1：`x25519-xchacha20poly1305`）

共享实现位于 [packages/proto/src/e2ee.ts](../packages/proto/src/e2ee.ts)，基于 `@noble/curves` / `@noble/ciphers` / `@noble/hashes` 纯 TypeScript 实现（Node / Bun / Web / React Native 通用）：

1. **长期身份密钥**：
   - 每个节点（`fleetd`）首次启动自动生成 X25519 密钥对，保存在 `~/.agentfleet/state/identity-<nodeId>.key`（权限 `0600`），并在 `hello` 中上报公钥。
   - 每台手机 App 自动生成 X25519 密钥对，保存在系统安全存储（Keychain / Keystore），配对时自动上报公钥。
2. **每任务独立 DEK + Noise IK 风格密钥封装**：
   - 新建任务时，手机随机生成 256-bit `taskKey`（DEK），用 XChaCha20-Poly1305 加密 `{ title, prompt }`（AAD 绑定 `task:<project>`）。
   - 对每个已校验的目标节点以及用户自己的已配对设备，分别用 **临时-静态 + 静态-静态** 双重 X25519 DH（`es + ss` -> HKDF-SHA256）封装 `taskKey`：既提供前向保密，又认证发送方身份，Hub 无法伪造任务。
   - 调度器只会把加密任务派发给 `task.e2ee.keys` 里包含其公钥的节点。
3. **双向事件 / 输入 / 审批防篡改与防重放**：
   - 节点 → 手机事件：用 `HKDF(taskKey, "run:n2c:<runId>")` 加密，AAD 绑定 `event:<runId>:<seq>`（防乱序、防跨 run 拼接）。
   - 手机 → 节点追问：用 `HKDF(taskKey, "run:c2n:<runId>")` 加密，附带随机 `msgId`，节点持久记录已见 `msgId` 防止 Hub 重放旧指令。
   - 手机 → 节点审批：AAD 与密文均绑定 `approval:<runId>:<approvalId>`，Hub 既无法伪造批准，也无法把旧批准重放到另一条高危命令上。

## 使用步骤

### 1. 手机校验节点公钥（防 Hub 中间人攻击）

在目标机器上打印节点公钥指纹与二维码：

```bash
agentfleet-node key
```

在手机 App 的「节点」页点 **扫码校验**（或核对 12 位指纹后点 **信任公钥**）。校验后，手机会把 `nodeId -> publicKey` 固定在本地；之后若节点公钥发生异常变更，App 会标红告警并拒绝向该节点加密。

### 2. 新建加密任务

手机默认开启「新建任务默认加密」（可在「设置 → 端到端加密」切换）。新建任务时会自动对当前项目的所有已校验节点加密。

### 3. （可选）节点强制加密与设备白名单

在节点上只允许来自指定手机的加密任务、彻底拒绝明文：

1. 在手机 App「设置 → 端到端加密」复制**本机公钥**。
2. 在节点上添加信任设备：

```bash
agentfleet-node trust add <手机公钥Base64>
```

3. 在 `~/.agentfleet/node.yaml` 中开启强制模式：

```yaml
e2ee:
  mode: required      # optional（默认）| required（拒绝一切明文任务/追问/审批）
  trustedDevices:
    - "<手机公钥Base64>"
```

## 推送通知与 E2EE

对于端到端加密任务，Hub 在发送推送通知时会自动强制启用脱敏（`redact = true`）：通知正文只显示「有一个操作等待你审批」「任务已完成，等待审阅」「任务失败」，不包含任何任务标题或命令内容。
