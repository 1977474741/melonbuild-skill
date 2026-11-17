---
name: melonbuild
description: 把 Figma 设计稿变成可直接合进项目的生产级代码：组件化、状态合并、真实交互、语义化、像素级还原，同时尽量少耗 token、尽量快。用户给出 Figma 链接要转代码/生码/还原页面/实现设计稿，或要基于设计稿开发功能、拆组件、分析页面结构与交互流程时使用。依赖 melonbuild CLI（获取 AST）和本 skill 自带的 scripts/mb.mjs（按需查询 AST）。
---

# MelonBuild：Figma → 生产级代码

产出是**能合进项目、能维护的代码**，不是截图式的静态页：一个界面一份代码，多个状态帧合并成 props/state，重复结构抽成组件，交互能用，视觉与设计稿一致。

`MB` 指本 skill 目录下的 `scripts/mb.mjs`（`node <skill目录>/scripts/mb.mjs`）。

## 硬规则

1. **不读 AST 原文件。** AST 动辄几百 KB，一律通过 `MB` 查询：先 `outline`，再按需 `show` / `diff`。
2. **每个任务只取一次数**，产物落在 `.melonbuild/` 下。已有就复用；用户说设计改了才加 `--force-refresh`。
3. **每个模板只读一次**，读完写成组件；页面里的模板引用保持折叠，状态之间只看 `diff`。要一起看的东西一次读完：`show` 可以接多个目标，`--expand` 会把子组件内联展开，不要一个个分开调用。
4. **AST 写了什么就还原什么，没写的不补**（圆角、阴影、object-fit 等）。字段怎么落 CSS 见 [references/fidelity.md](references/fidelity.md)；第一次写样式前读一遍。
5. **代码由你逐个组件判断后手写。** 脚本只用来取数、查询、核对，不用脚本批量生成页面代码。
6. **跟随项目。** 框架、样式方案、组件库、目录结构、命名、lint 规则都以项目现状为准；项目没有的依赖不擅自引入。

## 工作流

### 1. 准备（并行做）

- CLI：`melonbuild --version`；没装就 `npm i -g melonbuild-cli`。
- 登录：`melonbuild whoami --json`。退出码 2 表示未登录，请用户自己运行 `melonbuild login`（要在浏览器里确认），不要替用户操作。
- 读项目，最多 5 次读取：`package.json`、样式方案（Tailwind / CSS Modules / styled / Less…）、组件库、已有的 token 或主题文件、组件和资源目录约定。
- 空目录：先搭好项目骨架，默认 Vite + React + TypeScript + CSS Modules。安装依赖放到后台，和取数、规划同时进行，不要干等。

### 2. 取数（先只拿结构）

```bash
melonbuild node-ast "<Figma链接>" --reuse components -q -o .melonbuild/<模块名>.remote.json
```

`<模块名>` 用英文短横线形式的功能名（如 `dating`）。这一步不下载图片，AST 里是图片的远程链接，等第 3 步确定实现范围后再下载。

- `--reuse components` 最贴近真实组件：`Cn` 是组件候选，`Sn` 是屏幕外壳，参数、变体、插槽都已抽好。
- 多页、整个画板时拉**一次全量**，不要逐页拉：跨页复用的组件只有在同一份 AST 里才能识别出来。
- 照片需要更高清时加 `--image-scale 2`。
- 退出码：3 表示额度或体积超限，告诉用户原因和订阅链接；429 限流时把 CLI 给出的原因原样转告用户。
- 建议把 `.melonbuild/` 加进 `.gitignore`。

### 3. 规划（只用 outline 和 tokens，先不 show）

```bash
node MB outline .melonbuild/<模块名>.remote.json   # 分区、状态组与基准帧、同名组件、宿主外观、组件排行、连线、注释
node MB tokens  .melonbuild/<模块名>.remote.json   # 颜色 / 字体 / 圆角 / 间距 / 阴影，开头会提示倍率
```

outline 先把这些归纳好了，用它来规划：

