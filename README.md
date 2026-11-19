# MelonBuild Skill

让 AI 编程工具把 Figma 设计稿做成可直接合进项目的生产级代码：像素级还原、组件化、多个状态帧合并成同一份代码，跟随项目已有的约定。

网站：[melonbuild.com](https://www.melonbuild.com)

## 安装

需要 Node.js **22.15.0 或更高版本**。

先安装 MelonBuild CLI 并登录（skill 通过它获取设计稿数据）：

```sh
npm i -g melonbuild-cli
melonbuild login
```

再安装 skill：

```sh
npx melonbuild-skill
```

默认装到 `~/.claude/skills/melonbuild`，所有项目都能用。其他位置：

| 命令 | 安装位置 |
| --- | --- |
| `npx melonbuild-skill --project` | 当前项目的 `.claude/skills/melonbuild` |
| `npx melonbuild-skill --dir <目录>` | `<目录>/melonbuild`，用于其他支持 skills 的工具 |

再次运行同一条命令即可更新到最新版本。

## 使用

在 Claude Code 里给出 Figma 链接并说明需求，例如：

```text
按这份设计稿实现活动报名页：https://www.figma.com/design/FILEKEY/xxx?node-id=12-34
```

已有项目会跟随项目的框架、样式方案和目录约定；空目录默认使用 Vite + React + TypeScript + CSS Modules。设计稿里前后矛盾或拿不准的地方，会在动手前一次问清。

## 包含内容

- `SKILL.md`：工作方式与必须守住的底线
- `references/`：AST 结构说明、样式字段落 CSS 的规则
- `scripts/mb.mjs`：按需查询 AST 的工具，不需要额外安装依赖

## 许可

MIT
