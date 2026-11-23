# 二进制发布与移动端构建指南

## 1. 一键安装预编译二进制（无需安装 Node / pnpm / Bun）

每次打版本标签（`v*`）后，GitHub Actions 会自动用 Bun 编译以下 4 个平台的单文件二进制并发布到 [GitHub Releases](https://github.com/Bigheadh/agentfleet/releases)：

- `linux-x64`、`linux-arm64`
- `darwin-arm64`（Apple Silicon）、`darwin-x64`（Intel Mac）

在开发机上安装 `agentfleet-node`（带 SHA-256 校验）：

```bash
curl -fsSL https://raw.githubusercontent.com/Bigheadh/agentfleet/main/scripts/install.sh | sh
```

其他选项：

```bash
# 只安装 hub
curl -fsSL https://raw.githubusercontent.com/Bigheadh/agentfleet/main/scripts/install.sh | sh -s -- --hub

# 同时安装 hub 和 node
curl -fsSL https://raw.githubusercontent.com/Bigheadh/agentfleet/main/scripts/install.sh | sh -s -- --all

# 指定版本或安装目录
VERSION=v0.1.0 INSTALL_DIR=/usr/local/bin sh -c "$(curl -fsSL https://raw.githubusercontent.com/Bigheadh/agentfleet/main/scripts/install.sh)"
```

## 2. 如何发布新版本

```bash
git tag v0.1.0
git push origin v0.1.0
```

推送标签后会自动触发两个工作流：
- **Release**（[.github/workflows/release.yml](../.github/workflows/release.yml)）：先跑 `pnpm typecheck && pnpm test`，通过后在 Linux / macOS 构建 8 个 `.tar.gz` 压缩包 + `SHA256SUMS.txt` 并创建 GitHub Release。
- **Docker**（[.github/workflows/docker.yml](../.github/workflows/docker.yml)）：同步推送带版本号标签的多架构镜像到 `ghcr.io/bigheadh/agentfleet-hub`。

也可以在 GitHub 仓库的 **Actions → Release → Run workflow** 手动触发干跑构建验证（不会创建 Release）。

## 3. 本地构建二进制

本机装有 [Bun](https://bun.sh) 时可直接打包任意目标平台：

```bash
VERSION=v0.1.0 bash scripts/build-release.sh linux-x64
# 产物位于 dist/release/
```

## 4. 手机 App 真机构建（Expo EAS）

由于 Android 的 Expo Go（SDK 53 起）不支持远程推送，自托管用户建议用自己的免费 Expo 账号构建独立的 APK / iOS 安装包（配置文件见 [apps/mobile/eas.json](../apps/mobile/eas.json)）：

```bash
npm i -g eas-cli
eas login

cd apps/mobile
eas init                                         # 自动写入你的 extra.eas.projectId 到 app.json

# 构建可直接安装到手机的 Android APK（推荐个人自用）
eas build --profile preview --platform android

# 如需开发调试（支持远程推送 + 热重载）
eas build --profile development --platform android

# iOS 真机构建（需要 Apple Developer 账号；或本地 Xcode `npx expo run:ios`）
eas build --profile preview --platform ios
```

> 推送通知所需的 `extra.eas.projectId` 由 `eas init` 自动配置；不依赖任何集中式官方服务器，完全归你自己所有。
