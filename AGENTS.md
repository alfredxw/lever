# AGENTS.md

## 实现原则

- 优先考虑更简洁、更优雅、更长期的改动方式，避免为了快速实现埋下长期隐患。
- 避免过度设计，追求简洁内聚、长期可维护；优先复用现有组件和 package。
- Simple and correct beats complex and complete.
- Incompleteness is acceptable; incorrect core models and broken invariants are not.
- Complexity must be justified by the problem itself.
- Abstract only after the need is demonstrated.

## 跨 Provider 兼容性

- Lever 的通用操作默认覆盖所有已支持的 provider，并保持一致的用户可见语义。新增或修改通用操作时，优先复用现有 provider 适配层。
- 优先使用原生能力。缺少原生能力时，只要能保持相同的用户语义，就通过适配层实现兼容。适配层声明实际支持的能力，界面据此呈现可用操作和限制。
- 逐一核对已支持的 provider，验证操作可用和能力受限时的行为。例如，继续应接续同一轮回复并保留已生成的内容。

## 界面规范

- 设计、实现或评审 Lever UI 时，先读 [UI 组件选型 skill](.agents/skills/ui/SKILL.md)，按交互目的选择组件，优先复用仓库已有的 shadcn 组件。

- Light 和 Dark 主题均以黑白及灰阶为基础。页面背景、导航、面板、按钮、文字和边框使用主题的中性色。状态提示、Agent 头像等局部元素使用彩色点缀，帮助识别状态或区分 Agent，并在两种主题下保持清晰可辨。

- 一级菜单下的二级导航统一采用 Agents 式侧栏：从内容区域顶部贯穿到底部，可折叠；标题、折叠入口和新增等操作放在侧栏头部，搜索与筛选放在其下。不要在二级侧栏和详情内容上方再放横跨两栏的页面标题。优先复用共享侧栏组件，保持宽度、标题位置和折叠行为一致。

- 所有按钮（包括图标按钮、目录切换和其他下拉触发按钮）在 `focus` / `focus-visible` 状态下都不得显示光圈：不使用外扩的 ring、outline 或发光 box-shadow。键盘焦点通过背景或文字变化提示；优先在共享组件中统一实现，不在各业务页面重复覆盖。

- 选项少且固定的配置优先直接显示全部选项：少量互斥或多选项用 `ToggleGroup`，独立的开关用 `Switch`。选项较多、动态变化或需要搜索时，再用下拉列表或可搜索的选择器。

- 列表项和标签页的排序默认使用整项拖动，不增加独立把手。直接移动原元素，保持实色，不显示半透明副本、拖动虚影或重复的 DragOverlay；其他项平滑让位。点击与拖动通过移动阈值区分，项内操作按钮不触发拖动，取消拖动恢复原顺序。
