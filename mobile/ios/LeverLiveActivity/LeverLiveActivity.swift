import ActivityKit
import SwiftUI
import WidgetKit

@main
struct LeverLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: LeverActivityAttributes.self) { context in
            HStack {
                symbol(context.state)
                VStack(alignment: .leading) {
                    Text(context.attributes.isTopic ? "Lever · 话题" : "Lever · 对话").font(.caption)
                    Text(context.state.label).font(.headline)
                }
                Spacer()
                VStack(alignment: .trailing) {
                    Text("\(context.state.stepCount) 步")
                    if !context.state.ended { Text(context.attributes.started, style: .timer).font(.caption) }
                }.monospacedDigit()
            }.padding().widgetURL(context.attributes.destination)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) { Label("Lever", systemImage: "terminal") }
                DynamicIslandExpandedRegion(.trailing) { Text("\(context.state.stepCount) 步").monospacedDigit() }
                DynamicIslandExpandedRegion(.bottom) {
                    HStack {
                        symbol(context.state)
                        Text(context.state.label)
                        Spacer()
                        if context.state.phase == .waitingUser { Text("点击处理").foregroundStyle(.orange) }
                        else if !context.state.ended { Text(context.attributes.started, style: .timer).monospacedDigit() }
                    }
                }
            } compactLeading: { symbol(context.state) } compactTrailing: {
                Text(context.state.phase == .waitingUser ? "待处理" : "\(context.state.stepCount)").monospacedDigit()
            } minimal: { symbol(context.state) }
            .widgetURL(context.attributes.destination)
        }
    }

    private func symbol(_ state: LeverActivityAttributes.ContentState) -> some View {
        let name = switch state.phase {
        case .running: "play.circle.fill"
        case .waitingUser: "exclamationmark.circle.fill"
        case .completed: "checkmark.circle.fill"
        case .failed: "stop.circle.fill"
        }
        return Image(systemName: name).foregroundStyle(state.phase == .waitingUser ? .orange : state.phase == .running ? .green : .secondary)
    }
}
