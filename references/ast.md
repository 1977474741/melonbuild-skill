# AST 结构

`node-ast` 输出紧凑 JSON：`{name, fileKey, connectors?, nodes, templates, globalStyles}`。所有查询都通过 `mb.mjs` 完成，本文只说明它输出的东西是什么意思。

## 节点

`{tag, id?, name?, text?, children?, ...属性}`。`tag` 是 Figma 类型，全大写：

| tag | 含义 / 落点 |
|---|---|
| FRAME / GROUP / INSTANCE / COMPONENT | 容器 |
| SECTION | 画板。大画板的子节点是一个个相互独立的界面；屏幕大小的 SECTION 本身就是一屏，子节点是这一屏的部件（导航栏、列表、tab 栏） |
| TEXT | 文本，内容在 `text` |
| RECTANGLE / ELLIPSE / LINE | 用 CSS 画的形状或装饰层 |
| IMAGE-SVG | 整张导出的图片叶子，用 `<img src>`；纯矢量是 SVG，含照片的整组（照片 + 蒙版 + 遮罩）是 PNG。它不带 fills、strokes、effects、opacity、圆角；不要给它额外套包裹层，但 AST 里本来就有的外层盒子要保留。`mb assets` 标为 `shape-*` 的纯色形状改用 CSS 实现 |
| IMAGE-BG | 旋转、裁切或模糊过的背景图：外层容器 absolute + `pointer-events:none`，内部的 `<img>` 子节点承载 src，其 layout 字段原样照抄 |
| MASK | 少见。蒙版组要么整组导出成一张图，要么改写成容器上的裁剪（见下方「蒙版」）；残留的 MASK 是裁剪原语（`path` 用于 clip-path），不是图片 |

**节点上的内联属性**（实例级）：`width`、`height`、`borderRadius`、`inset`、`locationRelativeToParent{x,y}`（absolute 定位的 left/top）、`opacity`、`rotate`、`matrix`、`strokeFit`、`scrollTop`/`scrollLeft`、`src`、`canvasXY`（画布坐标，只用于排布画板）。

**`opacity:0` 的节点**是占位盒子（常叫 Spacing），要保留，不要改写成 margin。

**五类样式引用**：`layout`、`fills`、`fontStyle`、`strokes`、`effects` 的值是 `globalStyles` 里的 key。`mb show` 会在输出末尾的 `styles:` 段列出解析好的值（`extends` 已合并）。

## 模板（`--reuse components`）

- 实例：`{t:"C2", id?, args?, children?}`。`children` 只会是插槽 `{tag:"slotN", children}`。
- 模板：`templates.C2 = {body, params?, variants?, uses}`。
  - body 里的 `{"$param":"text1"}` 是占位符，`mb show` 里显示为 `{text1}`。
  - 展开顺序：取 `params` 默认值 → 用 `variants[args.variant]` 覆盖 → 用实例 `args` 覆盖。值为 `null` 表示该属性不存在。
  - 参数名按类型编号（`text1`、`src1`、`width1`、`pos1`、`fills1`、`layout1`…），没有业务含义，封装时要按内容重新起名。
  - 多个属性一起变化时会收成一个 variant，通常对应组件状态（选中、禁用、成功、失败）。
  - `slotN` 是插槽位置，实例传入的节点就是该容器的子节点。
- 前缀：`Cn` 是组件候选；`Sn` 超过 50 个节点，是屏幕或区块外壳；`Tn` 少于 3 个节点，是压缩片段。`uses` 是展开后在全稿出现的次数。
- 同一模板的不同实例只在 `args` 上有差异，没有其他覆写通道。
- 节点 `id` 只在根、分组层、单元、连线端点上出现，其他节点用 `mb` 的路径寻址：`<id>/<子序号>/…`。

## 蒙版

只由画图图层（照片、蒙版、遮罩色块、装饰矢量）组成的蒙版组，整组导出成一张图（`IMAGE-SVG`，含照片时 `src` 是 PNG）。组里还有文字或独立组件时才拆开：被蒙版裁剪的图层是容器的子节点，裁剪写在容器上：`overflow:hidden` + `borderRadius`，或 layout 的 `clipPath`（照写成 `clip-path`），或节点上的 `maskFills`（引用 fill 样式，落成 `mask-image/size/position/repeat`）。子节点照常还原，照片仍是独立图片。

## 连线 `connectors`

`{id, label, from, to, fromRaw?, fromName?, toRaw?, toName?, fromUnresolved?, arrow?}`：设计师画的交互流程线，**不参与渲染和布局**。

- `label` 是触发条件（如「点击提交」）。
- `from` 或 `to` 里带 `/` 时，表示端点在模板实例里，从外到内逐层定位。
- 有 `fromName` 时，说明端点被上溯到了某个祖先节点，要按 `fromName` 判断意图（例如 `fromName="按钮 Button"` 指的是那个按钮，不是整个容器）。

## 画板与注释

- SECTION 里与界面并列的 TEXT 节点通常是设计师注释（`mb outline` 列在 `notes:` 里），描述交互、边界情况和动效，要当作需求实现。
- 只有还原整张画板时才用 `canvasXY` 做 absolute 排布；生成产品代码时，每个界面独立成为页面或组件。