| outline 里的 | 意思 | 怎么用 |
|---|---|---|
| `REGION <名称>` / `[<行标题>]` | 画布上的分区（大背景圈出的范围）和其中的一排屏幕 | 只实现正式分区里的屏幕 |
| `REGION ⚠ 不在任何分区里` | 旧稿、备选方案、附件 | 默认不实现，在汇报里列出 |
| `state groups` 的 `base=` | 同一界面的不同状态，以及写代码时的基准帧 | 先 show 基准帧，再处理其它帧 |
| `diff 对比:` / `单独 show:` | 和基准结构相近 / 差异大 | 前者 `diff <base> <id>`，后者单独 `show` |
| `same name, drawn differently` | 同一个组件被画成了好几版 | 每一版都用 `diff <base> <other>` 看差异，决定做成 variant 还是忽略，忽略的在汇报里说明 |
| `host chrome` | 状态栏、小程序胶囊等运行环境外观 | 不写进页面组件（需要时放在预览外壳里） |
| `notes (requirements)` | 设计师写的需求注释 | 当作需求实现 |
| `small parts` 里的规则说明帧（如「8个字以上 小字号」） | 逻辑规格 | 落成代码里的规则，不是独立组件 |

在回复里用几行写出规划（页面与路由、每组状态由什么驱动、组件清单与命名、token、尺寸策略），然后直接开工，不用等确认。

- **组件**：按 outline 的组件排行给 `Cn` 起语义化名称；`same skeleton` 里的几个模板合并成一个组件加 variant；能用项目已有组件或组件库的直接用。
- **token**：用到两次及以上的值进 token，只出现一次的直接写字面值；按 tokens 开头的提示换算倍率。
- **尺寸策略**：页面宽度和页面这一级的文档流，见 fidelity.md 的「生产化调整」。

**下载图片**：范围一定就下，之后所有 `show` / `diff` 都在本地 AST 上做，图片显示为文件名，可以直接 import。

```bash
node MB subset .melonbuild/<模块名>.remote.json <要实现的单元id…> -o .melonbuild/<模块名>.scope.json
melonbuild download-images .melonbuild/<模块名>.scope.json -q \
  --image-dir <项目资源目录>/<模块名> --output .melonbuild/<模块名>.json
```

- 图片按 Figma 图层命名，内容相同的只存一份。`show` 只显示文件名，文件都在 `--image-dir` 目录里；写 import 时用项目别名或相对组件文件的路径（如 `@/assets/dating/icon-定位-3637b8db.svg`）。
- 退出码 4 表示部分图片失败，按提示重跑 `download-images` 补下载，不会重新生成。

### 4. 实现（自底向上）

1. **token**：写进项目已有的主题或变量文件，没有就新建 CSS 变量文件。
2. **组件**：`node MB show <ast> C16 --expand` 一次看到组件和它内部的子组件；几个相关组件用 `node MB show <ast> C2 C3 C9` 一起读，样式块只输出一次。写组件时，props 来自 `params`，按内容起名，不用 `text1` 这类名字；`variants` 对应 variant 或布尔 props；`slotN` 对应 children 或具名插槽。
3. **页面**：先选一个最完整的状态作为基准，`node MB show <ast> <单元id> --depth 4` 浏览，`node MB show <ast> <路径>` 下钻局部；同组的其他状态用 `node MB diff <ast> <基准> <状态>` 只看差异，不要整屏重读。
4. **交互**：连线、注释、状态差异落成事件、状态和路由（见下文）。
5. 写完一个文件就继续下一个，不回读刚写的文件。

### 5. 验证

- 运行项目自己的 typecheck / lint / build，修到全部通过。
- `node MB check <ast> src --unit <单元id>`：检查文案和图片是否都已落进代码。缺失项逐条判断：拼接出来的文案（`292人已报名`）、CSS 截断的文案都属于正常情况。
- `node MB prune .melonbuild/<模块名>.json src --apply`：删掉资源目录里代码没引用的图片（没实现的状态）。
- 有浏览器工具时，起 dev server，每个界面和主要状态各截一张图，和设计意图对照粗看布局；有明显错位就修，不要反复截图微调像素。

## 状态合并（核心）

设计稿习惯把一个界面画成多帧：默认、hover、选中、展开、空态、加载、报错、弹窗、步骤 1/2/3。**它们是同一份代码的不同状态，不能生成多个页面。**

