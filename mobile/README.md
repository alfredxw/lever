# Lever 移动端

手机端连接已部署的 Lever Hub。管理员在「设置 → 设备」选择「控制端」并生成一次性配对码。在 App 中扫描二维码或粘贴配对链接。手机与执行机需要能访问同一个 HTTPS Hub 地址。

配对后，先在手机上打开设备目录，再到电脑「设置 → 远程与设备」启用「局域网直连」，选择这台手机并开启信任。手机把签名密钥和已配对 Host 的身份证明保存在系统安全存储中。Hub 断网后，在同一 Wi-Fi 上重开 App 也可以直连。电脑获知 Hub 撤权时会拒绝旧证明；Hub 和电脑失联期间，可在电脑上立即收回信任。

电脑可以按手机和已开放的 Agent 分别授权发消息、回答与审批、停止和接收派发。授权后，在手机上点选具体的回答或审批选项即可继续执行。仅设备对话须另外指定允许查看它的手机，内容和指令都只走 LAN。

开启「设置 → 锁屏通知」后，待回答或审批、运行失败和完成结果会触发 APNs 或 FCM 通知。点开会进入对应 Chat 或 Topic 并更新请求状态。离开局域网或漏收通知后，App 按游标向 Hub 补齐共享历史；同一条指令在切网重试后沿用原回执。Hub 可直连平台或使用发行方提供的推送中继。[Hub 推送部署](../deploy/hub/README.md#手机系统推送)

## iOS 构建

在配有 Xcode 和 iOS SDK 的 Mac 上构建。为显式应用标识符 `app.lever.mobile` 启用 Push Notifications，重新生成包含 `aps-environment` 和目标 iPhone 的描述文件，并安装对应的签名身份。Hub 的 APNs 环境应与签名一致。存在多组身份时可在 `mygo.json` 的 `ios.team` 中指定团队。

```sh
xcrun --sdk iphoneos --show-sdk-version
make mobile-ios
```

从仓库根目录运行。设备包输出到 `mobile/dist/ios-arm64/`。将描述文件包含的 iPhone 解锁并连接到 Mac，在手机上信任这台电脑并启用开发者模式。解压 IPA 后，用 `xcrun devicectl list devices` 查看设备标识，在解压目录中运行 `xcrun devicectl device install app --device DEVICE_ID "Payload/Lever.app"`。

在 Apple Silicon Mac 上测试模拟器版时，先在 Xcode 的 Components 设置中安装 iOS 模拟器运行时并启动一个 iPhone 模拟器，然后从仓库根目录运行。

```sh
make mobile-ios-simulator
xcrun simctl install booted "mobile/dist/ios-simulator/Lever.app"
xcrun simctl launch booted app.lever.mobile
```

## Android 构建

安装 JDK、Android SDK、NDK，并设置 `JAVA_HOME` 和 `ANDROID_HOME`。在仓库根目录运行 `make mobile-android`。APK 和 AAB 输出到 `mobile/dist/android/`。本地构建默认以开发密钥签名，APK 可通过 `adb install -r` 安装。Google Play 发行需要在 MyGo Android 配置中指定上传密钥。
