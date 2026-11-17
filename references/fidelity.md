# 样式字段 → CSS

值大多已经可以直接当 CSS 用，数值保留 2 位小数。**有就照写，没有就不补**；缺字段不等于 CSS 默认值。全局使用 `box-sizing: border-box`。

## layout

| 字段 | CSS |
|---|---|
| `mode` row / column / grid / none | `display:flex` + direction / `display:grid` / 无 flex，子节点全部 absolute |
| `justifyContent` `alignItems` `alignSelf` `wrap` `padding` | 直译。flex 容器的 `alignItems` 总会给出；没给就不写，因为 CSS 默认的 stretch 不等于 Figma 的默认值 |
| `gap` | 直译；**负值**改成后续子项的负 margin（`> * + * { margin-left:-4px }`） |
| `sizing` `"水平/垂直"` | `fixed` 用节点的 width/height；`hug` 用 fit-content；`fill` 不写尺寸，由 `flexGrow`、`flexBasis`、`alignSelf` 承载 |
| `flexGrow` / `noShrink` / `flexBasis` / `minWidth` | `flex-grow:1` / `flex-shrink:0` / `flex-basis:0` / `min-width`，各写各的，**不要合并成 flex 简写**；没有 noShrink 就不写 shrink |
| `position` | `relative` 只表示它是定位上下文，节点本身仍在 flex 流里；只有 `absolute` 或父节点 `mode:none` 时才脱离文档流 |
| `locationRelativeToParent` / `inset` | `position:absolute; left; top` / `inset:0`，坐标相对父节点外边缘 |
| `margin*` | 直译。`auto` 在 layout 里；具体数值写在节点上（同坐标一样是实例级） |
| `overflow` | `hidden` 只裁剪不滚动；`x-auto` 表示 `overflow-x:auto`，另一个轴按 hidden 处理 |
| `clipPath` | 照写成 `clip-path`（来自蒙版；路径是固定 px，容器尺寸要随内容变时，能看出是圆角矩形就改用 `border-radius` + `overflow:hidden`） |
| `scrollTop` / `scrollLeft`（节点上） | 渲染后用 JS 设置初始滚动位置，不要用负 top 模拟 |
| `zIndex:-1` + 父节点 `isolation:isolate` | 背景层沉底，两个字段必须配对写 |
| `pointerEvents:none` | 装饰层不拦截点击 |
| `gridTemplate*` / `gridRow` / `gridColumn` | 直接透传 |

每个容器都要落它的 layout。漏写 `display:flex` 会让 gap 和对齐静默失效。

**生产化调整**（只改尺寸策略，不改视觉）：

- **倍率**：移动端稿屏宽 750 / 828 / 1125 是 2x / 2x / 3x 稿，所有数值（尺寸、字号、间距、圆角、描边、阴影）统一换算成 CSS px（÷2 或 ÷3）；项目有 rem / vw 适配方案时按项目方案换算。375 / 390 / 414 宽是 1x，不换算。**倍率按每一屏各自判断**，同一个文件里可能混着 1x 帧和 2x 帧。
- 页面根节点的固定宽度改为 `width:100%` + `max-width`，或跟随项目的布局容器；`fill` 的部分自然自适应；组件内部的固定尺寸保持不变。和容器同框、垫在内容下面的装饰图，AST 里已经是该容器 fills 里的 `backgroundImage`（纯矢量的 `100% 100%` 铺满，含照片的 `cover`），照写成背景即可；`100% 100%` 的图是 SVG 时，在文件的 `<svg>` 上加 `preserveAspectRatio="none"`，否则它会保持自身比例、两边留白。
- **吸顶 / 固定层要不透明**：把头部、tab 栏、底栏改成 `sticky` / `fixed` 后，列表会滚到它们下面，这是设计稿里没有的重叠。设计稿里这些层叠在页面底色上，可能只是一张半透明的渐变图或一层半透明色；改成吸顶后必须把原来垫在下面的底色一起写上（如 `background: url(头部背景.png) …, var(--页面底色)`），否则滚动内容会从透明处透出来。
- **绝对定位转文档流**：Sketch 或手摆的稿子常常整页都是 `mode:none` 加坐标。页面和列表这一级，等距排列的同类元素（卡片、列表行、tab）改成 flex 加 gap（gap 取相邻坐标差减去尺寸），顶部栏和底部栏用 sticky 或 fixed；小组件内部的元素可以保留绝对定位。判断标准是内容变长、数据条数变化时布局不能坏。

