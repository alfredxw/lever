import SwiftUI

struct SettingsView: View {
    @Bindable var store: LeverStore
    @State private var confirmUnpair = false

    var body: some View {
        NavigationStack {
            List {
                Section("连接状态") {
                    HStack {
                        Label("连接方式", systemImage: store.isDirectMode ? "wifi" : "cloud")
                        Spacer()
                        Text(store.isDirectMode ? "免 Hub 局域网直连" : "Lever Hub + LAN")
                            .foregroundStyle(LeverTheme.inkSecondary)
                    }
                    if let origin = store.coreStatus.origin, !origin.isEmpty {
                        HStack {
                            Label("Hub 地址", systemImage: "link")
                            Spacer()
                            Text(origin)
                                .font(.system(size: 13, design: .monospaced))
                                .foregroundStyle(LeverTheme.inkSecondary)
                                .lineLimit(1)
                        }
                    }
                    HStack {
                        Label("已读游标同步", systemImage: "arrow.triangle.2.circlepath")
                        Spacer()
                        Text(syncTimeText)
                            .font(.system(size: 13))
                            .foregroundStyle(LeverTheme.runningEmerald)
                    }
                }

                Section("已连接电脑 (\(store.hostDevices.count))") {
                    if store.hostDevices.isEmpty {
                        Text("暂无在线执行机")
                            .foregroundStyle(LeverTheme.inkTertiary)
                    } else {
                        ForEach(store.hostDevices) { host in
                            HStack(spacing: 10) {
                                Image(systemName: host.platform == "darwin" ? "laptopcomputer" : "desktopcomputer")
                                    .font(.system(size: 17))
                                    .foregroundStyle(LeverTheme.inkPrimary)
                                    .frame(width: 28)

                                VStack(alignment: .leading, spacing: 2) {
                                    Text(host.name)
                                        .font(.system(size: 15, weight: .medium))
                                        .foregroundStyle(LeverTheme.inkPrimary)
                                    Text("v\(host.version) · \(host.platform)")
                                        .font(.system(size: 12, design: .monospaced))
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
                        }
                    }
                }

                Section("通知与外观") {
                    if !store.isDirectMode {
                        Toggle(isOn: Binding(
                            get: { store.pushSettings.enabled || store.coreStatus.pushEnabled == true },
                            set: { enabled in
                                Task { await store.setPushEnabled(enabled) }
                            }
                        )) {
                            Label("锁屏系统推送", systemImage: "bell.badge")
                        }
                        .disabled(!store.pushSettings.available && store.coreStatus.pushEnabled != true)
                    } else {
                        HStack {
                            Label("锁屏系统推送", systemImage: "bell.slash")
                            Spacer()
                            Text("仅 Hub 模式可用")
                                .font(.system(size: 13))
                                .foregroundStyle(LeverTheme.inkTertiary)
                        }
                    }

                    Picker(selection: $store.themePreference) {
                        ForEach(AppThemePreference.allCases) { pref in
                            Text(pref.label).tag(pref)
                        }
                    } label: {
                        Label("外观主题", systemImage: "circle.lefthalf.filled")
                    }
                }

                Section {
                    Button {
                        Task { await store.refreshAll(silent: false) }
                    } label: {
                        Label("立即同步全部对话与已读状态", systemImage: "arrow.clockwise")
                            .foregroundStyle(LeverTheme.inkPrimary)
                    }

                    Button(role: .destructive) {
                        confirmUnpair = true
                    } label: {
                        Label("解除当前设备配对", systemImage: "link.badge.plus")
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("设置")
            .task {
                if !store.isDirectMode {
                    await store.refreshPushSettings()
                }
            }
            .alert("解除设备配对？", isPresented: $confirmUnpair) {
                Button("取消", role: .cancel) {}
                Button("解除配对", role: .destructive) {
                    Task { await store.unpair() }
                }
            } message: {
                Text("将清除本地加密密钥与离线缓存，之后可随时重新扫码连接电脑或 Hub。")
            }
        }
    }

    private var syncTimeText: String {
        guard let ts = store.lastSyncAt else { return "等待同步" }
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        return "已同步 \(f.string(from: ts))"
    }
}