**识别信号**：
- outline 里的 `≈gN` 分组（同前缀的帧名、结构相似、同一个 `Sn` 外壳）和 `~` 相似提示；
- 帧名带 hover、选中、空、骨架、loading、加载中、失败、到底、刷新、展开、step；
- 连线（`点击X → 某帧`）；
- 设计师注释（outline 的 `notes (requirements):`，如「hover 时…」「点击后…」）。注释就是需求，要实现。

**预览**：所有状态都要能在浏览器里看到，但不能做成多个页面。做法是让 mock 数据层根据 URL 参数返回对应场景（如 `?mock=empty`），页面代码本身不知道自己处在预览中。

**diff 结果的翻译**：

| diff 结果 | 落成什么 |
|---|---|
| `+` / `-` 子树 | 条件渲染：`open && <Dropdown/>`、`status==='empty' ? <Empty/> : <List/>` |
| `~ fills` / `strokes` / `fontStyle` | 状态驱动的样式：hover、focus、active 用 CSS 伪类，选中、禁用用 class 或 data 属性加 props |
| `~ text` / `src` | 数据：props、接口字段或 mock 数据 |
| `~ args variant=` | 组件的 variant prop |
| 尺寸 / 位置变化 | 由内容撑开的布局，或展开收起的动画 |

**状态分类**：

- 交互态（hover、pressed、focus）用纯 CSS，不用 JS。
- UI 态（开合、选中、tab、步骤）用组件 state 或受控 props。
- 数据态（loading、empty、error、success）用 `status` 联合类型。骨架屏只用于首屏；切换 tab 或筛选、下拉刷新、翻页只替换受影响的区域，已经显示的导航和筛选不退回骨架。
- 列表、计数、文案来自数据。

## 组件封装

- `Cn` 是组件，`Sn` 是页面或区块外壳（布局组件），`Tn` 只是压缩片段，展开写即可。
- 同一模板的多个实例渲染成数组 `.map`，数据放进类型化的 mock 文件（如 `xxx.mock.ts`）。Lorem 文案保留在 mock 里，不硬编码进组件。
- 图层名能看出组件库的组件（Button、Select、Input、Checkbox、Tabs、Modal、Tooltip、Table、PopConfirm 等），而项目又在用这个库时：直接用库组件，只在视觉与 AST 不一致的地方通过主题或 token 覆盖，不要手搓一个外观相同的假组件。项目没有组件库时，用原生语义元素实现。
- 组件只接收业务语义的 props（`title`、`unreadCount`、`selected`），不暴露 Figma 的结构参数。

## 语义与可访问性

- 可点击的元素用 `button`，跳转用 `a` 或路由 Link；输入框配 `label`；列表用 `ul`/`li`；导航用 `nav`；表格用 `table`；标题层级按字号层级用 `h1`–`h4`。
- 只有图标的按钮要加 `aria-label`（取 tooltip 文案或图层名）；装饰图片写 `alt=""`，内容图片写有意义的 alt。
- 弹层要有 `role="dialog"`、Esc 关闭、焦点管理（组件库自带的话用组件库的）。
- 布局结构以 AST 为准；没有任何样式的纯包裹层可以去掉，但承载 layout、fills、strokes、effects 的节点必须保留。

## 交互

- 连线 `from --label--> to`：label 是触发条件，`to` 是目标。目标是另一屏时落成路由跳转，是同屏的状态时落成 state 切换。
- 表单控件写成受控组件，带基础校验状态；按钮要有 disabled 和 loading 态（设计稿有的话）。
- 滚动容器（`overflow: auto`）、粘性头部、固定底栏照 AST 实现。
- 动效只在注释或状态差异里有依据时才加，时长 150–250ms。

## 大稿提速

界面超过 5 个时：先完成 token 和共享组件，再按界面分批实现。环境支持子 agent 时，可以把每个界面交给一个子 agent 并行写，交接内容包括 AST 路径、单元 id 和状态组、已有组件清单及其 props、token 文件路径、`MB` 用法和本 skill 的硬规则。

## 参考

- [references/ast.md](references/ast.md)：AST 结构、模板与参数、连线、SECTION、MASK。读不懂 `show` 的输出时看。
- [references/fidelity.md](references/fidelity.md)：五类样式逐字段落 CSS 的规则和常见陷阱。写样式前读。
