import SwiftUI

struct SettingsView: View {
    @Bindable var store: LeverStore
    @State private var confirmUnpair = false
    @State private var pairAnother = false
    @State private var unpairTarget: String?

    var body: some View {
        NavigationStack {
            List {
                // Notification Policy (including Desktop-Active Silence toggle!)
                Section {
                    if !store.isDirectMode {
                        Toggle(isOn: Binding(
                            get: { store.pushSettings.enabled || store.coreStatus.pushEnabled == true },
                            set: { enabled in
                                Task { await store.setPushEnabled(enabled) }
                            }
                        )) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("锁屏与后台通知")
                                    .font(.system(size: 15, weight: .medium))
                                    .foregroundStyle(LeverTheme.inkPrimary)
                                Text("待审批、运行完成或异常时发送 APNs 推送")
                                    .font(.system(size: 12))
                                    .foregroundStyle(LeverTheme.inkTertiary)
                            }
                        }
                        .tint(LeverTheme.switchTint)
                        .disabled(!store.pushSettings.available && store.coreStatus.pushEnabled != true)
                    } else {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("锁屏与后台通知")
                                    .font(.system(size: 15, weight: .medium))
                                    .foregroundStyle(LeverTheme.inkPrimary)
                                Text("锁屏系统推送需要连接 Lever Hub")
                                    .font(.system(size: 12))
                                    .foregroundStyle(LeverTheme.inkTertiary)
                            }
                            Spacer()
                            Text("仅 Hub")
                                .font(.system(size: 12.5))
                                .foregroundStyle(LeverTheme.inkTertiary)
                        }
                    }

