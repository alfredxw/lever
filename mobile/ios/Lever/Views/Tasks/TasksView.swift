import SwiftUI

struct TasksView: View {
    @Bindable var store: LeverStore

    var body: some View {
        NavigationStack {
            List {
                if store.tasks.isEmpty {
                    VStack(spacing: 10) {
                        Image(systemName: "checklist")
                            .font(.system(size: 30, weight: .light))
                            .foregroundStyle(LeverTheme.inkTertiary)
                        Text("暂无共享任务")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(LeverTheme.inkPrimary)
                        Text("在 Lever Hub 空间创建的共享任务会同步到这里")
                            .font(.system(size: 13))
                            .foregroundStyle(LeverTheme.inkTertiary)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 48)
                    .listRowBackground(Color.clear)
                } else {
                    ForEach(store.tasks) { task in
                        VStack(alignment: .leading, spacing: 5) {
                            HStack(spacing: 8) {
                                Text(task.title)
                                    .font(.system(size: 15, weight: .semibold))
                                    .foregroundStyle(LeverTheme.inkPrimary)
                                    .lineLimit(1)
                                Spacer()
                                Text(taskStatusLabel(task.status))
                                    .font(.system(size: 11, weight: .semibold))
                                    .foregroundStyle(taskStatusColor(task.status))
                                    .padding(.horizontal, 8)
                                    .padding(.vertical, 3)
                                    .background(taskStatusColor(task.status).opacity(0.12))
                                    .clipShape(Capsule())
                            }
                            if !task.body.isEmpty {
                                Text(task.body)
                                    .font(.system(size: 13))
                                    .foregroundStyle(LeverTheme.inkSecondary)
                                    .lineLimit(2)
                            }
                        }
                        .padding(.vertical, 4)
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("任务")
            .refreshable {
                await store.refreshAll(silent: false)
            }
        }
    }

    private func taskStatusLabel(_ status: String) -> String {
        switch status {
        case "todo": return "待派发"
        case "running": return "执行中"
        case "review": return "待验收"
        case "attention": return "需处理"
        case "done": return "已完成"
        case "closed": return "已关闭"
        default: return status
        }
    }

    private func taskStatusColor(_ status: String) -> Color {
        switch status {
        case "running": return LeverTheme.runningEmerald
        case "attention": return LeverTheme.approvalAmber
        case "review": return LeverTheme.syncBlue
        default: return LeverTheme.inkSecondary
        }
    }
}
