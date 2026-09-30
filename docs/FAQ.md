# 常见问题（FAQ）

## 安装

**Q：`dsh` 命令不存在怎么办？**
用 GUI：侧边栏 **插件 → 安装组合包**，填 `github:mmctbqj-collab/distillation-plugin`
（或 `.tgz` 路径 / 本地绝对路径）。两种入口走的是同一套 profile 逻辑。

**Q：装完侧边栏没有「蒸馏」？**
先**刷新页面**（客户端半边是热加载的）。仍没有就看 **设置 → 插件** 的列表里
`dsh-distillation` 是否 enabled、有没有报错。

**Q：`distill_*` 工具调不到？**
宿主半边未加载 → **重启 DSH**。宿主模块世代在进程内被缓存，替换/首次加载宿主代码需要重启；
客户端只需刷新。装好后可用 `distill_doctor` 确认。

**Q：页面显示「宿主半边尚未响应」？**
同上，宿主路由未注册。页面会同时给出**不需要重启**的 CLI 命令。

**Q：安装被拒，提示 peerDependencies 不兼容？**
说明该包声明的运行时范围不含你当前的 DSH 版本。换用声明兼容的版本；
**不建议**使用"版本豁免"强行安装（可能崩溃或丢数据）。

---

## 环境依赖

**Q：必须装 uv 吗？**
不必须。只有 `cangjie`（Compile Bundle）需要 uv + Python。其余能力
（`docs` / `source` / `git` / `comfy` / `skill` / `evolve` / `route` / `list` / `engines` / `doctor`）都能用。

**Q：已装 uv，但 `doctor` 说"不在当前 PATH"？**
这是**预期**的：DSH 进程的 PATH 是启动时捕获的，装完 uv 后没重启。两种处理：
重启 DSH；或在插件配置里显式指定：

```yaml
- id: distillation
  name: dsh-distillation
  config:
    cangjieUv: 'C:\Users\you\.local\bin\uv.exe'
```

**Q：需要单独装 Python 吗？**
不需要。uv 会自己准备 Python（实测 3.14.7）并用 `--with pyyaml` 提供 PyYAML。

**Q：需要 node 吗？**
DSH Desktop 自带 Node；CLI 用同一个运行时。`doctor` 会检查 Node ≥ 22。

---

## 抓取

**Q：为什么某个文档站只抓到几百字？**
那类站点（VitePress / Next.js / Docusaurus）**正文是客户端渲染的**，静态 HTML 里几乎没有文字。
先看它有没有 `llms.txt`：

```bash
node <CLI> docs https://站点 --list
```

`docs` 会优先取 `.md` 镜像，零 HTML 损失。实测 `docs.comfy.org` 首页 566 KB HTML 里 385 KB 是
script、69 KB 是 `<nav>`，一个内容页 627 KB HTML 只有 13 个 `<p>` —— 抓 HTML 本来就没东西可抓。

**Q：会不会抓爆我的网络 / 打扰目标站？**
- URL 源默认**只抓你点名的那一页**（`--follow` 才扩展，默认 0，硬上限 5）
- `docs` 只抓索引里被 `--filter`+`--limit` 选中的页
- 传输失败按指数退避重试，**404 一次都不重试**
- 单文件大小受 `maxSourceBytes` 限制（默认 4 MB）

**Q：能抓需要登录的页面吗？**
不能。本插件不做认证、不带 cookie。

---

## Skill 与技能根

**Q：生成的技能放在哪？**
`--target user` → `$DSH_HOME/skills`；`--target project` → `<cwd>/.dsh/skills`。
两者的优先级见 [SOP.md](./SOP.md) 的技能根表。

**Q：为什么我 `~/.claude/skills` 里的技能 DSH 看不到？**
**DSH 不读那个目录**（这是上游引擎文档里最普遍的假设错误）。用
`engines export --target user` 把内置引擎落到 DSH 技能根，或把技能放进
`.dsh/skills` / `$DSH_HOME/skills`。

**Q：`skill("xxx") not found`？**
① 用 `distill_list` 确认它在某个技能根；② 检查 `name` 是否满足
`^[a-z0-9]+(?:-[a-z0-9]+)*$`（非法名会被加载器**静默忽略**）；③ 检查 frontmatter 是否有
非空 `description`。

**Q：技能名为什么不是我给的中文标题？**
DSH 的技能 id 只允许 ASCII kebab。`docs --per-page` 因此从 **URL 路径**推导 id
（丢掉语言前缀、去扩展名），并保证唯一。

**Q：本插件会不会覆盖我手写的技能？**
不会：`cangjie` 安装默认**拒绝覆盖**同名；`docs --per-page` 遇到已存在的同名目录会自动加 `-2`。

---

## 进化（evolve）

**Q：为什么进化必须在一个 git 仓库里？**
因为评估回合要能**回滚**。不在仓库里时插件会明确报错，并且**不做任何修改**（不留半成品）。
确实想就地初始化：`--git-init`。

**Q：`evolve` 会替我改写 SKILL.md 吗？**
不会。它只做确定性的事：备份、把材料落 `references/`、维护标记块、建分支、出评估工单。
**语义改写与评分交 Agent 按 `darwin-skill` 执行**。

**Q：`--finalize --decision revert` 会删除我的改动吗？**
不会。它只写 `result.json` 并把 `git revert --no-edit HEAD` **打印出来**给你执行 ——
插件不会替代你重写历史，也不会用 `git reset --hard`。

**Q：`test-prompts.json` 骨架里的占位文字是什么？**
是提醒你**必须先改写成真实用例**。机器的猜测不能当评测集，未改写的骨架会让评分不可信。

---

## 页面与 hub

**Q：页面上的产出列表是实时的吗？**
是。页面读宿主的只读路由 `GET /dsh-distillation/status`，点「刷新」重新取。
但列表**只含本插件产出过的技能**（有 `.distillation.json` 侧车的那些）；手写技能不在此列。

**Q：`dsh-skill-hub` 是必需的吗？**
不是，只是可选的"全量技能总入口"（浏览/启停/市场/新建）。本插件页面只列自己的产出，两者互补。
安装：`dsh plugin --profile desktop add dsh-skill-hub@0.3.18`
（**必须 0.3.17+**，更早版本的对等依赖不含 DSH 0.2.x）。

**Q：能关掉内置引擎根吗？**
可以，插件配置里 `config.bundledEngines: false`，让你自己安装的引擎副本优先。

---

## 隐私

**Q：数据会上传吗？**
不会。所有抓取、解析、落盘都在本机。只有你主动给出的 URL 会被访问。