                    Toggle(isOn: Binding(
                        get: { store.silenceWhenDesktopActive },
                        set: { enabled in
                            Haptics.light()
                            Task { await store.setSilenceWhenDesktopActive(enabled) }
                        }
                    )) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("桌面端活跃时静默")
                                .font(.system(size: 15, weight: .medium))
                                .foregroundStyle(LeverTheme.inkPrimary)
                            Text("电脑端 Lever 打开且未锁屏时手机保持静音；锁屏或离开后自动恢复推送")
                                .font(.system(size: 12))
                                .foregroundStyle(LeverTheme.inkTertiary)
                        }
                    }
                    .tint(LeverTheme.switchTint)

                    HStack {
                        Text("当前桌面状态")
                            .font(.system(size: 14.5))
                            .foregroundStyle(LeverTheme.inkPrimary)
                        Spacer()
                        HStack(spacing: 6) {
                            Circle()
                                .fill(desktopPresenceDotColor)
                                .frame(width: 7, height: 7)
                            Text(desktopPresenceText)
                                .font(.system(size: 13))
                                .foregroundStyle(LeverTheme.inkSecondary)
                        }
                    }
                } header: {
                    Text("通知策略")
                } footer: {
                    Text("桌面端每 20 秒上报窗口打开与系统锁屏状态。静默期间手机仍会实时同步未读数与已读游标。")
                }

                // Connected Computers
                Section("连接设备 (\(store.hostDevices.count))") {
                    if store.hostDevices.isEmpty {
                        Text("暂无在线执行机")
                            .foregroundStyle(LeverTheme.inkTertiary)
                    } else {
                        ForEach(store.hostDevices) { host in
                            HStack(spacing: 10) {
                                Image(systemName: host.platform == "darwin" ? "laptopcomputer" : "desktopcomputer")
                                    .font(.system(size: 17))
                                    .foregroundStyle(LeverTheme.inkPrimary)
                                    .frame(width: 26)

                                VStack(alignment: .leading, spacing: 2) {
                                    Text(host.name)
                                        .font(.system(size: 15, weight: .medium))
                                        .foregroundStyle(LeverTheme.inkPrimary)
                                    Text(hostSubtitle(host))
                                        .font(.system(size: 12))
                                        .foregroundStyle(LeverTheme.inkTertiary)
                                }

                                Spacer()

                                HStack(spacing: 5) {
                                    Circle()
                                        .fill(host.online ? LeverTheme.runningEmerald : LeverTheme.inkTertiary)
                                        .frame(width: 7, height: 7)
                                    Text(host.online ? "在线" : "离线")
                                        .font(.system(size: 12.5))
                                        .foregroundStyle(host.online ? LeverTheme.runningEmerald : LeverTheme.inkTertiary)
                                }
                            }
                            .padding(.vertical, 2)
                            .swipeActions {
                                if store.coreStatus.directPeerIds?.contains(host.id) == true {
                                    Button("解除直连", role: .destructive) {
                                        unpairTarget = host.id
                                        confirmUnpair = true
                                    }
                                }
                            }
                        }
                    }

                    HStack {
                        Text("连接通道")
                            .foregroundStyle(LeverTheme.inkPrimary)
                        Spacer()
                        Text(store.isDirectMode ? "局域网直连" : "Lever Hub + LAN")
                            .font(.system(size: 14))
                            .foregroundStyle(LeverTheme.inkSecondary)
                    }

                    if let origin = store.coreStatus.origin, !origin.isEmpty {
                        HStack {
                            Text("Hub 地址")
                                .foregroundStyle(LeverTheme.inkPrimary)
                            Spacer()
                            Text(origin)
                                .font(.system(size: 13, design: .monospaced))
                                .foregroundStyle(LeverTheme.inkSecondary)
                                .lineLimit(1)
                        }
                    }

                    HStack {
                        Text("状态同步")
                            .foregroundStyle(LeverTheme.inkPrimary)
                        Spacer()
                        Text(syncTimeText)
                            .font(.system(size: 13.5))
                            .foregroundStyle(LeverTheme.runningEmerald)
                    }
                }

                // Appearance & Defaults
                Section("外观与偏好") {
                    Picker(selection: $store.themePreference) {
                        ForEach(AppThemePreference.allCases) { pref in
                            Text(pref.label).tag(pref)
                        }
                    } label: {
                        Text("外观模式")
                            .foregroundStyle(LeverTheme.inkPrimary)
                    }

                    HStack {
                        Text("发送默认模式")
                            .foregroundStyle(LeverTheme.inkPrimary)
                        Spacer()
                        Text("话题（对齐桌面）")
                            .font(.system(size: 14))
                            .foregroundStyle(LeverTheme.inkSecondary)
                    }

                    Toggle("首页默认展开话题", isOn: $store.homeTopicsExpanded)
                        .tint(LeverTheme.switchTint)
                }

                Section {
                    Button {
                        Task { await store.refreshAll(silent: false) }
                    } label: {
                        HStack {
                            Label("立即同步对话、已读与清理状态", systemImage: "arrow.clockwise")
                                .foregroundStyle(LeverTheme.inkPrimary)
                            Spacer()
                            if store.isSyncing {
                                ProgressView().scaleEffect(0.78)
                            }
                        }
                    }

                    Button {
                        pairAnother = true
                    } label: {
                        Label("配对另一台设备", systemImage: "qrcode.viewfinder")
                    }

                    Button(role: .destructive) {
                        confirmUnpair = true
                    } label: {
                        Label("解除当前设备配对", systemImage: "link.badge.plus")
                    }
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(LeverTheme.canvas)
            .navigationTitle("设置")
            .task {
                if !store.isDirectMode {
                    await store.refreshPushSettings()
                }
            }
            .sheet(isPresented: $pairAnother) {
                PairingView(store: store)
            }
            .alert("解除设备配对？", isPresented: $confirmUnpair) {
                Button("取消", role: .cancel) { unpairTarget = nil }
                Button("解除配对", role: .destructive) {
                    let id = unpairTarget
                    unpairTarget = nil
                    Task { await store.unpair(peer: id) }
                }
            } message: {
                Text("将移除当前连接。其他独立配对的电脑仍可使用。")
            }
        }
    }

    private var desktopPresenceDotColor: Color {
        if store.anyDesktopActive { return LeverTheme.runningEmerald }
        if store.hostDevices.contains(where: \.online) { return LeverTheme.approvalAmberDot }
        return LeverTheme.inkTertiary
    }

    private var desktopPresenceText: String {
        if store.anyDesktopActive {
            return store.silenceWhenDesktopActive ? "桌面活跃中（已静默）" : "桌面活跃中"
        }
        if store.hostDevices.contains(where: \.online) {
            return "锁屏或后台（推送就绪）"
        }
        return "离线"
    }

    private func hostSubtitle(_ host: DeviceInfo) -> String {
        let presence: String
        if !host.online {
            presence = "离线"
        } else if host.isDesktopActive {
            presence = "桌面打开活跃"
        } else {
            presence = "后台或已锁屏"
        }
        return "\(host.platform) · \(presence)"
    }

    private var syncTimeText: String {
        guard let ts = store.lastSyncAt else { return "等待同步" }
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        return "已同步 \(f.string(from: ts))"
    }
}