## fills

值是数组（单个元素时也可能是对象）。**index 0 在最上层**，和 CSS 多重背景顺序一致，每一层都要写。

- 颜色串逐字照抄，包括 alpha，不要凭观感改成实色。
- `{gradient}` 原样写，不要修改角度。
- `{backgroundImage, backgroundSize, backgroundPosition, backgroundRepeat}` 四个字段照抄；图片填充始终走 background，不要改成 `<img>`。如果带 `opacity`，那只是这层图片的透明度，需要单独的伪元素承载。
- 多层填充时，**颜色不能写在非最后一层**，否则整条声明失效：最底层的纯色放 `background-color`，其他层用 `linear-gradient(c,c)` 写进 `background-image`。
- TEXT 节点的颜色只取 `fontStyle.color`。

`maskFills`（节点上）：与 fills 同格式的 fill 样式引用，落成 `mask-image` / `mask-size` / `mask-position` / `mask-repeat`，作用于整个容器。

## fontStyle

`family`、`weight`、`size`、`lineHeight`、`letterSpacing`、`textCase`（text-transform）、`textAlign`、`textDecoration`、`color` 直译。

- 字体：设计稿用了项目里没有的字体（如商用付费字体）时，写 `font-family` 加上合理的回退字体，并在汇报里说明，不要擅自下载或引入字体文件。

- `textWrap`：`nowrap` → `white-space:nowrap`；`wrap` 按宽度换行；`truncate` → nowrap + hidden + ellipsis；`clamp` → `-webkit-line-clamp:maxLines` 三件套。
- 渐变文字：`backgroundClip:text` + `webkitTextFillColor:transparent` + `background` 三个一起写。
- TEXT 节点的 `layout` 同样要落，`fill` 宽度的文字负责撑满剩余空间。

## strokes

`{colors, strokeWeight, strokeAlign?, strokeDashes?}`，`strokeAlign` 省略表示 INSIDE。节点上的 `strokeFit` 指定画法：

| 情况 | 写法 |
|---|---|
| `strokeFit=border` | `border: w solid c` |
| `strokeFit=inset` | `box-shadow: inset 0 0 0 w c` |
| `strokeFit=inset-cover` | `::after` 覆盖层：`content:""; position:absolute; inset:0; border-radius:inherit; box-shadow:inset 0 0 0 w c` |
| `strokeFit=ring` 或颜色是渐变 | 环形伪元素：透明 border 宽 w，背景写渐变（`border-box`），`mask-composite:exclude`，`border-radius:inherit` |
| OUTSIDE | `box-shadow: 0 0 0 w c` |
| CENTER | `box-shadow: inset 0 0 0 w/2 c, 0 0 0 w/2 c` |
| 逐边 `"0px 0px 1px"`（上 右 下 左） | 按边各写一条：下边 `inset 0 -1px 0 0`、上边 `inset 0 1px 0 0`、左边 `inset 1px 0 0 0`、右边 `inset -1px 0 0 0` |
| 虚线 `strokeDashes` | `border: w dashed c` |

描边和 `effects.boxShadow` 都落在 box-shadow 上时，**合并成一条声明**（描边在前），否则后写的会覆盖前写的。伪元素画法的描边除外。描边线条某个轴为 0 时，那个轴是厚度轴，厚度取 strokeWeight。

**TEXT 节点上的描边**（文字描边，不是盒子描边）：`-webkit-text-stroke: <w> <c>`。OUTSIDE 描边写成 2 倍宽度，再加 `paint-order: stroke fill`，让描边只露在外侧；INSIDE 和 CENTER 直接写原宽度。

## effects

`boxShadow`、`filter`、`backdropFilter` 直译。

- 设计师用一层「错位的同文字图层」来模拟阴影（同文本、同字体，只是位置偏移，常叫「投影」）时，合并成主文字的 `text-shadow`，不要渲染成两份文字。

## 旋转与镜像

只看 `rotate`（如 `-60deg`）或 `matrix`（`a,b,c,d,0,0`，镜像时用），都是直接读取。width 和 height 是旋转前的尺寸，照写后再加 transform；不要换成外接框尺寸，没有这两个字段的节点也不要自己补角度。IMAGE-SVG 导出的图里已经包含朝向，不要再变换一次。
