---
name: ui
description: 设计、实现或评审 Lever Web UI 时，用工作台的字体、间距、色彩与布局建立视觉层级，按场景复用 shadcn 组件，按需使用 Motion for React。
---

# Lever UI 设计与组件选型

先确定用户进入面板要读什么、要对哪个对象操作。比如在 Changes，diff 正文占主要空间，比较范围与统计在工具栏左侧，操作靠右。改动现有页面时，先对照用途最接近的页面和共享组件。 [界面规范](../../../AGENTS.md) · [Changes 工具栏](../../../.interface-design/system.md) · [共享 UI 组件](../../../web/src/components/ui/)

## 字体与阅读层级

Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining.

界面沿用 `--font-sans` 的 Geist Variable 和系统字体回退。按文字角色搭配字号、字重和行高，再用真实的中英文内容看断行。下表是 Lever 默认设置下的常用搭配。 [主题与排版](../../../web/src/index.css) · [Carbon 产品排版](https://carbondesignsystem.com/elements/typography/overview/)

| 文字角色 | 用法 |
| --- | --- |
| 设置分类、Profile 标题 | `--page-title-size`（默认 22 px），字重 600。设置分类标题行高 1.4。 |
| 分组标题、字段名 | 设置页两者同为 14 px，分组标题用 600，字段名用 500。 |
| 正文 | 默认 14 px、常规字重。聊天正文跟随用户的 `--chat-font-size`，消息段落沿用 1.8 行高。 |
| 按钮、侧栏标题 | `--text-control`（默认 13 px）。常规按钮字重 500，紧凑的侧栏标题用 600。 |
| 辅助说明、时间 | 通常用 12 px。多行字段说明可沿用设置页的 1.6 行高。 |

代码和命令用等宽字体。需要纵向比较数值或显示实时耗时时，在原字体上用 `tabular-nums`，使每位数字等宽。

## 间距与对齐

- 让距离表达归属。以设置页为例，字段名到说明相隔 4 px，行内独立操作相隔 8 px，设置组之间留 24 px，类别之间留 32 px。同级内容用父容器的 `gap` 统一节奏。 [设置分组与字段](../../../web/src/features/settings/SettingsControls.tsx) · [Carbon 间距示例](https://carbondesignsystem.com/elements/spacing/overview/)
- 侧栏的搜索、筛选和列表共用 `--sidebar-gutter`（12 px）。设置和 Profile 用 `--page-gutter`（16–36 px）对齐标题与面板外缘，面板内的字段名和操作再各自对齐成列。 [工作台样式](../../../web/src/index.css) · [Carbon 网格与对齐线](https://carbondesignsystem.com/elements/2x-grid/overview/)

## 色彩与表面

- 浅深主题都用中性画布承托内容。一级导航位于 `--canvas-background` 上，主内容使用 `--background`。相关设置共享一个 `panel-surface`，组内用细分隔线划行。菜单和弹窗分别复用 `floating-surface`、`dialog-surface` 的底色、圆角与阴影。 [主题与表面样式](../../../web/src/index.css)
- 正文和关键值用 `--foreground`，说明和时间用 `--muted-foreground`。同组操作中，把实心主按钮留给推进当前任务的动作。彩色用于识别状态或 Agent，例如用 `--status-attention` 点缀「等待审批」，保留可读的状态文字。
- 中性控件用 `--control-hover`、`--control-selected`、`--control-focus` 区分悬停、选中和键盘焦点。按钮沿用共享组件无外圈的焦点样式，通过底色或文字变化提示当前位置。 [Button 变体](../../../web/src/components/ui/button.tsx) · [Radix 状态色阶](https://www.radix-ui.com/colors/docs/palette-composition/understanding-the-scale)

## 布局与内容宽度

- 一级菜单下复用贯穿内容区全高、可折叠的 `SecondarySidebar`。标题、折叠入口和新增操作在栏头，搜索与筛选在下方。详情标题放在所属面板内。 [共享二级侧栏](../../../web/src/components/workbench/SecondarySidebar.tsx) · [Agents 侧栏](../../../web/src/features/agents/AgentSidebar.tsx)
- 按面板实际可用宽度重排。以「聊天字号」为例，宽栏内名称和说明在左，字号选项在右。字段组变窄时，`SettingsRow` 把整组选项移到说明下方并允许换行，保留原有字号和点击区域。 [设置页](../../../web/src/features/settings/SettingsPage.tsx) · [设置行](../../../web/src/features/settings/SettingsControls.tsx)
- 长文沿用阅读栏宽。聊天消息与输入区共用 `--chat-content-width` 和左右留白，响应用户的宽度偏好。文件和 diff 视图则把可用宽度留给代码。 [阅读偏好](../../../web/src/features/settings/Preferences.tsx) · [会话布局](../../../web/src/index.css)

## 交互与组件

按用户动作查表选型，优先复用仓库已有组件及变体。 [组件选型表](references/components.md)

- 执行操作用按钮，跳转页面用链接。选值时先区分单选和多选，少量固定选项优先用 `ToggleGroup` 直接展示，独立开关用 `Switch`。选项较多时，按是否需要搜索选择下拉列表或搜索选择器。
- 常用操作靠近作用对象。多组低频筛选可收进一个 `Popover`，触发按钮与搜索框同排，并标记已生效的筛选。弹层内用 `ToggleGroup` 展示少量固定选项。 [Plugins 总览](../../../web/src/features/plugins/PluginsPage.tsx)
- 工作区标签默认把可用宽度留给标题，选中的标签也遵循这条规则。鼠标悬停或键盘焦点进入标签时才显示关闭按钮，由当前标题让出空间，相邻标签保持原位。无悬停能力的设备在选中标签上显示关闭按钮。 [工作区标签样式](../../../web/src/index.css)
- 次要内容按需展开，需要集中处理或确认时用模态弹窗。校验错误随字段显示，阻碍继续操作的提示保留在相关区域，完成反馈可用短通知。图标按钮提供可访问名称，选择和展开状态随控件更新。

## 动效

- 用动效说明状态变化或空间关系。悬停、聚焦和选中沿用共享组件的 CSS 过渡，菜单、提示和弹窗沿用 shadcn/Radix 的开合动画。 [Button](../../../web/src/components/ui/button.tsx) · [Dialog](../../../web/src/components/ui/dialog.tsx)
- 需要对布局变化或条件内容的进出场做过渡时，使用仓库已接入的 `motion/react`。用 `layout` 处理局部布局变化，需要退场时用 `AnimatePresence` 和带稳定 `key` 的子元素。用 `initial={false}` 让首屏已有内容直接呈现。 [Composer](../../../web/src/features/chat/Composer.tsx) · [布局动画](https://motion.dev/docs/react-layout-animations) · [退场动画](https://motion.dev/docs/react-animate-presence)
- 位移与淡入淡出优先用 `transform` 和 `opacity`。控件反馈通常约 150 ms，面板开合通常约 240 ms，并沿用工作区的缓出曲线。需要改变侧栏或分栏占用的空间时，复用现有布局过渡。 [工作区 MotionConfig](../../../web/src/App.tsx) · [分栏布局](../../../web/src/components/workbench/WorkspaceLayout.tsx)
- 输入框焦点这类可连续反向的切换，从约 100 ms 的无延迟缓出开始。成对控件按实际内容高度同步展开和收起，中途反向时从当前尺寸接续。用单行和多行草稿分别快速切换，检查键盘与鼠标操作时的焦点、光标和消息区位置。 [Chat 输入框](../../../web/src/features/chat/composer.css)
- 列表和标签页排序沿用现有 `dnd-kit` 实现，由排序组件控制原元素的位移和相邻项的让位过渡。 [WorkspaceTabs](../../../web/src/components/workbench/WorkspaceTabs.tsx)
- 尊重系统「减少动态效果」设置。CSS 沿用 `prefers-reduced-motion`，自定义 Motion 过渡复用 `usePrefersReducedMotion`，在开启时直接呈现最终状态。验证快速切换和关闭动画时，界面状态、键盘焦点和操作反馈仍正确。 [全局 CSS](../../../web/src/index.css) · [系统动效偏好](../../../web/src/hooks/usePrefersReducedMotion.ts)

## 视觉复核

- 用多条真实记录沿名称列扫读。若每行最醒目的是次要操作按钮，可改用 `ghost`，让对象名称更容易辨认。
- 调整排版或布局后，在宽栏和拖窄的分栏里查看同一条长名称和两行说明。检查截断的名称能否查看全称、操作是否仍可达、换行后的控件是否紧邻对应字段。
- 调整颜色或交互状态后，在浅深主题中分别用 Tab 移动焦点，再将指针移入和移出选中项。检查当前选择和键盘焦点能否分别辨认。普通字号的正文和说明与实际底色的对比度至少为 4.5:1，选中行里的灰色小字也要检查。 [WCAG 文字对比度](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)
