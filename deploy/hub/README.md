# 部署 Lever Hub

部署包与同一版本的镜像一起使用。用 `docker load -i lever-hub-linux-arm64.tar.gz` 导入镜像，或在源码根目录用 `HUB_ARCH=amd64 make hub-image` 为 x86 服务器构建镜像。将服务器架构代入文件名。

```sh
cp .env.example .env
docker compose run --rm hub setup --user admin
docker compose up -d
```

首次初始化在终端提示时输入至少 12 字节的密码。打开本机 `http://127.0.0.1:8090` 登录。反向代理向该端口转发 HTTPS、WebSocket 和 SSE，保留原始 Host 并关闭 SSE 响应缓冲。客户端使用 HTTPS 域名配对。

独立 HTTPS 部署将 `.env` 的 `LEVER_HUB_DOMAIN` 设为解析到服务器的域名，`LEVER_HUB_BIND` 设为监听网卡地址，`LEVER_HUB_PORT` 设为 443。开放公网 TCP 443 后启动 Compose。Hub 通过 TLS-ALPN-01 申请和续期证书。

在「设置 → 设备」选择执行机、工作机或控制端并生成配对码。在执行机运行以下命令。Agent ID 可从本机 `lever agent list` 查看。

```sh
lever remote pair --hub https://hub.example.com --role executor --code-stdin
lever remote agents expose AGENT_ID
lever remote status
```

打开 Hub 的 Tasks 创建并派发共享任务。在目标 Host 的「设置 → 远程与设备」查看指令和确认执行，或在该机使用 `lever remote inbox`、`lever remote accept COMMAND_ID`。既有本机对话默认保留在设备。首次勾选共享后，对话正文、审批和摘要会同步到指定空间。

同一账号的个人手机可以在桌面「设置 → 远程与设备」中设为可信，并按 Agent 勾选发送、回答审批、停止或派发任务。无界面的执行机可使用以下命令。手机的设备 ID 在手机「设置」中查看。已授权的手机可在 Host 断开 Hub 时继续走局域网，撤销信任会同时移除该手机的全部操作授权。

```sh
lever remote lan --enabled
lever remote trust --controller PHONE_ID
lever remote permission --controller PHONE_ID --agent AGENT_ID --operation send --enabled
lever remote permission --controller PHONE_ID --agent AGENT_ID --operation answer --enabled
lever remote trusted
```

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
