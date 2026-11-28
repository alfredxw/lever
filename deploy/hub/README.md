# 部署 Lever Hub

下载部署包 `lever-hub-deploy-<版本>.tar.gz` 和对应架构的镜像包 `lever-hub-<版本>-linux-<架构>.tar.gz`。Intel/AMD 服务器选 `amd64`，ARM 服务器选 `arm64`。解压部署包，使用 `docker load -i` 导入下载的镜像，再在解压目录执行以下命令。

```sh
cp .env.example .env
docker compose run --rm hub setup --user admin
docker compose up -d
```

首次初始化在终端提示时输入至少 12 字节的密码。打开本机 `http://127.0.0.1:8090` 登录。反向代理向该端口转发 HTTPS、WebSocket 和 SSE，保留原始 Host 并关闭 SSE 响应缓冲。客户端使用 HTTPS 域名配对。

独立 HTTPS 部署将 `.env` 的 `LEVER_HUB_DOMAIN` 设为解析到服务器的域名，`LEVER_HUB_BIND` 设为监听网卡地址，`LEVER_HUB_PORT` 设为 443。开放公网 TCP 443 后启动 Compose。Hub 通过 TLS-ALPN-01 申请和续期证书。

在 Hub 的「设备」中为新机器签发配对码。在目标机器运行以下命令，输入一次性配对码。该示例允许个人设备使用这台机器的 Agent 工作区。

```sh
lever remote pair --hub https://hub.example.com --role workstation --code-stdin --access workspace --expose-all
lever remote status --json
```

在桌面「设置 → 远程与设备」可调整开放的 Agent、文件只读模式、允许浏览的目录和新设备确认策略。个人空间默认按目标机器配置的权限执行。选择「仅本机」后，相应 Agent 或对话仅在所属机器上显示。设备在线时可读取完整历史，离线时 Hub 提供活跃会话最近 40 轮缓存。

手机和另一台电脑可通过桌面生成的局域网配对链接独立连接。已配对的设备出现在 Agents 列表里。运行、新建和文件操作都由选中的设备处理。旧版设备及已有的逐项授权可继续使用原有的信任、收件箱和共享流程。

## 备份与恢复

```sh
docker compose exec hub /lever-hub backup -o /var/lib/lever-hub/snapshot.tar.gz
docker compose cp hub:/var/lib/lever-hub/snapshot.tar.gz ./snapshot.tar.gz
docker compose stop hub
docker compose run --rm -T hub restore - < snapshot.tar.gz
docker compose up -d
```

备份包含账号、归档和 Hub 身份密钥，应作为私密文件保存。恢复旧备份前核对恢复点以后的设备撤销记录，先隔离服务并重新撤销相关凭据，再开放网络。升级时先备份，再载入新版本镜像，修改 `.env` 的镜像标签后运行 `docker compose up -d`。重置管理员密码使用 `docker compose exec hub /lever-hub reset-password --user admin`，原浏览器会话随即失效。

## 手机系统推送

用 `LEVER_HUB_PUSH_CONFIG` 指定 JSON 文件。Compose 部署可在 `compose.override.yaml` 中将配置目录绑定到容器，并在 `.env` 中设 `LEVER_HUB_PUSH_CONFIG=/run/lever-push/config.json`。容器的 UID 65532 需要对这些文件有读取权限。

```yaml
services:
  hub:
    volumes:
      - ./push:/run/lever-push:ro
```

自行签发 App 的部署方可以配置所需平台。以下文件路径相对于配置文件。iOS 填写 App 的 bundle ID 和签名环境，取值为 `development` 或 `production`。Android 的四项客户端参数来自该包名对应的 Firebase Android App，服务账号须可向同一项目调用 FCM HTTP v1。[Apple APNs](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns) · [Firebase HTTP v1](https://firebase.google.com/docs/cloud-messaging/send/v1-api)

```json
{
  "apns": {"keyFile":"AuthKey.p8","keyId":"APPLE_KEY_ID","teamId":"APPLE_TEAM_ID","topic":"app.lever.mobile","environment":"development"},
  "fcm": {"serviceAccountFile":"service-account.json","firebase":{"projectId":"PROJECT_ID","appId":"ANDROID_APP_ID","apiKey":"ANDROID_API_KEY","senderId":"PROJECT_NUMBER"}}
}
```

使用发行方构建的 App 时，发行方可在持有上述凭据的 Hub 上额外配置 `"relayTokenFile":"tenant.key"`。租户 Hub 只需配置以下中继地址和同一个高熵访问密钥文件（例如用 `openssl rand -hex 32` 生成）。Android 客户端参数由发行方提供。仅启用 iOS 时省略 `firebase`，仅启用 Android 时省略 `ios`。

```json
{
  "relay": {"origin":"https://push.example.com","tokenFile":"tenant.key","ios":true,"firebase":{"projectId":"PROJECT_ID","appId":"ANDROID_APP_ID","apiKey":"ANDROID_API_KEY","senderId":"PROJECT_NUMBER"}}
}
```

手机在配对后可允许系统通知，也可稍后在 App 的「设置」开启。Hub 将提醒与会话更新写入同一事务，临时投递失败会重试，投递前会复核请求状态。推送服务只接触设备 token、通用提醒和加密的定位信息；聊天正文、审批命令和解密密钥保留在手机及其配对的 Hub。真机验收时，在 Wi-Fi 发消息并锁屏，切蜂窝网络，点系统通知回到原审批。再从电脑先回答一次，确认手机打开旧通知会显示已采纳的答案。

### 同机运行执行节点

先初始化 Hub 账号。新版 Linux 镜像包同时包含 Hub 和 Node，使用 `docker load` 即可导入。在源码仓库执行 `WITH_NODE=1 ./deploy/hub/build-image.sh` 可同时构建 Hub 和 Node 镜像。也可以通过 `LEVER_NODE_IMAGE` 指定已安装所需 Provider CLI 的自定义 Node 镜像。

在部署目录运行 `./install.sh --with-node`。按提示输入 Hub 签发的一次性工作机配对码，或回车稍后配对。两个服务共享网络命名空间。Hub 使用 8090，Node 的加密直连接口绑定 127.0.0.1:8091，各自使用独立数据卷。已在运行的 Hub 可以直接启用此 profile。查看路由和权限可执行 `docker compose exec node lever remote status --json`。

在独立 Linux 主机上，将 Lever 二进制安装到 `/usr/local/bin/lever`。个人账号可将 `systemd/lever-node-user.service` 复制到 `~/.config/systemd/user/` 并执行 `systemctl --user enable --now lever-node-user`。系统服务模板 `systemd/lever-node.service` 使用专用的 `lever` 账号。启动后，以同一运行账号执行 `lever remote pair --hub https://你的域名 --code-stdin --access admin --no-control --expose-all`，输入一次性配对码。使用自定义数据目录时向该命令传入同一个 `--data-dir`。
